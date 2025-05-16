const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const { interpretSchedule, gerarTabelaSimplificada } = require('./scheduleParser');
const { delay } = require('./constants');

// Refatorado: aceita workerIndex e extraArgs (ex: pages)
async function processWithConcurrency(items, handler, maxConcurrency = 3, extraArgs = {}) {
    const results = [];
    let index = 0;

    async function runNext(workerIndex) {
        if (index >= items.length) return;
        const currentIndex = index++;
        results[currentIndex] = await handler(items[currentIndex], workerIndex, extraArgs);
        return runNext(workerIndex);
    }

    const workers = Array.from({ length: maxConcurrency }, (_, i) => runNext(i));
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

        console.time('total');

        const detailedSchedule = interpretSchedule(schedule);
        const simplifiedSchedule = gerarTabelaSimplificada(detailedSchedule);

        // Cria um pool de abas (pages) para os workers
        const poolSize = Math.min(2, schedule.length); // Reduzido para no máximo 2 abas
        console.time('openPages');
        const pages = await Promise.all(
            Array.from({ length: poolSize }, () => browser.newPage())
        );
        console.timeEnd('openPages');

        // Configura cada aba do pool
        await Promise.all(pages.map(async (page) => {
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const type = req.resourceType();
                if (['stylesheet', 'font', 'image'].includes(type)) {
                    req.abort();
                } else {
                    req.continue();
                }
            });
            await page.setViewport({ width: 1024, height: 600 });
            await page.setUserAgent('Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Mobile Safari/537.36');
        }));

        console.time('avisos');
        const disciplinasComAvisos = await processWithConcurrency(
            schedule,
            async (disciplina, workerIndex, { pages }) => {
                const page = pages[workerIndex];
                try {
                    await page.goto('https://sig.cefetmg.br/sigaa/portais/discente/discente.jsf', {
                        waitUntil: 'domcontentloaded',
                        timeout: 15000, // Timeout reduzido
                    });

                    const xpath = `//form[contains(@id,"form_acessarTurmaVirtual")]//a[contains(text(),"${disciplina.disciplina}")]`;
                    const linkHandle = await page.evaluateHandle((xpath) => {
                        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                        return result.singleNodeValue;
                    }, xpath);

                    if (linkHandle) {
                        await Promise.all([
                            linkHandle.click(),
                            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }) // Timeout reduzido
                        ]);

                        await page.waitForSelector('.menu-direita', { timeout: 7000 }); // Timeout reduzido

                        // Coleta avisos
                        const avisos = await page.$$eval('.menu-direita > li', items => {
                            return items.map(li => ({
                                data: li.querySelector('.data')?.innerText.trim(),
                                descricao: li.querySelector('.descricao')?.innerText.trim()
                            }));
                        });

                        // Clica no botão "Frequência" de forma robusta
                        console.log(`[${disciplina.disciplina}] Procurando botão Frequência...`);
                        const freqBtnHandle = await page.evaluateHandle(() => {
                            // Procura todos os itens de menu
                            const menuLinks = Array.from(document.querySelectorAll('a'));
                            return menuLinks.find(a =>
                                a.querySelector('.itemMenu') &&
                                a.querySelector('.itemMenu').innerText.trim().toLowerCase() === 'frequência'
                            ) || null;
                        });

                        const freqBtnElement = freqBtnHandle.asElement();
                        if (!freqBtnElement) {
                            console.warn(`[${disciplina.disciplina}] Botão Frequência não encontrado!`);
                            return { ...disciplina, avisos, frequencia: [], erro: 'Botão Frequência não encontrado' };
                        }

                        console.log(`[${disciplina.disciplina}] Clicando no botão Frequência...`);
                        await Promise.all([
                            freqBtnElement.click(),
                            page.waitForSelector('fieldset > table > tbody tr', { timeout: 7000 })
                        ]);

                        // Coleta a tabela de frequência
                        console.log(`[${disciplina.disciplina}] Coletando tabela de frequência...`);
                        const frequencia = await page.$$eval(
                            'fieldset > table > tbody tr',
                            rows => rows.map(tr => {
                                const tds = tr.querySelectorAll('td');
                                return {
                                    data: tds[0]?.innerText.trim(),
                                    status: tds[1]?.innerText.trim()
                                };
                            })
                        );
                        console.log(`[${disciplina.disciplina}] Frequência coletada:`, frequencia);

                        return { ...disciplina, avisos, frequencia };
                    }
                } catch (e) {
                    console.warn(`Erro ao processar ${disciplina.disciplina}:`, e.message);
                    return { ...disciplina, avisos: [], frequencia: [], erro: e.message };
                }
            },
            poolSize,
            { pages }
        );
        console.timeEnd('avisos');

        // Fecha todas as abas do pool
        console.time('closePages');
        await Promise.all(pages.map(p => p.close()));
        console.timeEnd('closePages');
        await browser.close();

        console.timeEnd('total');

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