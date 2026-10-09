const { revogarTokenLogin } = require('./auth');
const { withRateProtection } = require('../lib/request-protection');
const { clearSession } = require('../lib/browser-session');

async function handler(req, res) {

    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
    const token = req.body?.token;
    if (!token) {
        clearSession(req, res);
        return res.status(200).json({ success: true });
    }
    if (typeof token !== 'string' || !token || token.length > 8192) return res.status(400).json({ error: 'Token obrigatório ou inválido.' });
    try {
        if (!await revogarTokenLogin(token)) {
            clearSession(req, res);
            return res.status(401).json({ error: 'Token inválido.' });
        }
        clearSession(req, res);
        return res.status(200).json({ success: true });
    } catch (error) {
        return res.status(503).json({ error: 'Não foi possível encerrar a sessão. Tente novamente.' });
    }
};

module.exports = withRateProtection(handler, 60);
