const scraper = require('./scraper');
const scheduleParser = require('./scheduleParser');
const auth = require('./auth');
const constants = require('./constants');
const avisos = require('./avisos');
const frequencia = require('./frequencia');
const notas = require('./notas');

module.exports = {
    scraper,
    scheduleParser,
    auth,
    constants,
    avisos,
    frequencia,
    notas,
};