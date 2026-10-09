const { gerarTokenLogin } = require('./auth');
const { withRateProtection, limits } = require('../lib/request-protection');

async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
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
    // Aqui você pode validar o login no SIGAA, se quiser.
    // Se sucesso:
    const token = gerarTokenLogin({ user, pass });
    return res.status(200).json({ token });
};

module.exports = withRateProtection(handler, limits.login);
