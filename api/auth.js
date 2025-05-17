const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const SECRET = process.env.JWT_SECRET;
const ENC_SECRET = process.env.ENC_SECRET; // 32 caracteres para AES-256 (senha)
const ENC_SECRET_USER = process.env.ENC_SECRET_USER; // 32 caracteres para AES-256 (usuário)

if (!SECRET) throw new Error('JWT_SECRET não definida!');
if (!ENC_SECRET || ENC_SECRET.length !== 32) throw new Error('ENC_SECRET deve ter exatamente 32 caracteres!');
if (!ENC_SECRET_USER || ENC_SECRET_USER.length !== 32) throw new Error('ENC_SECRET_USER deve ter exatamente 32 caracteres!');

function encrypt(text, key) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), iv);
    let encrypted = cipher.update(text, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return iv.toString('base64') + ':' + encrypted;
}

function decrypt(text, key) {
    const [iv, encrypted] = text.split(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'base64'));
    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

function gerarTokenLogin(payload, expiresIn = '15m') {
    // Criptografa usuário e senha antes de salvar no payload
    if (payload.user) {
        payload.user = encrypt(payload.user, ENC_SECRET_USER);
    }
    if (payload.pass) {
        payload.pass = encrypt(payload.pass, ENC_SECRET);
    }
    return jwt.sign(payload, SECRET, { expiresIn });
}

function validarTokenLogin(token) {
    try {
        const payload = jwt.verify(token, SECRET);
        // Descriptografa usuário e senha ao ler o payload
        if (payload.user) {
            payload.user = decrypt(payload.user, ENC_SECRET_USER);
        }
        if (payload.pass) {
            payload.pass = decrypt(payload.pass, ENC_SECRET);
        }
        return payload;
    } catch (e) {
        return null;
    }
}

module.exports = { gerarTokenLogin, validarTokenLogin };