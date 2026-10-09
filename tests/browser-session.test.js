const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.SECRET = 'cookie-test-only-secret';
process.env.ENC_SECRET = 'a'.repeat(32);
process.env.ENC_SECRET_USER = 'b'.repeat(32);
process.env.TOKEN_REVOCATION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sigaa-cookie-tests-'));
delete process.env.VERCEL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
const express = require('express');
const sessions = require('../lib/browser-session');
const auth = require('../api/auth');
const app = express();
app.use(express.json());
app.use('/api', sessions.middleware);
app.get('/api/session', sessions.sessionHandler);
app.post('/api/login', require('../api/login'));
app.post('/api/logout', require('../api/logout'));
let scrapeCalls = 0;
app.post('/api/scraper', async (req, res) => {
    const payload = await auth.validarTokenLogin(req.body.token);
    if (!payload) return res.status(401).json({ error: 'Invalid session' });
    scrapeCalls++;
    res.json({ user: payload.user });
});
test('real HTTP cookies protect login and logout from CSRF, never expose JWT, and revoke replaced sessions', async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const jar = new Map();
    let csrf;
    const request = async (endpoint, body, extra = {}) => {
        const response = await fetch(base + endpoint, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...extra },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        for (const header of response.headers.getSetCookie()) {
            const pair = header.split(';')[0], index = pair.indexOf('=');
            if (header.includes('Max-Age=0')) jar.delete(pair.slice(0, index));
            else jar.set(pair.slice(0, index), pair.slice(index + 1));
        }
        return response;
    };
    try {
        assert.equal((await request('/api/login', { user: 'a', pass: 'b' })).status, 403);
        const rejected = await request('/api/session', undefined, { Origin: 'https://attacker.example' });
        assert.equal(rejected.status, 403);
        assert.equal(rejected.headers.get('Access-Control-Allow-Origin'), null);
        const bootstrap = await request('/api/session');
        csrf = (await bootstrap.json()).csrf;
        assert.equal((await request('/api/login', { user: 'a', pass: 'b' }, { Origin: 'https://attacker.example' })).status, 403);
        assert.equal((await request('/api/login', { user: 'a', pass: 'b' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
        const login = await request('/api/login', { user: 'a', pass: 'b', remember: true });
        assert.equal(login.status, 200);
        const info = await login.json();
        assert.equal(info.token, undefined);
        assert.equal(info.pass, undefined);
        assert.equal(info.cookie, true);
        csrf = info.csrf;
        const sessionCookie = login.headers.getSetCookie().find(c => c.startsWith('sigaa_session='));
        assert.ok(sessionCookie.includes('HttpOnly') && sessionCookie.includes('SameSite=Lax') && sessionCookie.includes('Max-Age=604800'));
        const token = jar.get('sigaa_session');
        const restored = await (await request('/api/session')).json();
        assert.equal(restored.user, 'a');
        assert.equal(restored.token, undefined);
        assert.equal((await request('/api/scraper', { clientId: 'cookie-test' }, { 'X-CSRF-Token': '0'.repeat(64) })).status, 403);
        assert.equal(scrapeCalls, 0);
        assert.equal((await request('/api/scraper', { clientId: 'cookie-test' })).status, 200);
        const second = await request('/api/login', { user: 'second', pass: 'test' });
        assert.equal(second.status, 200);
        csrf = (await second.json()).csrf;
        assert.equal(await auth.validarTokenLogin(token), null);
        assert.ok(!second.headers.getSetCookie().find(c => c.startsWith('sigaa_session=')).includes('Max-Age'));
        const secondToken = jar.get('sigaa_session');
        assert.equal((await request('/api/logout', {})).status, 200);
        assert.equal(jar.has('sigaa_session'), false);
        assert.equal(await auth.validarTokenLogin(secondToken), null);
        assert.equal((await (await request('/api/session')).json()).loggedIn, false);
        const old = require('jsonwebtoken').decode(auth.gerarTokenLogin({ user: 'old', pass: 'test' }));
        delete old.sessionVersion;
        assert.equal(await auth.validarTokenLogin(require('jsonwebtoken').sign(old, process.env.SECRET)), null);
        const headers = new Map();
        const secureResponse = { setHeader(k,v) { headers.set(k,v); }, getHeader(k) { return headers.get(k); } };
        const productionRequest = { protocol: 'https', headers: { host: 'ak4ai-sigaa.duckdns.org', origin: 'https://ak4ai-sigaa.duckdns.org' } };
        sessions.issueSession(productionRequest, secureResponse, auth.gerarTokenLogin({user:'secure',pass:'test'}), true);
        sessions.applyCors(productionRequest, secureResponse);
        const secureCookie = headers.get('Set-Cookie').find(c => c.startsWith('__Host-sigaa_session='));
        assert.ok(secureCookie.includes('; Secure') && secureCookie.includes('; HttpOnly') && secureCookie.includes('Path=/'));
        assert.ok(!secureCookie.includes('Domain='));
        assert.equal(headers.get('Access-Control-Allow-Origin'), 'https://ak4ai-sigaa.duckdns.org');
        assert.equal(headers.get('Access-Control-Allow-Credentials'), 'true');

    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
