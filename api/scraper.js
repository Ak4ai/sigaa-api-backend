const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const { Cluster } = require('puppeteer-cluster');
const { interpretSchedule, gerarTabelaSimplificada } = require('./scheduleParser');
const { delay } = require('./constants');
const { validarTokenLogin } = require('./auth');

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

    let cluster;
    const isDev = process.env.NODE_ENV === 'development';

    // 1. Task para login e schedule
    const getSchedule = async ({ page, data }) => {
        await page.goto('https://sig.cefetmg.br/sigaa/verTelaLogin.do', {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
        await page.type('#conteudo input[type=text]', data.user);
        await page.type('#conteudo input[type=password]', data.pass);
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

        return { dadosInstitucionais, schedule };
    };

    // 2. Task para disciplinas
    const processDisciplina = async ({ page, data: disciplina }) => {
        try {
            await page.setViewport({ width: 1024, height: 600 });
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const type = req.resourceType();
                if (['stylesheet', 'font', 'image'].includes(type)) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            // Login em cada contexto isolado
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

            // Acesse a página da disciplina
            await page.goto('https://sig.cefetmg.br/sigaa/portais/discente/discente.jsf', {
                waitUntil: 'domcontentloaded',
                timeout: 15000,
            });

            const xpath = `//form[contains(@id,"form_acessarTurmaVirtual")]//a[normalize-space(text())="${disciplina.disciplina}"]`;
            const linkHandle = await page.evaluateHandle((xpath) => {
                const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                return result.singleNodeValue;
            }, xpath);

            if (linkHandle) {
                await Promise.all([
                    linkHandle.click(),
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 })
                ]);

                await page.waitForSelector('.menu-direita', { timeout: 7000 });

                // Coleta avisos
                const avisos = await page.$$eval('.menu-direita > li', items => {
                    return items.map(li => ({
                        data: li.querySelector('.data')?.innerText.trim(),
                        descricao: li.querySelector('.descricao')?.innerText.trim()
                    }));
                });

                // Frequência
                const frequenciaInfo = 'formMenu:j_id_jsp_311393315_97';
                await page.evaluate((codigo) => {
                    if (typeof jsfcljs === 'function') {
                        jsfcljs(
                            document.getElementById('formMenu'),
                            { [codigo]: codigo },
                            ''
                        );
                    }
                }, frequenciaInfo);

                await page.waitForSelector('fieldset', { timeout: 7000 });

                const frequenciaNaoLancada = await page.evaluate(() => {
                    const span = Array.from(document.querySelectorAll('fieldset > span')).find(el =>
                        el.innerText.includes('A frequência ainda não foi lançada.')
                    );
                    return !!span;
                });

                let frequencia = [], numeroAulasDefinidas = null, porcentagemFrequencia = null;
                if (!frequenciaNaoLancada) {
                    await page.waitForSelector('fieldset > table', { timeout: 15000 });
                    frequencia = await page.$$eval(
                        'fieldset > table > tbody tr',
                        rows => rows.map(tr => {
                            const tds = tr.querySelectorAll('td');
                            return {
                                data: tds[0]?.innerText.trim(),
                                status: tds[1]?.innerText.trim()
                            };
                        })
                    );
                    numeroAulasDefinidas = await page.$eval('.botoes-show', el => {
                        const match = el.innerText.match(/Número de Aulas definidas pela CH do Componente:\s*(\d+)/i);
                        return match ? parseInt(match[1], 10) : null;
                    });
                    porcentagemFrequencia = await page.$eval('.botoes-show', el => {
                        const match = el.innerText.match(/Porcentagem de Frequência em relação a CH:\s*(\d+)%/i);
                        return match ? parseInt(match[1], 10) : null;
                    });
                }

                // Notas
                const notasInfo = 'formMenu:j_id_jsp_122142787_99';
                await page.evaluate((codigo) => {
                    if (typeof jsfcljs === 'function') {
                        jsfcljs(
                            document.getElementById('formMenu'),
                            { [codigo]: codigo },
                            ''
                        );
                    }
                }, notasInfo);

                let notasHeaders = [];
                let notas = [];
                let avaliacoes = [];
                try {
                    await page.waitForSelector('table.tabelaRelatorio', { timeout: 3000 });
                } catch (e) {}
                try {
                    notasHeaders = await page.$$eval('table.tabelaRelatorio thead tr#trAval th', ths =>
                        ths.map(th => th.innerText.trim()).filter(Boolean)
                    );
                    notas = await page.$$eval('table.tabelaRelatorio tbody tr', rows =>
                        rows.map(tr => {
                            const tds = Array.from(tr.querySelectorAll('td'));
                            return tds.map(td => td.innerText.trim());
                        })
                    );
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
                } catch (e) {}

                return {
                    ...disciplina,
                    avisos,
                    frequencia,
                    numeroAulasDefinidas,
                    porcentagemFrequencia,
                    notas: {
                        headers: notasHeaders,
                        valores: notas,
                        avaliacoes
                    }
                };
            }
        } catch (e) {
            return { ...disciplina, avisos: [], frequencia: [], erro: e.message };
        }
    };

    try {
        cluster = await Cluster.launch({
            concurrency: Cluster.CONCURRENCY_CONTEXT,
            maxConcurrency: 1,
            puppeteerOptions: {
                executablePath: await chromium.executablePath(),
                headless: chromium.headless,
                args: chromium.args,
            }
        });

        // 1. Coleta schedule
        await cluster.task(getSchedule);
        const { dadosInstitucionais, schedule } = await cluster.execute({ user, pass });

        const detailedSchedule = interpretSchedule(schedule);
        const simplifiedSchedule = gerarTabelaSimplificada(detailedSchedule);

        // 2. Coleta disciplinas
        await cluster.task(processDisciplina);
        const disciplinasComAvisos = [];
        for (const disciplina of schedule) {
            disciplinasComAvisos.push(await cluster.execute(disciplina));
        }

        await cluster.idle();
        await cluster.close();

        return res.status(200).json({
            dadosInstitucionais,
            horariosDetalhados: detailedSchedule,
            horariosSimplificados: simplifiedSchedule,
            avisosPorDisciplina: disciplinasComAvisos
        });

    } catch (error) {
        if (cluster) await cluster.close();
        return res.status(500).json({ error: error.message || 'Erro interno' });
    }
};