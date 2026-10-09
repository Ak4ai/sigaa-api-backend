const { gerarTokenLogin, revogarTokenLogin } = require('./auth');
const { issueSession, cookieToken } = require('../lib/browser-session');
const { withRateProtection, limits } = require('../lib/request-protection');

async function handler(req, res) {
    // CORS headers

    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

    const { user, pass } = req.body || {};
    if (typeof user !== 'string' || typeof pass !== 'string' || !user || !pass || user.length > 128 || pass.length > 1024) {
        return res.status(400).json({ error: 'Usuário e senha obrigatórios.' });
    }
    const previous = cookieToken(req);
    if (previous) {
        try { await revogarTokenLogin(previous); }
        catch { return res.status(503).json({ error: 'Não foi possível substituir a sessão. Tente novamente.' }); }
    }
    const token = gerarTokenLogin({ user, pass });
    const csrf = issueSession(req, res, token, req.body.remember === true);
    return res.status(200).json({ cookie: true, loggedIn: true, user, expiresAt: require('jsonwebtoken').decode(token).exp * 1000, csrf });
};

module.exports = withRateProtection(handler, limits.login);
