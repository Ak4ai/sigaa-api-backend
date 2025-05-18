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

                const xpath = `//form[contains(@id,"form_acessarTurmaVirtual")]//a[contains(text(),"${disciplina.disciplina}")]`;
                const linkHandle = await page.evaluateHandle((xpath) => {
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

                    // Aguarda a tabela de frequência aparecer
                    const freqTableAppeared = await page.waitForSelector('fieldset > table', { timeout: 7000 }).then(() => true).catch(() => false);
                    console.log(`[${disciplina.disciplina}] Tabela de frequência visível?`, freqTableAppeared);

                    if (!freqTableAppeared) {
                        // Procura e joga no console o elemento do menu "Frequência" (com id dinâmico)
                        const freqMenuHtml = await page.evaluate(() => {
                            const a = Array.from(document.querySelectorAll('a')).find(a =>
                                a.querySelector('.itemMenu')?.innerText.trim() === 'Frequência'
                            );
                            return a ? a.outerHTML : 'Elemento <a> do menu Frequência não encontrado';
                        });
                        console.warn(`[${disciplina.disciplina}] HTML do link Frequência:\n`, freqMenuHtml);
                    }

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

                    // Adicione o resultado ao array
                    disciplinasComAvisos.push({
                        ...disciplina,
                        avisos,
                        frequencia,
                        numeroAulasDefinidas,
                        porcentagemFrequencia
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