const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const { interpretSchedule, gerarTabelaSimplificada } = require('./scheduleParser');
const { delay } = require('./constants');
const { validarTokenLogin } = require('./auth');

// ...existing code...
let pLimit;
(async () => {
    pLimit = (await import('p-limit')).default;
})();
// ...existing code...

const limit = pLimit(2); // Limite de 2 tarefas em paralelo

// ...existing code...
(async () => {
    pLimit = (await import('p-limit')).default;
    const limit = pLimit(2); // Limite de 2 tarefas em paralelo

    // Função assíncrona simulada
    async function tarefa(id) {
        console.log(`Iniciando tarefa ${id}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log(`Finalizando tarefa ${id}`);
        return id;
    }

    // Cria 5 tarefas limitadas pelo p-limit
    async function teste() {
        const resultados = await Promise.all(
            [1, 2, 3, 4, 5].map(i => limit(() => tarefa(i)))
        );
        console.log('Resultados:', resultados);
    }

    await teste();
})();
// ...existing code...

teste();

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
                    const frequenciaInfo = await page.evaluate(() => {
                        const a = Array.from(document.querySelectorAll('a')).find(a =>
                            a.querySelector('.itemMenu')?.innerText.trim() === 'Frequência'
                        );
                        if (!a) return null;
                        const onclick = a.getAttribute('onclick');
                        // Extrai o parâmetro dinâmico do jsfcljs
                        const match = onclick && onclick.match(/jsfcljs\(.*,\s*\{['"]([^'"]+)['"]:/);
                        console.log('onclick:', onclick);
                        return match ? match[1] : null;
                    });

                    if (!frequenciaInfo) {
                        throw new Error("Não foi possível encontrar o código dinâmico do menu 'Frequência'.");
                    }

                    console.log(`[${disciplina.disciplina}] Código dinâmico do menu 'Frequência':`, frequenciaInfo);

                    // Agora chama jsfcljs usando o código dinâmico encontrado
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

                    // Verifica se existe a mensagem de frequência não lançada
                    const frequenciaNaoLancada = await page.evaluate(() => {
                        const span = Array.from(document.querySelectorAll('fieldset > span')).find(el =>
                            el.innerText.includes('A frequência ainda não foi lançada.')
                        );
                        return !!span;
                    });

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

                    // Se não encontrou a mensagem, aguarda a tabela normalmente
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
                    const notasInfo = await page.evaluate(() => {
                        const a = Array.from(document.querySelectorAll('a')).find(a =>
                            a.querySelector('.itemMenu')?.innerText.trim() === 'Ver Notas'
                        );
                        if (!a) return null;
                        const onclick = a.getAttribute('onclick');
                        // Extrai o parâmetro dinâmico do jsfcljs
                        const match = onclick && onclick.match(/jsfcljs\(.*,\s*\{['"]([^'"]+)['"]:/);
                        return match ? match[1] : null;
                    });
                    
                    if (!notasInfo) {
                        throw new Error("Não foi possível encontrar o código dinâmico do menu 'Ver Notas'.");
                    }
                    
                    console.log(`[${disciplina.disciplina}] Código dinâmico do menu 'Notas':`, notasInfo);
                    
                    // Agora chama jsfcljs usando o código dinâmico encontrado
                    
                    await page.evaluate((codigo) => {
                        console.log('Chamando jsfcljs com código dinâmico para Notas:', codigo);
                        if (typeof jsfcljs === 'function') {
                            jsfcljs(
                                document.getElementById('formMenu'),
                                { [codigo]: codigo },
                                ''
                            );
                        }
                    }, notasInfo);

                    console.log(`[${disciplina.disciplina}] jsfcljs chamado com código dinâmico para 'Notas', aguardando mudança na página...`);

                    let notasNaoLancadas = false;
                    try {
                        // Espera o que aparecer primeiro: a mensagem ou a tabela
                        await Promise.race([
                            page.waitForFunction(() => {
                                const li = document.evaluate(
                                    "/html/body/div[1]/div[7]/div/div/ul/li",
                                    document,
                                    null,
                                    XPathResult.FIRST_ORDERED_NODE_TYPE,
                                    null
                                ).singleNodeValue;
                                return li && li.innerText.includes("Ainda não foram lançadas notas.");
                            }, { timeout: 3000 }).then(() => {
                                notasNaoLancadas = true;
                                console.log(`[${disciplina.disciplina}] Mensagem de notas não lançadas encontrada.`);
                            }),
                            page.waitForSelector('table.tabelaRelatorio', { timeout: 3000 }).then(() => {
                                console.log(`[${disciplina.disciplina}] Tabela de notas visível!`);
                            })
                        ]);
                    } catch (e) {
                        // Nenhum dos dois apareceu no tempo limite
                        console.warn(`[${disciplina.disciplina}] Nem mensagem nem tabela de notas apareceram no tempo limite.`);
                    }

                    let notasHeaders = [];
                    let notas = [];
                    let avaliacoes = [];
                    if (!notasNaoLancadas) {
                        // Extrai os dados da tabela normalmente
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
                            console.log(`[${disciplina.disciplina}] Notas coletadas:`, { headers: notasHeaders, notas, avaliacoes });
                        } catch (e) {
                            console.warn(`[${disciplina.disciplina}] Falha ao coletar dados da tabela de notas:`, e.message);
                        }
                    } else {
                        // Não há notas lançadas
                        notasHeaders = [];
                        notas = [];
                        avaliacoes = [];
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