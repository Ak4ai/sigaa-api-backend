const { gerarTokenLogin } = require('./auth');

module.exports = async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { user, pass } = req.body;
    if (!user || !pass) {
        return res.status(400).json({ error: 'Usuário e senha obrigatórios.' });
    }
    // Aqui você pode validar o login no SIGAA, se quiser.
    // Se sucesso:
    const token = gerarTokenLogin({ user, pass });
    return res.status(200).json({ token });
};