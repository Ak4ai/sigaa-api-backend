const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const SECRET = process.env.JWT_SECRET || 'sua-chave-secreta-supersegura';
const ENC_SECRET = process.env.ENC_SECRET || 'chave-muito-forte-e-secreta'; // 32 caracteres para AES-256

function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENC_SECRET, 'utf8'), iv);
    let encrypted = cipher.update(text, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return iv.toString('base64') + ':' + encrypted;
}

function decrypt(text) {
    const [iv, encrypted] = text.split(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENC_SECRET, 'utf8'), Buffer.from(iv, 'base64'));
    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

function gerarTokenLogin(payload, expiresIn = '15m') {
    // Criptografa a senha antes de salvar no payload
    if (payload.pass) {
        payload.pass = encrypt(payload.pass);
    }
    return jwt.sign(payload, SECRET, { expiresIn });
}

function validarTokenLogin(token) {
    try {
        const payload = jwt.verify(token, SECRET);
        // Descriptografa a senha ao ler o payload
        if (payload.pass) {
            payload.pass = decrypt(payload.pass);
        }
        return payload;
    } catch (e) {
        return null;
    }
}

module.exports = { gerarTokenLogin, validarTokenLogin };