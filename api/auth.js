const sessions = require('../lib/server-sessions');
module.exports = {
    gerarTokenLogin: sessions.create,
    validarTokenLogin: async id => sessions.read(id),
    revogarTokenLogin: async id => sessions.remove(id)
};
