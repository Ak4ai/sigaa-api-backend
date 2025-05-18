const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const { interpretSchedule, gerarTabelaSimplificada } = require('./scheduleParser');
const { delay } = require('./constants');
const { validarTokenLogin } = require('./auth');

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

    let user, pass;
    if (req.body.token) {
        const payload = validarTokenLogin(req.body.token);
        if (!payload) {
            return res.status(401).json({ error: 'Token inválido ou expirado.' });
        }
        user = payload.user;
        pass = payload.pass;
    } else {
        user = req.body.user;
        pass = req.body.pass;
    }

    if (!user || !pass) {
        return res.status(400).json({ error: 'Usuário e senha obrigatórios.' });
    }

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

                        console.log(`[${disciplina.disciplina}] Abrindo aba de frequência via jsfcljs...`);
                        await page.evaluate(() => {
                            jsfcljs(
                                document.getElementById('formMenu'),
                                {'formMenu:j_id_jsp_311393315_97':'formMenu:j_id_jsp_311393315_97'},
                                ''
                            );
                        });

                        // Aguarda a tabela de frequência aparecer
                        await page.waitForSelector('fieldset > table > tbody tr', { timeout: 7000 });

                        // Verifica se a tabela de frequência apareceu
                        const freqTableExists = await page.$('fieldset > table > tbody tr') !== null;
                        console.log(`[${disciplina.disciplina}] Tabela de frequência visível?`, freqTableExists);

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

                        // Coleta o número de aulas definidas pela CH do componente
                        const numeroAulasDefinidas = await page.$eval('.botoes-show', el => {
                            const match = el.innerText.match(/Número de Aulas definidas pela CH do Componente:\s*(\d+)/i);
                            return match ? parseInt(match[1], 10) : null;
                        });
                        console.log(`[${disciplina.disciplina}] Número de aulas definidas:`, numeroAulasDefinidas);

                        // (Opcional) Coleta a porcentagem de frequência
                        const porcentagemFrequencia = await page.$eval('.botoes-show', el => {
                            const match = el.innerText.match(/Porcentagem de Frequência em relação a CH:\s*(\d+)%/i);
                            return match ? parseInt(match[1], 10) : null;
                        });
                        console.log(`[${disciplina.disciplina}] Porcentagem de frequência:`, porcentagemFrequencia);

                        // ...existing code...
                        
                        // Abrir aba de notas via jsfcljs (captura dinâmica do parâmetro)
                        console.log(`[${disciplina.disciplina}] Abrindo aba de notas via jsfcljs...`);
                        await page.evaluate(() => {
                            // Procura o link "Ver Notas" pelo texto do menu
                            const links = Array.from(document.querySelectorAll('#formMenu a'));
                            const notasLink = links.find(a => a.innerText.includes('Ver Notas'));
                            if (notasLink && typeof jsfcljs === 'function') {
                                // Extrai o parâmetro do onclick
                                const onclick = notasLink.getAttribute('onclick');
                                const match = onclick && onclick.match(/jsfcljs\(.*,\s*\{('([^']+)':'\2')\}/);
                                if (match && match[2]) {
                                    const param = {};
                                    param[match[2]] = match[2];
                                    jsfcljs(document.getElementById('formMenu'), param, '');
                                }
                            }
                        });
                        
                        // Aguarda a tabela de notas aparecer, mas não trava se não aparecer
                        let notasHeaders = [];
                        let notas = [];
                        let avaliacoes = [];
                        try {
                            await page.waitForSelector('table.tabelaRelatorio', { timeout: 3000 });
                            notasHeaders = await page.$$eval('table.tabelaRelatorio thead tr#trAval th', ths =>
                                ths.map(th => th.innerText.trim()).filter(Boolean)
                            );
                            notas = await page.$$eval('table.tabelaRelatorio tbody tr', rows =>
                                rows.map(tr => {
                                    const tds = Array.from(tr.querySelectorAll('td'));
                                    return tds.map(td => td.innerText.trim());
                                })
                            );
                            // Captura nota, peso e den dos inputs escondidos do tr#trAval
                            avaliacoes = await page.$$eval('table.tabelaRelatorio thead tr#trAval th[id^="aval_"]', ths =>
                                ths.map(th => {
                                    const id = th.id.replace('aval_', '');
                                    const abrev = document.getElementById('abrevAval_' + id)?.value || '';
                                    const den = document.getElementById('denAval_' + id)?.value || '';
                                    const nota = document.getElementById('notaAval_' + id)?.value || '';
                                    const peso = document.getElementById('pesoAval_' + id)?.value || '';
                                    return { abrev, den, nota, peso };
                                })
                            );
                            console.log(`[${disciplina.disciplina}] Notas coletadas:`, { headers: notasHeaders, notas, avaliacoes });
                        } catch (e) {
                            console.log(`[${disciplina.disciplina}] Nenhuma nota lançada ou tabela não encontrada.`);
                        }
                        
                        // ...existing code...
                        
                        // Retorne junto com os outros dados:
                        return {
                            ...disciplina,
                            avisos,
                            frequencia,
                            numeroAulasDefinidas,
                            porcentagemFrequencia,
                            notas: {
                                headers: notasHeaders,
                                valores: notas,
                                avaliacoes // <-- agora inclui os detalhes das avaliações
                            }
                        };
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