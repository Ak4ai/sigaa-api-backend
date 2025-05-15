const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const { interpretSchedule } = require('./scheduleParser');
const { delay } = require('./constants');

module.exports = async function handler(req, res) {
  let browser;

  const isDev = process.env.NODE_ENV === 'development';

  try {
    browser = await puppeteer.launch(
      isDev
        ? {
            executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
          }
        : {
            args: chromium.args,
            executablePath: await chromium.executablePath(),
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

    if (!user || !pass) {
      throw new Error('Credenciais do SIGAA não definidas nas variáveis de ambiente');
    }

    await page.type('#conteudo input[type=text]', user);
    await page.type('#conteudo input[type=password]', pass);

    await Promise.all([
      page.click('#conteudo input[type=submit]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
    ]);

    // Aguarda a agenda carregar
    await page.waitForSelector('#agenda-docente table tbody tr', { timeout: 10000 });

    const dadosInstitucionais = await page.$$eval(
      '#agenda-docente table tbody tr',
      rows => {
        const obj = {};
        for (const row of rows) {
          const cols = Array.from(row.querySelectorAll('td'));
          if (cols.length === 2) {
            const key = cols[0].innerText.replace(':', '').trim();
            const val = cols[1].innerText.trim();
            obj[key] = val;
          }
        }
        return obj;
      }
    );

    await page.waitForSelector('form[id^="form_acessarTurmaVirtual"]', { timeout: 15000 });

    const schedule = await page.$$eval('tbody tr', rows => {
      let term = '';
      const data = [];
      for (const row of rows) {
        const span = row.querySelector('td[colspan]');
        if (span) {
          term = span.innerText.trim();
          continue;
        }

        if (row.querySelector('form[id^="form_acessarTurmaVirtual"]')) {
          const desc = row.querySelector('td.descricao');
          const name = desc.querySelector('a')?.innerText.trim() ?? desc.innerText.trim();
          const infos = Array.from(row.querySelectorAll('td.info')).map(td =>
            td.innerText.trim()
          );
          const turmaInfo = infos[0] || '';
          const rawCodes = (infos[1] || '').split('(')[0].trim();
          data.push({ semestre: term, disciplina: name, turma: turmaInfo, rawCodes });
        }
      }
      return data;
    });

    if (!Array.isArray(schedule)) {
      throw new Error('Erro ao interpretar os horários - retorno inesperado');
    }

    const detailedSchedule = interpretSchedule(schedule);

    await browser.close();
    return res.status(200).json({ dadosInstitucionais, horarios: detailedSchedule });
  } catch (error) {
    if (browser) await browser.close();
    return res.status(500).json({ error: error.message || 'Erro interno' });
  }
};
