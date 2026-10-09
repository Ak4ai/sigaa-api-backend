const { gerarTokenLogin, validarTokenLogin } = require('./auth');
const { issueSession, cookieToken } = require('../lib/browser-session');
const { withRateProtection, limits, attachRequestBudget, scrapeIdentity } = require('../lib/request-protection');
const { ScrapeQueue } = require('../lib/scrape-queue');
const { verifySigaaLogin } = require('../lib/sigaa-login');
const queue = new ScrapeQueue(10);

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
    const budget = attachRequestBudget(req, res, { totalMs: 45000, runtimeMs: 30000 });
    try {
        await queue.enqueue({ identity: scrapeIdentity(user, pass), clientId: require('crypto').randomUUID(), signal: budget.signal,
            run: async () => { budget.start(); await verifySigaaLogin(user, pass, budget.signal); }
        });
        budget.signal.throwIfAborted();
        const token = gerarTokenLogin({ user, pass }, req.body.remember === true ? '7d' : '12h', cookieToken(req));
        const payload = await validarTokenLogin(token);
        const csrf = issueSession(req, res, token, req.body.remember === true);
        return res.status(200).json({ cookie: true, loggedIn: true, user, expiresAt: payload.exp * 1000, csrf });
    } catch (error) {
        if (budget.signal.aborted || res.headersSent || res.destroyed) return;
        const status = error.status || 503;
        if (status === 429) res.setHeader('Retry-After', '60');
        return res.status(status).json({ error: error.status ? error.message : 'Não foi possível confirmar o login. Tente novamente.', ...(error.type ? {type: error.type} : {}) });
    } finally { budget.cleanup(); }
};

module.exports = withRateProtection(handler, limits.login);
