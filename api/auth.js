// This file exports the function `validarTokenLogin`, which validates the user token for authentication purposes.

const jwt = require('jsonwebtoken');

const SECRET_KEY = process.env.SECRET_KEY || 'your_secret_key';

function validarTokenLogin(token) {
    try {
        const payload = jwt.verify(token, SECRET_KEY);
        return payload;
    } catch (error) {
        return null;
    }
}

module.exports = { validarTokenLogin };