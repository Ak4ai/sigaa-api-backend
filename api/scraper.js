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

        // Defina o prefixo fixo conforme o padrão desejado
        const codigoPrefixo = 'formTurma:j_id_jsp_122142787_7';

        // Coleta os códigos das disciplinas
        const disciplinasCodigos = await page.$$eval('#formTurma a.linkTurma', (links, codigoPrefixo) =>
            links.map((link, idx) => {
                const onclick = link.getAttribute('onclick');
                const matchFrontEnd = onclick.match(/'frontEndIdTurma':'([^']+)'/);
                // Gera o código conforme o padrão fixo
                let codigo = idx === 0
                    ? codigoPrefixo
                    : `${codigoPrefixo}j_id_${idx}`;
                return {
                    nome: link.innerText.trim(),
                    codigo,
                    frontEndIdTurma: matchFrontEnd ? matchFrontEnd[1] : null
                };
            }),
            codigoPrefixo
        );

        console.log('Disciplinas encontradas:', disciplinasCodigos);

        // Função para limpar o nome da disciplina
        function limparNomeDisciplina(nomeCompleto) {
            // Remove código do início e semestre/fim do final
            // Exemplo: 'G05BDAD1.02 - BANCO DE DADOS I (60h) (2025.1)' => 'BANCO DE DADOS I'
            return nomeCompleto
                .replace(/^[^-\–]+[-\–]\s*/, '') // Remove código e traço do início
                .replace(/\s*\(\d+h\)\s*\(\d{4}\.\d\)$/i, '') // Remove (60h) (2025.1) do final
                .trim();
        }

        for (let i = 0; i < disciplinasCodigos.length; i++) {
            let avisos = [];
            let frequencia = [];
            let numeroAulasDefinidas = null;
            let porcentagemFrequencia = null;
            let notasHeaders = [];
            let notas = [];
            let avaliacoes = [];
            let nomeDisciplinaAtual = '';

            console.log(`[${i + 1}/${disciplinasCodigos.length}] Acessando disciplina: ${disciplinasCodigos[i].nome}`);

            try {
                if (i !== 0) {
                    // Verifica e loga o conteúdo do legend antes de trocar de disciplina
                    const legendText = await page.$eval(
                        '#j_id_jsp_122142787_297 > fieldset > legend',
                        el => el.innerText.trim()
                    );
                    console.log(`[DEBUG] Legend atual antes de trocar disciplina: "${legendText}"`);

                    if (legendText !== 'Mapa de Frequências') {
                        console.log('[DEBUG] Atenção: a aba atual não é "Mapa de Frequências"!');
                    }

                    // ...troca de disciplina...
                    const nomeAnterior = limparNomeDisciplina(
                        await page.$eval('#linkNomeTurma', el => el.innerText.trim())
                    );
                    console.log(`[DEBUG] Nome anterior no DOM: "${nomeAnterior}"`);
                    console.log(`[DEBUG] Nome esperado para a próxima disciplina: "${limparNomeDisciplina(disciplinasCodigos[i].nome)}"`);

                    await page.evaluate(({ codigo, frontEndIdTurma }) => {
                        if (typeof jsfcljs === 'function') {
                            const params = {};
                            params[codigo] = codigo;
                            params['frontEndIdTurma'] = frontEndIdTurma;
                            jsfcljs(
                                document.getElementById('formTurma'),
                                params,
                                ''
                            );
                        }
                    }, { codigo: disciplinasCodigos[i].codigo, frontEndIdTurma: disciplinasCodigos[i].frontEndIdTurma });

                    console.log(`[DEBUG] Aguardando atualização do nome da disciplina no DOM...`);
                    try {
                        await page.waitForFunction(
                            (nomeEsperado, limparNomeDisciplinaStr) => {
                                const limparNomeDisciplina = new Function('nomeCompleto', limparNomeDisciplinaStr);
                                const el = document.querySelector('#linkNomeTurma');
                                if (!el) {
                                    window._sigaaDebugLastNome = '[Elemento não encontrado]';
                                    return false;
                                }
                                const nomeAtual = limparNomeDisciplina(el.innerText.trim());
                                window._sigaaDebugLastNome = nomeAtual;
                                return nomeAtual === nomeEsperado;
                            },
                            { timeout: 15000 },
                            limparNomeDisciplina(disciplinasCodigos[i].nome),
                            limparNomeDisciplina.toString()
                        );
                        // Sucesso: log normalmente
                        const nomeAchado = await page.evaluate(() => window._sigaaDebugLastNome);
                        console.log(`[DEBUG] Nome encontrado no DOM após troca: "${nomeAchado}"`);
                        console.log(`[DEBUG] Comparação: "${nomeAchado}" === "${limparNomeDisciplina(disciplinasCodigos[i].nome)}"`);
                    } catch (e) {
                        // Timeout: log o último nome encontrado
                        const nomeAchado = await page.evaluate(() => window._sigaaDebugLastNome);
                        console.log(`[ERRO] Timeout ao aguardar troca de disciplina! Último nome encontrado: "${nomeAchado}"`);
                        console.log(`[ERRO] Comparação: "${nomeAchado}" === "${limparNomeDisciplina(disciplinasCodigos[i].nome)}"`);
                        throw e; // Se quiser continuar o erro, ou trate conforme necessário
                    }

                    // Após o waitForFunction, logue o último nome encontrado no DOM
                    const nomeAchado = await page.evaluate(() => window._sigaaDebugLastNome);
                    console.log(`[DEBUG] Nome encontrado no DOM após troca: "${nomeAchado}"`);
                    console.log(`[DEBUG] Comparação: "${nomeAchado}" === "${limparNomeDisciplina(disciplinasCodigos[i].nome)}"`);

                    console.log(`[${limparNomeDisciplina(disciplinasCodigos[i].nome)}] Aguardando menu-direita`);
                    await page.waitForSelector('.menu-direita', { timeout: 15000 });
                }

                try {
                    nomeDisciplinaAtual = limparNomeDisciplina(
                        await page.$eval('#linkNomeTurma', el => el.innerText.trim())
                    );
                    console.log(`[${nomeDisciplinaAtual}] Nome da disciplina acessada`);
                } catch {
                    try {
                        nomeDisciplinaAtual = limparNomeDisciplina(
                            await page.$eval('.descricao-disciplina, .disciplina, .titulo-disciplina, .subtitulo', el => el.innerText.trim())
                        );
                    } catch {
                        // fallback para o nome salvo no array, se não encontrar no DOM
                        nomeDisciplinaAtual = limparNomeDisciplina(disciplinasCodigos[i].nome);
                    }
                }

                // ... restante do seu código, substitua disciplina.nome por nomeDisciplinaAtual ...

                console.log(`[${nomeDisciplinaAtual}] Coletando avisos`);
                avisos = await page.$$eval('.menu-direita > li', items => {
                    return items.map(li => ({
                        data: li.querySelector('.data')?.innerText.trim(),
                        descricao: li.querySelector('.descricao')?.innerText.trim()
                    }));
                });

                // Frequência
                const frequenciaInfo = 'formMenu:j_id_jsp_311393315_97';
                console.log(`[${nomeDisciplinaAtual}] Acessando frequência`);
                await page.evaluate((codigo) => {
                    if (typeof jsfcljs === 'function') {
                        jsfcljs(
                            document.getElementById('formMenu'),
                            { [codigo]: codigo },
                            ''
                        );
                    }
                }, frequenciaInfo);

                console.log(`[${nomeDisciplinaAtual}] Aguardando fieldset de frequência`);
                await page.waitForSelector('fieldset', { timeout: 7000 });

                let frequenciaNaoLancada = false;
                let tabelaFrequenciaVisivel = false;
                try {
                    console.log(`[${nomeDisciplinaAtual}] Verificando se frequência foi lançada`);
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
                } catch (e) {
                    console.log(`[${nomeDisciplinaAtual}] Erro ao verificar frequência: ${e.message}`);
                }

                if (frequenciaNaoLancada) {
                    console.log(`[${nomeDisciplinaAtual}] Frequência ainda não lançada`);
                    disciplinasComAvisos.push({
                        disciplina: nomeDisciplinaAtual,
                        ...disciplinasCodigos[i],
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
                    console.log(`[${nomeDisciplinaAtual}] Aguardando tabela de frequência`);
                    await page.waitForSelector('fieldset > table', { timeout: 15000 });
                }

                console.log(`[${nomeDisciplinaAtual}] Coletando frequência`);
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

                console.log(`[${nomeDisciplinaAtual}] Coletando número de aulas definidas`);
                numeroAulasDefinidas = await page.$eval('.botoes-show', el => {
                    const match = el.innerText.match(/Número de Aulas definidas pela CH do Componente:\s*(\d+)/i);
                    return match ? parseInt(match[1], 10) : null;
                });

                console.log(`[${nomeDisciplinaAtual}] Coletando porcentagem de frequência`);
                porcentagemFrequencia = await page.$eval('.botoes-show', el => {
                    const match = el.innerText.match(/Porcentagem de Frequência em relação a CH:\s*(\d+)%/i);
                    return match ? parseInt(match[1], 10) : null;
                });

                // Notas
                const notasInfo = 'formMenu:j_id_jsp_122142787_99';
                console.log(`[${nomeDisciplinaAtual}] Acessando notas`);
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
                    console.log(`[${nomeDisciplinaAtual}] Verificando se notas foram lançadas`);
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
                } catch (e) {
                    console.log(`[${nomeDisciplinaAtual}] Erro ao verificar notas: ${e.message}`);
                }

                if (notasNaoLancadas) {
                    console.log(`[${nomeDisciplinaAtual}] Notas ainda não lançadas`);
                    disciplinasComAvisos.push({
                        disciplina: nomeDisciplinaAtual,
                        ...disciplinasCodigos[i],
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
                    console.log(`[${nomeDisciplinaAtual}] Nao voltando para tela de disciplinas`);
                    //await page.goBack();
                    continue;
                }

                if (!tabelaNotasVisivel) {
                    try {
                        console.log(`[${nomeDisciplinaAtual}] Aguardando tabela de notas`);
                        await page.waitForSelector('table.tabelaRelatorio', { timeout: 3000 });
                    } catch (e) {
                        console.log(`[${nomeDisciplinaAtual}] Erro ao aguardar tabela de notas: ${e.message}`);
                    }
                }

                try {
                    console.log(`[${nomeDisciplinaAtual}] Coletando cabeçalhos de notas`);
                    notasHeaders = await page.$$eval('table.tabelaRelatorio thead tr#trAval th', ths =>
                        ths.map(th => th.innerText.trim()).filter(Boolean)
                    );
                    console.log(`[${nomeDisciplinaAtual}] Coletando valores de notas`);
                    notas = await page.$$eval('table.tabelaRelatorio tbody tr', rows =>
                        rows.map(tr => {
                            const tds = Array.from(tr.querySelectorAll('td'));
                            return tds.map(td => td.innerText.trim());
                        })
                    );
                    console.log(`[${nomeDisciplinaAtual}] Coletando avaliações`);
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
                } catch (e) {
                    console.log(`[${nomeDisciplinaAtual}] Erro ao coletar notas: ${e.message}`);
                }

                disciplinasComAvisos.push({
                    disciplina: nomeDisciplinaAtual,
                    ...disciplinasCodigos[i],
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
                console.log(`[${nomeDisciplinaAtual}] Voltando para tela de disciplinas`);
                //await page.goBack();

            } 
            catch (e) {
                console.log(`[${nomeDisciplinaAtual}] Erro geral: ${e.message}`);
                disciplinasComAvisos.push({ disciplina: nomeDisciplinaAtual, ...disciplinasCodigos[i], avisos: [], frequencia: [], erro: e.message });
                // Se der erro na página de notas, tente voltar para a tela de disciplinas
                try { 
                    console.log(`[${nomeDisciplinaAtual}] Tentando voltar para tela de disciplinas após erro`);
                    //await page.goBack(); 
                } catch {}
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