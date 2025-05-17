const { gerarTokenLogin } = require('./auth');

module.exports = async function handler(req, res) {
    const { user, pass } = req.body;
    if (!user || !pass) {
        return res.status(400).json({ error: 'Usuário e senha obrigatórios.' });
    }
    // Aqui você pode validar o login no SIGAA, se quiser.
    // Se sucesso:
    const token = gerarTokenLogin({ user, pass });
    return res.status(200).json({ token });
};