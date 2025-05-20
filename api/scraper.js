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
            if (['stylesheet', 'font', 'image'].includes(type)) {
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
        for (const disciplina of schedule) {
            try {
                await page.goto('https://sig.cefetmg.br/sigaa/portais/discente/discente.jsf', {
                    waitUntil: 'domcontentloaded',
                    timeout: 15000,
                });

                const xpath = `//form[contains(@id,"form_acessarTurmaVirtual")]//a[normalize-space(text())="${disciplina.disciplina}"]`;                const linkHandle = await page.evaluateHandle((xpath) => {
                    const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    return result.singleNodeValue;
                }, xpath);

                if (linkHandle) {
                    console.log(`[${disciplina.disciplina}] Link encontrado, tentando entrar na página da matéria...`);
                    await Promise.all([
                        linkHandle.click(),
                        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 })
                    ]);
                    console.log(`[${disciplina.disciplina}] Entrou na página da matéria com sucesso!`);

                    await page.waitForSelector('.menu-direita', { timeout: 7000 });

                    // Coleta avisos
                    const avisos = await page.$$eval('.menu-direita > li', items => {
                        return items.map(li => ({
                            data: li.querySelector('.data')?.innerText.trim(),
                            descricao: li.querySelector('.descricao')?.innerText.trim()
                        }));
                    });

                    console.log(`[${disciplina.disciplina}] Procurando link 'Frequência' no menu...`);

                    // Busca o elemento <a> do menu "Frequência" e extrai o parâmetro dinâmico do onclick
                    const frequenciaInfo = 'formMenu:j_id_jsp_311393315_97';
                    console.log(`[${disciplina.disciplina}] Usando código estático do menu 'Frequência':`, frequenciaInfo);

                    await page.evaluate((codigo) => {
                        if (typeof jsfcljs === 'function') {
                            jsfcljs(
                                document.getElementById('formMenu'),
                                { [codigo]: codigo },
                                ''
                            );
                        }
                    }, frequenciaInfo);

                    console.log(`[${disciplina.disciplina}] jsfcljs chamado com código dinâmico, aguardando mudança na página...`);

                    // Aguarda o fieldset aparecer (onde pode estar a mensagem ou a tabela)
                    await page.waitForSelector('fieldset', { timeout: 7000 });

                    // Espera ou a mensagem de frequência não lançada OU a tabela aparecerem, o que vier primeiro
                    let frequenciaNaoLancada = false;
                    try {
                        await Promise.race([
                            page.waitForSelector('fieldset > span', { timeout: 15000 }),
                            page.waitForSelector('fieldset > table', { timeout: 15000 })
                        ]);
                        // Verifica se a mensagem apareceu
                        frequenciaNaoLancada = await page.evaluate(() => {
                            const span = Array.from(document.querySelectorAll('fieldset > span')).find(el =>
                                el.innerText.includes('A frequência ainda não foi lançada.')
                            );
                            return !!span;
                        });
                    } catch (e) {
                        // Nenhum dos dois apareceu, pode tratar como erro ou seguir conforme necessário
                        console.warn(`[${disciplina.disciplina}] Nem mensagem nem tabela de frequência apareceram.`);
                    }

                    if (frequenciaNaoLancada) {
                        console.log(`[${disciplina.disciplina}] Frequência ainda não foi lançada.`);
                        disciplinasComAvisos.push({
                            ...disciplina,
                            avisos,
                            frequencia: [],
                            numeroAulasDefinidas: null,
                            porcentagemFrequencia: null,
                            mensagem: 'A frequência ainda não foi lançada.'
                        });
                        continue; // Pula para a próxima disciplina
                    }

                    // Se não encontrou a mensagem, aguarda a tabela normalmente (caso não tenha aparecido ainda)
                    await page.waitForSelector('fieldset > table', { timeout: 15000 });
                    console.log(`[${disciplina.disciplina}] Tabela de frequência visível!`);

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

                    // Busca o elemento <a> do menu "Ver Notas" e extrai o parâmetro dinâmico do onclick
                    const notasInfo = 'formMenu:j_id_jsp_122142787_99';
                    console.log(`[${disciplina.disciplina}] Usando código estático do menu 'Notas':`, notasInfo);

                    await page.evaluate((codigo) => {
                        if (typeof jsfcljs === 'function') {
                            jsfcljs(
                                document.getElementById('formMenu'),
                                { [codigo]: codigo },
                                ''
                            );
                        }
                    }, notasInfo);


                    console.log(`[${disciplina.disciplina}] jsfcljs chamado com código dinâmico para 'Notas', aguardando mudança na página...`);

                    // Aguarda ou a mensagem de notas não lançadas OU a tabela aparecer, o que vier primeiro
                    let notasNaoLancadas = false;
                    try {
                        await Promise.race([
                            page.waitForSelector('ul.warning li', { timeout: 5000 }),
                            page.waitForSelector('table.tabelaRelatorio', { timeout: 5000 })
                        ]);
                        // Verifica se a mensagem apareceu
                        notasNaoLancadas = await page.evaluate(() => {
                            const li = Array.from(document.querySelectorAll('ul.warning li')).find(el =>
                                el.innerText.includes('Ainda não foram lançadas notas.')
                            );
                            return !!li;
                        });
                    } catch (e) {
                        console.warn(`[${disciplina.disciplina}] Nem mensagem nem tabela de notas apareceram.`);
                    }

                    if (notasNaoLancadas) {
                        console.log(`[${disciplina.disciplina}] Ainda não foram lançadas notas.`);
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
                        continue; // Pula para a próxima disciplina
                    }

                    // Se não encontrou a mensagem, aguarda a tabela normalmente (caso não tenha aparecido ainda)
                    try {
                        await page.waitForSelector('table.tabelaRelatorio', { timeout: 3000 });
                        console.log(`[${disciplina.disciplina}] Tabela de notas visível!`);
                    } catch (e) {
                        console.warn(`[${disciplina.disciplina}] Tabela de notas não visível dentro do tempo limite.`);
                    }

                    // Tenta extrair os dados da tabela de notas, mesmo que não tenha sido encontrada
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
                        console.warn(`[${disciplina.disciplina}] Falha ao coletar dados da tabela de notas:`, e.message);
                    }

                    // Adicione o resultado ao array
                    disciplinasComAvisos.push({
                        ...disciplina,
                        avisos,
                        frequencia,
                        numeroAulasDefinidas,
                        porcentagemFrequencia,
                        notas: {
                            headers: notasHeaders,
                            valores: notas,
                            avaliacoes // Inclui os detalhes das avaliações
                        }
                    });
                }
            } catch (e) {
                console.warn(`Erro ao processar ${disciplina.disciplina}:`, e.message);
                disciplinasComAvisos.push({ ...disciplina, avisos: [], frequencia: [], erro: e.message });
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