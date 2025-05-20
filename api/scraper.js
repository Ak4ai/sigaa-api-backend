const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
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

        // Cria apenas UMA aba para todas as disciplinas
        const page = await browser.newPage();
        await page.setViewport({ width: 1024, height: 600 });
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            if (['stylesheet', 'font', 'image', 'media', 'other'].includes(type)) {
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

        console.time('avisos');
        const disciplinasComAvisos = [];

        // Após coletar o schedule, entre na primeira disciplina via menu principal
        await page.click('#form_acessarTurmaVirtual > a');
        await page.waitForSelector('#formTurma', { timeout: 15000 });

        // Coleta os códigos das disciplinas
        const disciplinasCodigos = await page.$$eval('#formTurma a.linkTurma', links =>
            links.map(link => {
                const onclick = link.getAttribute('onclick');
                const matchCodigo = onclick.match(/'([^']+)':'([^']+)'/);
                const matchFrontEnd = onclick.match(/'frontEndIdTurma':'([^']+)'/);
                return {
                    nome: link.innerText.trim(),
                    codigo: matchCodigo ? matchCodigo[2] : null,
                    frontEndIdTurma: matchFrontEnd ? matchFrontEnd[1] : null
                };
            })
        );

        for (let i = 0; i < disciplinasCodigos.length; i++) {
            const disciplina = disciplinasCodigos[i];
            let avisos = [];
            let frequencia = [];
            let numeroAulasDefinidas = null;
            let porcentagemFrequencia = null;
            let notasHeaders = [];
            let notas = [];
            let avaliacoes = [];

            try {
                if (i !== 0) {
                    // Troca para a disciplina usando jsfcljs
                    await page.evaluate(({ codigo, frontEndIdTurma }) => {
                        if (typeof jsfcljs === 'function') {
                            jsfcljs(
                                document.getElementById('formTurma'),
                                { [codigo]: codigo, frontEndIdTurma },
                                ''
                            );
                        }
                    }, { codigo: disciplina.codigo, frontEndIdTurma: disciplina.frontEndIdTurma });

                    await page.waitForSelector('.menu-direita', { timeout: 15000 });
                }

                // Coleta avisos
                avisos = await page.$$eval('.menu-direita > li', items => {
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

                let frequenciaNaoLancada = false;
                let tabelaFrequenciaVisivel = false;
                try {
                    await Promise.race([
                        page.waitForSelector('fieldset > span', { timeout: 15000 }),
                        page.waitForSelector('fieldset > table', { timeout: 15000 })
                    ]);
                    frequenciaNaoLancada = await page.evaluate(() => {
                        const span = Array.from(document.querySelectorAll('fieldset > span')).find(el =>
                            el.innerText.includes('A frequência ainda não foi lançada.')
                        );
                        return !!span;
                    });
                    tabelaFrequenciaVisivel = await page.$('fieldset > table') !== null;
                } catch (e) {}

                if (frequenciaNaoLancada) {
                    disciplinasComAvisos.push({
                        ...disciplina,
                        avisos,
                        frequencia: [],
                        numeroAulasDefinidas: null,
                        porcentagemFrequencia: null,
                        notas: {
                            headers: [],
                            valores: [],
                            avaliacoes: [],
                            mensagem: 'Ainda não foram lançadas notas.'
                        },
                        mensagem: 'A frequência ainda não foi lançada.'
                    });
                    continue;
                }

                if (!tabelaFrequenciaVisivel) {
                    await page.waitForSelector('fieldset > table', { timeout: 15000 });
                }

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

                // Aguarda ou a mensagem de notas não lançadas OU a tabela aparecer, o que vier primeiro
                let notasNaoLancadas = false;
                let tabelaNotasVisivel = false;
                try {
                    await Promise.race([
                        page.waitForSelector('ul.warning li', { timeout: 5000 }),
                        page.waitForSelector('table.tabelaRelatorio', { timeout: 5000 })
                    ]);
                    notasNaoLancadas = await page.evaluate(() => {
                        const li = Array.from(document.querySelectorAll('ul.warning li')).find(el =>
                            el.innerText.includes('Ainda não foram lançadas notas.')
                        );
                        return !!li;
                    });
                    tabelaNotasVisivel = await page.$('table.tabelaRelatorio') !== null;
                } catch (e) {}

                if (notasNaoLancadas) {
                    disciplinasComAvisos.push({
                        ...disciplina,
                        avisos,
                        frequencia,
                        numeroAulasDefinidas,
                        porcentagemFrequencia,
                        notas: {
                            headers: [],
                            valores: [],
                            avaliacoes: [],
                            mensagem: 'Ainda não foram lançadas notas.'
                        }
                    });
                    // Volta para a tela de disciplinas, pois a aba de notas é uma página à parte
                    await page.goBack();
                    continue;
                }

                if (!tabelaNotasVisivel) {
                    try {
                        await page.waitForSelector('table.tabelaRelatorio', { timeout: 3000 });
                    } catch (e) {}
                }

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

                disciplinasComAvisos.push({
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
                });

                // Volta para a tela de disciplinas, pois a aba de notas é uma página à parte
                await page.goBack();

            } catch (e) {
                disciplinasComAvisos.push({ ...disciplina, avisos: [], frequencia: [], erro: e.message });
                // Se der erro na página de notas, tente voltar para a tela de disciplinas
                try { await page.goBack(); } catch {}
            }
        }
        console.timeEnd('avisos');

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