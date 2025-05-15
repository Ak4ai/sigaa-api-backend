// /api/scraper.js
const chromium = require('chrome-aws-lambda');
const puppeteer = require('puppeteer-core');
const { interpretSchedule } = require('./scheduleParser');
const { delay } = require('./constants');

module.exports = async function handler(req, res) {
  let browser = null;
  const isDev = process.env.NODE_ENV === 'development';

  try {
    browser = await puppeteer.launch(
      isDev
        ? {
            // Desenvolvimento local: aponta para o Chrome instalado no Windows
            executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
          }
        : {
            // Produção no Vercel: usa o Chromium do chrome-aws-lambda
            args: chromium.args,
            executablePath: await chromium.executablePath,
            headless: chromium.headless,
          }
    );

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    await page.goto('https://sig.cefetmg.br/sigaa/verTelaLogin.do', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    const user = process.env.SIGAA_USER;
    const pass = process.env.SIGAA_PASS;

    await page.type('#conteudo input[type=text]', user);
    await page.type('#conteudo input[type=password]', pass);
    await Promise.all([
      page.click('#conteudo input[type=submit]'),
      page.waitForSelector('#agenda-docente table tbody tr', { timeout: 60000 })
    ]);

    await delay(2000);

    // Dados institucionais
    const dadosInstitucionais = await page.$$eval(
      '#agenda-docente table tbody tr',
      rows => {
        const obj = {};
        for (const row of rows) {
          const cols = Array.from(row.querySelectorAll('td'));
          if (cols.length === 2) {
            obj[cols[0].innerText.replace(':', '').trim()] = cols[1].innerText.trim();
          }
        }
        return obj;
      }
    );

    // Horários
    await page.waitForSelector('form[id^="form_acessarTurmaVirtual"]', { timeout: 15000 });
    const schedule = await page.$$eval('tbody tr', rows => {
      let term = '';
      const data = [];
      for (const row of rows) {
        const span = row.querySelector('td[colspan]');
        if (span) { term = span.innerText.trim(); continue; }
        if (row.querySelector('form[id^="form_acessarTurmaVirtual"]')) {
          const desc = row.querySelector('td.descricao');
          const name = desc.querySelector('a')?.innerText.trim() ?? desc.innerText.trim();
          const [turmaInfo, horarioInfo] = Array.from(row.querySelectorAll('td.info')).map(td => td.innerText.trim());
          data.push({ semestre: term, disciplina: name, turma: turmaInfo, rawCodes: horarioInfo.split('(')[0].trim() });
        }
      }
      return data;
    });

    const detailedSchedule = interpretSchedule(schedule);

    await browser.close();
    res.status(200).json({ dadosInstitucionais, horarios: detailedSchedule });
  } catch (error) {
    if (browser) await browser.close();
    res.status(500).json({ error: error.message });
  }
};
