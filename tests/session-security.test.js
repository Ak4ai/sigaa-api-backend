const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
process.env.SECRET = 'test-only-signing-secret';
process.env.ENC_SECRET = 'a'.repeat(32);
process.env.ENC_SECRET_USER = 'b'.repeat(32);
process.env.SESSION_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sigaa-server-sessions-'));
delete process.env.VERCEL;
const auth = require('../api/auth');
function child(script, data) {
 const r=spawnSync(process.execPath,['-e',script],{cwd:path.resolve(__dirname,'..'),env:process.env,input:JSON.stringify(data),encoding:'utf8',timeout:10000});
 assert.equal(r.status,0,r.stderr || r.error?.message);return r.stdout.trim();
}
test('opaque sessions persist encrypted on the server and logout deletes only the selected session', async()=>{
 const payload={user:'sensitive-test-user',pass:'sensitive-test-password'};
 const id=auth.gerarTokenLogin(payload), other=auth.gerarTokenLogin(payload);
 assert.match(id,/^s3_[A-Za-z0-9_-]{43}$/);assert.notEqual(id,other);
 assert.deepEqual(payload,{user:'sensitive-test-user',pass:'sensitive-test-password'});
 assert.equal((await auth.validarTokenLogin(id)).pass,payload.pass);
 // Reading/closing the SQLite file in its owner process can release POSIX locks.
 // Inspect encryption from a separate process that has no database connection.
 assert.equal(child(`const fs=require('node:fs'),path=require('node:path');const secrets=JSON.parse(fs.readFileSync(0,'utf8'));const folder=process.env.SESSION_DATA_DIR;const disk=fs.readdirSync(folder).filter(n=>n.startsWith('sessions.sqlite')).map(n=>fs.readFileSync(path.join(folder,n))).reduce((a,b)=>Buffer.concat([a,b]),Buffer.alloc(0));console.log(secrets.every(s=>!disk.includes(Buffer.from(s))));`,[payload.user,payload.pass,id]),'true');
 assert.equal(child("const a=require('./api/auth');const id=JSON.parse(require('fs').readFileSync(0,'utf8')).id;a.validarTokenLogin(id).then(v=>console.log(v.user==='sensitive-test-user'));",{id}),'true');
 await auth.revogarTokenLogin(id);assert.equal(await auth.validarTokenLogin(id),null);
 assert.ok(await auth.validarTokenLogin(other));assert.equal(await auth.revogarTokenLogin(id),true);
 assert.equal(child("const a=require('./api/auth');const id=JSON.parse(require('fs').readFileSync(0,'utf8')).id;a.validarTokenLogin(id).then(v=>console.log(v===null));",{id}),'true');
});
test('expired, forged and legacy JWT sessions are rejected',async()=>{
 assert.equal(await auth.validarTokenLogin(auth.gerarTokenLogin({user:'x',pass:'y'},-1)),null);
 assert.equal(await auth.validarTokenLogin('s3_'+'a'.repeat(43)),null);
 assert.equal(await auth.validarTokenLogin(require('jsonwebtoken').sign({user:'x',pass:'y'},process.env.SECRET)),null);
 assert.equal(await auth.revogarTokenLogin('invalid'),false);
});
test('account replacement atomically erases the previous credentials',async()=>{
 const previous=auth.gerarTokenLogin({user:'a',pass:'test'});
 const next=auth.gerarTokenLogin({user:'b',pass:'test'},'7d',previous);
 assert.equal(await auth.validarTokenLogin(previous),null);assert.equal((await auth.validarTokenLogin(next)).user,'b');
});
test('tampered encrypted credentials fail closed and their session is deleted',async()=>{
 const id=auth.gerarTokenLogin({user:'tamper-test',pass:'private'});
 const {DatabaseSync}=require('node:sqlite');
 const db=new DatabaseSync(path.join(process.env.SESSION_DATA_DIR,'sessions.sqlite'));
 const key=require('node:crypto').createHash('sha256').update(id).digest('hex');
 db.prepare('UPDATE sessions SET ciphertext=? WHERE id=?').run(Buffer.alloc(80).toString('base64'),key);
 assert.equal(await auth.validarTokenLogin(id),null);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id=?').get(key).n,0);
 db.close();
});
test('serverless refuses ephemeral session storage',()=>{
 child("process.env.VERCEL='1';const a=require('./api/auth');require('node:assert/strict').throws(()=>a.gerarTokenLogin({user:'x',pass:'y'}));",{});
});
test('both scrapers reject deleted sessions without SIGAA requests',()=>{
 child(`(async()=>{const a=require('./api/auth'),assert=require('node:assert/strict');const id=a.gerarTokenLogin({user:'x',pass:'y'});await a.revogarTokenLogin(id);for(const name of ['./api/scraper','./api/scraper_new']){const r={setHeader(){},status(c){this.code=c;return this;},json(){return this;}};await require(name)({method:'POST',body:{token:id}},r);assert.equal(r.code,401);}})().catch(()=>process.exit(1));`,{});
});
test('actual Express routes revoke tokens and reject replay without contacting SIGAA', () => {
    child(`
        process.env.PORT = '0';
        require.cache[require.resolve('./lib/sigaa-login')]={exports:{verifySigaaLogin:async()=>true}};
        const assert = require('node:assert/strict');
        const cronPath = require.resolve('./api/cron-calendario');
        require.cache[cronPath] = { exports: { atualizarCalendariosBackground: async () => {} } };
        const express = require('express');
        const listen = express.application.listen;
        express.application.listen = function(...args) {
            const server = listen.apply(this, args);
            server.once('listening', async () => {
                try {
                    const base = 'http://127.0.0.1:' + server.address().port;
                    const bootstrap = await fetch(base + '/api/session');
                    const csrf = (await bootstrap.json()).csrf;
                    const cookie = bootstrap.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
                    const post = (endpoint, body) => fetch(base + endpoint, {
                        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Cookie: cookie },
                        body: JSON.stringify(body)
                    });
                    assert.equal((await post('/api/login', { user: {}, pass: 'x' })).status, 400);
                    const login = await post('/api/login', {user:'test-user',pass:'test-password'});
                    assert.equal(login.status, 200);
                    const session = await login.json();
                    assert.equal(session.token, undefined);
                    const activeCookies = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
                    const mismatch = await fetch(base + '/api/scraper', {
                        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: activeCookies, 'X-CSRF-Token': session.csrf, 'X-Profile-User': 'different-account' }, body: '{}'
                    });
                    assert.equal(mismatch.status, 409);
                    const token = login.headers.getSetCookie().find(c => c.startsWith('sigaa_session=')).split(';')[0].slice('sigaa_session='.length);
                    assert.equal((await post('/api/logout', {token})).status, 200);
                    assert.equal((await post('/api/scraper', {token})).status, 401);
                    assert.equal((await post('/api/logout', {token})).status, 200);
                    const page = await fetch(base + '/');
                    for (const hidden of ['/.git/config', '/.git/HEAD', '/.env', '/%2egit/config']) {
                        assert.ok([403, 404].includes((await fetch(base + hidden)).status));
                    }
                    if (page.status === 200) {
                        const html = await page.text();
                        assert.ok(!html.includes('<script>'));
                        assert.ok(page.headers.get('Content-Security-Policy').includes("script-src 'self'"));
                    }
                    server.closeAllConnections();
                    server.close(() => setTimeout(() => process.exit(0), 50));
                } catch(error) { console.error(error); process.exit(1); }
            });
            return server;
        };
        require('./server');
    `, {});
});
