const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const { interpretSchedule, gerarTabelaSimplificada } = require('./scheduleParser');
const { delay } = require('./constants');

// Implementação simples de controle de concorrência
async function processWithConcurrency(items, handler, maxConcurrency = 3) {
    const results = [];
    let index = 0;

    async function runNext() {
        if (index >= items.length) return;
        const currentIndex = index++;
        results[currentIndex] = await handler(items[currentIndex]);
        return runNext();
    }

    const workers = Array.from({ length: maxConcurrency }, () => runNext());
    await Promise.all(workers);
    return results;
}

module.exports = async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    let browser;
    const isDev = process.env.NODE_ENV === 'development';

    try {
        const { user, pass } = req.body;

        if (!user || !pass) {
            throw new Error('Usuário e senha são obrigatórios.');
        }

        browser = await puppeteer.launch(
            isDev
                ? {
                      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                      headless: true,
                      args: ['--no-sandbox', '--disable-setuid-sandbox'],
                  }
                : {
                      args: [
                          '--no-sandbox',
                          '--disable-setuid-sandbox',
                          '--disable-dev-shm-usage',
                          '--disable-gpu',
                          '--single-process',
                          '--disable-extensions',
                          '--disable-infobars',
                          '--window-size=1024,768'
                      ],
                      executablePath: await chromium.executablePath(),
                      headless: chromium.headless,
                  }
        );

        const page = await browser.newPage();
        await page.setViewport({ width: 1024, height: 600 });

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            if (['stylesheet', 'font', 'image'].includes(resourceType)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.goto('https://sig.cefetmg.br/sigaa/verTelaLogin.do', {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });

        await page.type('#conteudo input[type=text]', user);
        await page.type('#conteudo input[type=password]', pass);

        await Promise.all([
            page.click('#conteudo input[type=submit]'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
        ]);

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

        const detailedSchedule = interpretSchedule(schedule);
        const simplifiedSchedule = gerarTabelaSimplificada(detailedSchedule);

        const disciplinasComAvisos = await processWithConcurrency(schedule, async (disciplina) => {
            const newPage = await browser.newPage();
            try {
                await newPage.setRequestInterception(true);
                newPage.on('request', (req) => {
                    const type = req.resourceType();
                    if (['stylesheet', 'font', 'image'].includes(type)) {
                        req.abort();
                    } else {
                        req.continue();
                    }
                });

                await newPage.goto('https://sig.cefetmg.br/sigaa/portais/discente/discente.jsf', {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000,
                });

                const xpath = `//form[contains(@id,"form_acessarTurmaVirtual")]//a[contains(text(),"${disciplina.disciplina}")]`;
                const linkHandle = await newPage.evaluateHandle((xpath) => {
                    const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    return result.singleNodeValue;
                }, xpath);

                if (linkHandle) {
                    await Promise.all([
                        linkHandle.click(),
                        newPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 })
                    ]);

                    await newPage.waitForSelector('.menu-direita', { timeout: 10000 });

                    const avisos = await newPage.$$eval('.menu-direita > li', items => {
                        return items.map(li => ({
                            data: li.querySelector('.data')?.innerText.trim(),
                            descricao: li.querySelector('.descricao')?.innerText.trim()
                        }));
                    });

                    return { ...disciplina, avisos };
                }
            } catch (e) {
                console.warn(`Erro ao processar ${disciplina.disciplina}:`, e.message);
                return { ...disciplina, avisos: [], erro: e.message };
            } finally {
                await newPage.close();
            }
        }, 5);

        await browser.close();

        return res.status(200).json({
            dadosInstitucionais,
            horariosDetalhados: detailedSchedule,
            horariosSimplificados: simplifiedSchedule,
            avisosPorDisciplina: disciplinasComAvisos
        });

    } catch (error) {
        if (browser) await browser.close();
        return res.status(500).json({ error: error.message || 'Erro interno' });
    }
};
