const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sigaa-session-test-'));
process.env.SECRET = 'test-only-signing-secret';
process.env.ENC_SECRET = 'a'.repeat(32);
process.env.ENC_SECRET_USER = 'b'.repeat(32);
process.env.TOKEN_REVOCATION_DIR = directory;
delete process.env.VERCEL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
const jwt = require('jsonwebtoken');
const auth = require('../api/auth');
const logout = require('../api/logout');
const login = require('../api/login');

// Remove somente os arquivos de teste conhecidos, sem exclusão recursiva.
after(() => {
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
});

function response() {
    return {
        headers: {}, setHeader(name, value) { this.headers[name] = value; },
        status(code) { this.code = code; return this; },
        json(body) { this.body = body; return this; }, end() { return this; }
    };
}

function child(script, data) {
    const result = spawnSync(process.execPath, ['-e', script], {
        cwd: path.resolve(__dirname, '..'), env: process.env,
        input: JSON.stringify(data), encoding: 'utf8', timeout: 10000
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim();
}

test('logout revokes only the selected session and remains revoked in another process', async () => {
    const payload = { user: 'test-user', pass: 'test-password' };
    const token = auth.gerarTokenLogin(payload);
    const other = auth.gerarTokenLogin(payload);
    assert.deepEqual(payload, { user: 'test-user', pass: 'test-password' });
    assert.notEqual(jwt.decode(token).jti, jwt.decode(other).jti);
    assert.equal((await auth.validarTokenLogin(token)).user, 'test-user');
    const res = response();
    await logout({ method: 'POST', body: { token } }, res);
    assert.equal(res.code, 200);
    assert.equal(await auth.validarTokenLogin(token), null);
    assert.equal((await auth.validarTokenLogin(other)).user, 'test-user');
    const output = child(`
        const auth = require('./api/auth');
        const token = JSON.parse(require('fs').readFileSync(0, 'utf8')).token;
        auth.validarTokenLogin(token).then(value => console.log(value === null));
    `, { token });
    assert.equal(output, 'true');
    await logout({ method: 'POST', body: { token } }, res);
    assert.equal(res.code, 200);
    for (const name of fs.readdirSync(directory)) {
        assert.match(name, /^[a-f0-9]{64}-\d+\.revoked$/);
        assert.equal(fs.readFileSync(path.join(directory, name), 'utf8'), '');
    }
});

test('legacy JWT without jti is accepted before logout and rejected afterward', async () => {
    const payload = jwt.decode(auth.gerarTokenLogin({ user: 'legacy', pass: 'password' }));
    delete payload.jti;
    const token = jwt.sign(payload, process.env.SECRET);
    assert.equal((await auth.validarTokenLogin(token)).user, 'legacy');
    assert.equal(await auth.revogarTokenLogin(token), true);
    assert.equal(await auth.validarTokenLogin(token), null);
    // Assinatura equivalente com padding não deve contornar a revogação.
    const padded = `${token}=`;
    assert.equal(await auth.validarTokenLogin(padded), null);
});

test('invalid, expired and non-HS256 tokens cannot authenticate', async () => {
    assert.equal(await auth.validarTokenLogin('invalid'), null);
    assert.equal(await auth.validarTokenLogin(auth.gerarTokenLogin({ user: 'x', pass: 'y' }, -1)), null);
    assert.equal(await auth.validarTokenLogin(jwt.sign({ exp: Math.floor(Date.now() / 1000) + 60 }, process.env.SECRET, { algorithm: 'HS384' })), null);
    const res = response();
    await logout({ method: 'POST', body: { token: auth.gerarTokenLogin({ user: 'x', pass: 'y' }, -1) } }, res);
    assert.equal(res.code, 200);
    await logout({ method: 'POST', body: { token: 'invalid' } }, res);
    assert.equal(res.code, 401);
    await logout({ method: 'POST', body: { token: {} } }, res);
    assert.equal(res.code, 400);
    await logout({ method: 'GET', body: {} }, res);
    assert.equal(res.code, 405);
});

test('malformed login credentials return 400 instead of an unhandled rejection', async () => {
    const res = response();
    await login({ method: 'POST', body: { user: {}, pass: 'x' } }, res);
    assert.equal(res.code, 400);
});

test('both scraper handlers reject revoked tokens before requesting SIGAA', () => {
    child(`
        const assert = require('node:assert/strict');
        const auth = require('./api/auth');
        (async () => {
            const token = auth.gerarTokenLogin({ user: 'x', pass: 'y' });
            await auth.revogarTokenLogin(token);
            for (const name of ['./api/scraper', './api/scraper_new']) {
                const res = { setHeader(){}, status(code){this.code=code;return this;}, json(){return this;} };
                await require(name)({ method: 'POST', body: { token } }, res);
                assert.equal(res.code, 401);
            }
            process.exit(0);
        })().catch(() => process.exit(1));
    `, {});
});

test('serverless without shared storage fails closed', () => {
    child(`
        process.env.VERCEL = '1';
        const assert = require('node:assert/strict');
        const auth = require('./api/auth');
        const logout = require('./api/logout');
        (async () => {
            const token = auth.gerarTokenLogin({ user: 'x', pass: 'y' });
            await assert.rejects(auth.validarTokenLogin(token));
            const res = { setHeader(){}, status(code){this.code=code;return this;}, json(){return this;} };
            await logout({ method:'POST', body:{token} }, res);
            assert.equal(res.code,503);
        })().catch(() => process.exit(1));
    `, {});
});

test('Redis storage shares revocations, sets expiry and rejects storage outages', () => {
    child(`
        process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'test-only-redis-token';
        const assert = require('node:assert/strict');
        const data = new Map(); let outage = false;
        global.fetch = async (url, options) => {
            if (outage) throw new Error('offline');
            assert.equal(url, process.env.UPSTASH_REDIS_REST_URL);
            assert.equal(options.redirect, 'error');
            const command = JSON.parse(options.body);
            let result;
            if(command[0] === 'SET') {
                assert.equal(command[3], 'EXAT');
                assert.ok(command[4] > Date.now()/1000);
                data.set(command[1], command[2]); result = 'OK';
            } else { result = data.has(command[1]) ? 1 : 0; }
            return {ok:true,json:async()=>({result})};
        };
        const auth = require('./api/auth');
        (async()=>{
            const token = auth.gerarTokenLogin({user:'x',pass:'y'});
            assert.ok(await auth.validarTokenLogin(token));
            await auth.revogarTokenLogin(token);
            assert.equal(await auth.validarTokenLogin(token),null);
            const storePath = require.resolve('./lib/token-revocations');
            delete require.cache[storePath];
            assert.equal(await require(storePath).isRevoked(token, require('jsonwebtoken').decode(token)),true);
            outage = true;
            await assert.rejects(auth.validarTokenLogin(token));
            await assert.rejects(auth.revogarTokenLogin(token));
        })().catch(()=>process.exit(1));
    `, {});
});

test('actual Express routes revoke tokens and reject replay without contacting SIGAA', () => {
    child(`
        process.env.PORT = '0';
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
                    const post = (endpoint, body) => fetch(base + endpoint, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                    assert.equal((await post('/api/login', { user: {}, pass: 'x' })).status, 400);
                    const login = await post('/api/login', {user:'test-user',pass:'test-password'});
                    assert.equal(login.status, 200);
                    const { token } = await login.json();
                    assert.equal((await post('/api/logout', {token})).status, 200);
                    assert.equal((await post('/api/scraper', {token})).status, 401);
                    assert.equal((await post('/api/logout', {token})).status, 200);
                    const page = await fetch(base + '/');
                    if (page.status === 200) {
                        const html = await page.text();
                        assert.ok(html.includes('window.API_BASE_URL = window.location.origin;'));
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
