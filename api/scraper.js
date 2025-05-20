const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const { interpretSchedule, gerarTabelaSimplificada } = require('./scheduleParser');
const { delay } = require('./constants');
const { validarTokenLogin } = require('./auth');

const { Sema } = require('async-sema');
const sema = new Sema(3); // Limite de 2 tarefas

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

        await Promise.all(
            schedule.map(async (disciplina) => {
                await sema.acquire();
                let pageDisciplina;
                try {
                    pageDisciplina = await browser.newPage();
                    await pageDisciplina.setViewport({ width: 1024, height: 600 });
                    await pageDisciplina.setRequestInterception(true);
                    pageDisciplina.on('request', (req) => {
                        const type = req.resourceType();
                        if (['stylesheet', 'font', 'image'].includes(type)) {
                            req.abort();
                        } else {
                            req.continue();
                        }
                    });

                    // Repita o login para cada aba
                    await pageDisciplina.goto('https://sig.cefetmg.br/sigaa/verTelaLogin.do', {
                        waitUntil: 'domcontentloaded',
                        timeout: 60000,
                    });
                    await pageDisciplina.type('#conteudo input[type=text]', user);
                    await pageDisciplina.type('#conteudo input[type=password]', pass);
                    await Promise.all([
                        pageDisciplina.click('#conteudo input[type=submit]'),
                        pageDisciplina.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
                    ]);

                    await pageDisciplina.goto('https://sig.cefetmg.br/sigaa/portais/discente/discente.jsf', {
                        waitUntil: 'domcontentloaded',
                        timeout: 15000,
                    });

                    // --- DECLARE AS VARIÁVEIS AQUI ---
                    let avisos = [];
                    let frequencia = [];
                    let numeroAulasDefinidas = null;
                    let porcentagemFrequencia = null;
                    let notasHeaders = [];
                    let notas = [];
                    let avaliacoes = [];

                    // Coleta avisos
                    avisos = await pageDisciplina.$$eval('.menu-direita > li', items => {
                        return items.map(li => ({
                            data: li.querySelector('.data')?.innerText.trim(),
                            descricao: li.querySelector('.descricao')?.innerText.trim()
                        }));
                    });

                    console.log(`[${disciplina.disciplina}] Procurando link 'Frequência' no menu...`);

                    const frequenciaInfo = 'formMenu:j_id_jsp_311393315_97';
                    console.log(`[${disciplina.disciplina}] Código ESTÁTICO do menu 'Frequência':`, frequenciaInfo);
                    
                    await pageDisciplina.evaluate((codigo) => {
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
                    await pageDisciplina.waitForSelector('fieldset', { timeout: 7000 });

                    // Verifica se existe a mensagem de frequência não lançada
                    const frequenciaNaoLancada = await pageDisciplina.evaluate(() => {
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
                        return; // Pula para a próxima disciplina
                    }

                    // Se não encontrou a mensagem, aguarda a tabela normalmente
                    await pageDisciplina.waitForSelector('fieldset > table', { timeout: 15000 });
                    console.log(`[${disciplina.disciplina}] Tabela de frequência visível!`);

                    // Coleta a tabela de frequência
                    console.log(`[${disciplina.disciplina}] Coletando tabela de frequência...`);
                    frequencia = await pageDisciplina.$$eval(
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
                    numeroAulasDefinidas = await pageDisciplina.$eval('.botoes-show', el => {
                        const match = el.innerText.match(/Número de Aulas definidas pela CH do Componente:\s*(\d+)/i);
                        return match ? parseInt(match[1], 10) : null;
                    });
                    console.log(`[${disciplina.disciplina}] Número de aulas definidas:`, numeroAulasDefinidas);

                    // (Opcional) Coleta a porcentagem de frequência
                    porcentagemFrequencia = await pageDisciplina.$eval('.botoes-show', el => {
                        const match = el.innerText.match(/Porcentagem de Frequência em relação a CH:\s*(\d+)%/i);
                        return match ? parseInt(match[1], 10) : null;
                    });
                    console.log(`[${disciplina.disciplina}] Porcentagem de frequência:`, porcentagemFrequencia);

                    // Busca o elemento <a> do menu "Ver Notas" e extrai o parâmetro dinâmico do onclick
                    const notasInfo = await pageDisciplina.evaluate(() => {
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
                    
                    await pageDisciplina.evaluate((codigo) => {
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
                    // Aguarda a tabela de notas aparecer, mas tenta processar mesmo se não aparecer
                    try {
                        await pageDisciplina.waitForSelector('table.tabelaRelatorio', { timeout: 3000 });
                        console.log(`[${disciplina.disciplina}] Tabela de notas visível!`);
                    } catch (e) {
                        console.warn(`[${disciplina.disciplina}] Tabela de notas não visível dentro do tempo limite.`);
                    }

                    // Tenta extrair os dados da tabela de notas, mesmo que não tenha sido encontrada
                    try {
                        notasHeaders = await pageDisciplina.$$eval('table.tabelaRelatorio thead tr#trAval th', ths =>
                            ths.map(th => th.innerText.trim()).filter(Boolean)
                        );
                        notas = await pageDisciplina.$$eval('table.tabelaRelatorio tbody tr', rows =>
                            rows.map(tr => {
                                const tds = Array.from(tr.querySelectorAll('td'));
                                return tds.map(td => td.innerText.trim());
                            })
                        );
                        // Captura nota, peso e den dos inputs escondidos do tr#trAval
                        avaliacoes = await pageDisciplina.$$eval('table.tabelaRelatorio thead tr#trAval th[id^="aval_"]', ths =>
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
                } catch (e) {
                    console.warn(`Erro ao processar ${disciplina.disciplina}:`, e.message);
                    disciplinasComAvisos.push({ ...disciplina, avisos: [], frequencia: [], erro: e.message });
                } finally {
                    if (pageDisciplina) await pageDisciplina.close();
                    sema.release();
                }
            })
        );

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