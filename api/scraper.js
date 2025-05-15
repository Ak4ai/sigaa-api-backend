// /api/scraper.js
const puppeteer = require('puppeteer');
const { interpretSchedule } = require('./scheduleParser');
const { delay } = require('./constants');

module.exports = async function handler(req, res) {
  try {
    const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto('https://sig.cefetmg.br/sigaa/verTelaLogin.do', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // Use variáveis de ambiente para segurança na autenticação!
    const user = process.env.SIGAA_USER || '14669329618';
    const pass = process.env.SIGAA_PASS || '@Q1w2e3r4t5';

    await page.type('#conteudo input[type=text]', user);
    await page.type('#conteudo input[type=password]', pass);
    await Promise.all([
      page.click('#conteudo input[type=submit]'),
      page.waitForSelector('#agenda-docente table tbody tr', { timeout: 60000 })
    ]);
    await delay(2000);

    // Pegando dados institucionais
    const dadosInstitucionais = await page.$$eval(
      '#agenda-docente table tbody tr',
      rows => {
        const obj = {};
        for (const row of rows) {
          const cols = Array.from(row.querySelectorAll('td'));
          if (cols.length === 2) {
            const label = cols[0].innerText.replace(':', '').trim();
            const valor = cols[1].innerText.trim();
            obj[label] = valor;
          }
        }
        return obj;
      }
    );

    // Pegando horários
    await page.waitForSelector('form[id^="form_acessarTurmaVirtual"]', { timeout: 15000 });
    const schedule = await page.$$eval('tbody tr', rows => {
      let currentTerm = '';
      const data = [];
      rows.forEach(row => {
        const termTd = row.querySelector('td[colspan]');
        if (termTd) { currentTerm = termTd.innerText.trim(); return; }
        if (row.querySelector('form[id^="form_acessarTurmaVirtual"]')) {
          const descricaoTd = row.querySelector('td.descricao');
          const courseName = descricaoTd.querySelector('a')?.innerText.trim() ?? descricaoTd.innerText.trim();
          const turmaInfo = row.querySelectorAll('td.info')[0]?.innerText.trim() || '';
          const horarioInfo = row.querySelectorAll('td.info')[1]?.innerText.trim() || '';
          const codesOnly = horarioInfo.split('(')[0].trim();
          data.push({ semestre: currentTerm, disciplina: courseName, turma: turmaInfo, rawCodes: codesOnly });
        }
      });
      return data;
    });

    const detailedSchedule = interpretSchedule(schedule);

    await browser.close();

    res.status(200).json({
      dadosInstitucionais,
      horarios: detailedSchedule,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
