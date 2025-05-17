const jwt = require('jsonwebtoken');

// Use uma chave secreta forte em produção!
const SECRET = process.env.JWT_SECRET || 'sua-chave-secreta-supersegura';

// Gera um token com os dados do usuário (ex: user, pass)
function gerarTokenLogin(payload, expiresIn = '7d') {
    return jwt.sign(payload, SECRET, { expiresIn });
}

// Valida e decodifica o token
function validarTokenLogin(token) {
    try {
        return jwt.verify(token, SECRET);
    } catch (e) {
        return null;
    }
}

module.exports = { gerarTokenLogin, validarTokenLogin };