const crypto = require('node:crypto');
const { validarTokenLogin } = require('../api/auth');
const productionOrigin = 'https://ak4ai-sigaa.duckdns.org';
function localRequest(req) {
    const host = String(req.headers?.host || '').split(':')[0];
    return ['localhost', '127.0.0.1'].includes(host) && req.protocol !== 'https';
}
function names(req) {
    const prefix = localRequest(req) ? '' : '__Host-';
    return { session: `${prefix}sigaa_session`, csrf: `${prefix}sigaa_csrf` };
}
function cookies(req) {
    const result = Object.create(null);
    for (const part of String(req.headers?.cookie || '').split(';')) {
        const index = part.indexOf('=');
        if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    return result;
}
function trustedOrigin(req) {
    const origin = req.headers?.origin;
    if (!origin) return true; // CLI requests still require the CSRF proof for cookie writes.
    if (origin === productionOrigin) return true;
    return localRequest(req) && origin === `http://${req.headers.host}`;
}
function applyCors(req, res) {
    res.setHeader('Vary', 'Origin');
    if (req.headers?.origin && trustedOrigin(req)) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, X-Profile-User');
}
function setCookie(req, res, name, value, maxAge) {
    let text = `${name}=${value}; Path=/; HttpOnly; SameSite=Lax`;
    if (!localRequest(req)) text += '; Secure';
    if (maxAge !== undefined) text += `; Max-Age=${maxAge}`;
    const previous = res.getHeader?.('Set-Cookie');
    res.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous : previous ? [previous] : []), text]);
}
function csrfProof(seed) {
    return crypto.createHmac('sha256', process.env.SECRET).update(`browser-csrf:${seed}`).digest('hex');
}
function issueCsrf(req, res, rotate = false) {
    let seed = cookies(req)[names(req).csrf];
    if (rotate || !/^[a-f0-9]{64}$/.test(seed || '')) {
        seed = crypto.randomBytes(32).toString('hex');
        setCookie(req, res, names(req).csrf, seed);
    }
    return csrfProof(seed);
}
function validCsrf(req) {
    const seed = cookies(req)[names(req).csrf];
    const proof = req.headers?.['x-csrf-token'];
    if (!/^[a-f0-9]{64}$/.test(seed || '') || !/^[a-f0-9]{64}$/.test(proof || '')) return false;
    return crypto.timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(csrfProof(seed), 'hex'));
}
function cookieToken(req) { return cookies(req)[names(req).session]; }
function issueSession(req, res, token, persistent) {
    setCookie(req, res, names(req).session, token, persistent ? 7 * 86400 : undefined);
    return issueCsrf(req, res, true);
}
function clearSession(req, res) { setCookie(req, res, names(req).session, '', 0); }
function middleware(req, res, next) {
    applyCors(req, res);
    res.setHeader('Cache-Control', 'no-store');
    if (!trustedOrigin(req) || req.headers?.['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Origem não autorizada.' });
    const token = cookieToken(req);
    const route = String(req.path || req.url?.split('?')[0] || '/').replace(/^\/api(?=\/)/, '');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method === 'POST' && (token || route === '/login') && !validCsrf(req)) return res.status(403).json({ error: 'Verificação de segurança expirada. Atualize a página.' });
    if (token && ['/scraper', '/logout'].includes(route)) {
        req.body = req.body || {};
        // Explicit legacy-token logout is allowed only after the same CSRF check.
        if (!req.body.token) req.body.token = token;
    }
    if (token && ['/calendario/eventos', '/calendario-eventos'].includes(route) && !req.headers.authorization) req.headers.authorization = `Bearer ${token}`;
    req.browserSessionPrepared = true;
    next();
}
function prepareBrowserRequest(req, res) {
    if (req.browserSessionPrepared) return true;
    let admitted = false;
    middleware(req, res, () => { admitted = true; });
    return admitted;
}
async function sessionHandler(req, res) {
    const token = cookieToken(req);
    try {
        const payload = token ? await validarTokenLogin(token) : null;
        if (token && !payload) clearSession(req, res);
        const csrf = issueCsrf(req, res);
        return res.json({ loggedIn: !!payload, cookie: !!payload, user: payload?.user || '', expiresAt: payload ? payload.exp * 1000 : null, csrf });
    } catch { return res.status(503).json({ error: 'Não foi possível verificar a sessão.' }); }
}
module.exports = { applyCors, middleware, prepareBrowserRequest, sessionHandler, issueSession, clearSession, cookieToken };
