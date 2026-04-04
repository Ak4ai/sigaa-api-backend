// scraper.js — implementação axios+cheerio substituindo Puppeteer
// Mantém exatamente o mesmo contrato de resposta JSON:
// { dadosInstitucionais, horariosDetalhados, horariosSimplificados, avisosPorDisciplina }
//
// Fluxo:
// 1. GET  /sigaa/logar.do?dispatch=logOff          → página de login
// 2. POST /sigaa/logar.do?dispatch=logOn            → login
// 3. GET  /sigaa/portais/discente/discente.jsf      → portal (67KB) → dadosInstitucionais, horarios, turmas
// 4. Para cada turma:
//    a. POST discente.jsf com idTurma               → AVA (94–129KB) → avisos, formMenuId, avaViewState
//    b. POST /sigaa/ava/index.jsf  _95              → frequência → frequencia[], numeroAulasDefinidas, %
//    c. POST /sigaa/ava/index.jsf  _97              → notas      → headers, notas, avaliacoes[]

const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { load } = require('cheerio');
const { URLSearchParams } = require('url');
const https = require('https');
const { interpretSchedule, gerarTabelaSimplificada } = require('./scheduleParser');
const { validarTokenLogin } = require('./auth');

const BASE_URL = 'https://sig.cefetmg.br';

const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'pt-BR,pt;q=0.9',
    'Content-Type': 'application/x-www-form-urlencoded',
};

// ── Helpers de extração ─────────────────────────────────────────────────────

function extractHiddenFields(html) {
    const $ = load(html);
    const fields = {};
    $('input[type="hidden"]').each((_, el) => {
        const name = $(el).attr('name');
        const value = $(el).attr('value') ?? '';
        if (name) fields[name] = value;
    });
    return fields;
}

function extractTurmas(html) {
    const turmas = [];
    const pattern = /'idTurma':'(\d+)'[^}]*}\s*,\s*''\s*\)\s*;\s*\}\s*return[^>]*>([^<]+)</g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
        turmas.push({ idTurma: match[1], nome: match[2].trim() });
    }
    const seen = new Set();
    return turmas.filter(t => {
        if (seen.has(t.idTurma)) return false;
        seen.add(t.idTurma);
        return true;
    });
}

function extractFormAtualizacoesTurmasId(html) {
    const match = html.match(/formAtualizacoesTurmas:(j_id_jsp_\d+_\d+)['":]/);
    return match ? match[1] : null;
}

function extractFormMenuAvaId(html) {
    const match = html.match(/id="formMenu:j_id_jsp_(\d+)_69"/);
    if (match) return match[1];
    const match2 = html.match(/formMenu:j_id_jsp_(\d+)_69/);
    return match2 ? match2[1] : null;
}

// Extrai dadosInstitucionais de #agenda-docente e nome do usuário
function parseDadosInstitucionais(html) {
    const $ = load(html);
    const obj = {};

    $('#agenda-docente table tbody tr').each((_, row) => {
        const cols = $(row).find('td');
        if (cols.length === 2) {
            const key = $(cols[0]).text().replace(':', '').trim();
            const val = $(cols[1]).text().trim();
            if (key) obj[key] = val;
        }
    });

    const nomeUsuario = $('#info-usuario p.usuario span').first().text().trim();
    if (nomeUsuario) obj['Nome do Usuario'] = nomeUsuario;

    return obj;
}

// Extrai horários brutos para alimentar o scheduleParser (mesma estrutura que o Puppeteer produzia)
function parseScheduleRaw(html) {
    const $ = load(html);
    const data = [];
    let term = '';

    $('tbody tr').each((_, row) => {
        const $row = $(row);
        const span = $row.find('td[colspan]');

        if (span.length) {
            term = span.text().trim();
            return;
        }

        if ($row.find('form[id^="form_acessarTurmaVirtual"]').length) {
            const desc = $row.find('td.descricao');
            const name = desc.find('a').text().trim() || desc.text().trim();

            const infos = $row.find('td.info').map((_, td) => $(td).text().trim()).get();
            const turmaInfo = infos[0] || '';
            const rawCodes = (infos[1] || '').split('(')[0].trim();
            const sala = (infos[2] || '').trim();

            data.push({ semestre: term, disciplina: name, turma: turmaInfo, rawCodes, sala });
        }
    });

    return data;
}

// Extrai avisos do AVA (.menu-direita > li)
function parseAvisos(html) {
    const $ = load(html);
    const avisos = [];
    $('.menu-direita > li').each((_, li) => {
        avisos.push({
            data: $(li).find('.data').text().trim() || undefined,
            descricao: $(li).find('.descricao').text().trim() || undefined,
        });
    });
    return avisos;
}

// Extrai registros de frequência (tr.linhaImpar / tr.linhaPar com data DD/MM/YYYY)
function parseFrequencia(html) {
    const $ = load(html);
    const registros = [];
    $('tr.linhaImpar, tr.linhaPar').each((_, row) => {
        const tds = $(row).find('td');
        if (tds.length >= 2) {
            const data = $(tds[0]).text().trim();
            const status = $(tds[1]).text().trim();
            if (/\d{2}\/\d{2}\/\d{4}/.test(data) && status.length > 0) {
                registros.push({ data, status });
            }
        }
    });
    return registros;
}

// Extrai numeroAulasDefinidas e porcentagemFrequencia do bloco .botoes-show
function parseFrequenciaStats(html) {
    const $ = load(html);
    const texto = $('.botoes-show').text();

    const matchAulas = texto.match(/Número de Aulas definidas pela CH do Componente:\s*(\d+)/i);
    const matchPct   = texto.match(/Porcentagem de Frequência em relação a CH:\s*(\d+)%/i);

    return {
        numeroAulasDefinidas: matchAulas ? parseInt(matchAulas[1], 10) : null,
        porcentagemFrequencia: matchPct ? parseInt(matchPct[1], 10) : null,
    };
}

// Extrai notas — mesma estrutura { headers, valores, avaliacoes } que o Puppeteer produzia
function parseNotas(html) {
    const $ = load(html);

    // Verifica se a tabela de notas existe
    if (!$('table.tabelaRelatorio').length) return null;

    // Headers (abreviações das avaliações)
    const headers = [];
    $('table.tabelaRelatorio thead tr#trAval th').each((_, th) => {
        const text = $(th).text().trim();
        if (text) headers.push(text);
    });

    // Valores das linhas
    const valores = [];
    $('table.tabelaRelatorio tbody tr').each((_, row) => {
        const tds = $(row).find('td').map((_, td) => $(td).text().trim()).get();
        if (tds.length) valores.push(tds);
    });

    // Avaliações detalhadas (peso, nota máxima, abrev, denominação)
    const avaliacoes = [];
    $('table.tabelaRelatorio thead tr#trAval th[id^="aval_"]').each((_, th) => {
        const id = $(th).attr('id').replace('aval_', '');
        const abrev = $(`#abrevAval_${id}`).val() || $(th).text().trim();
        const den   = $(`#denAval_${id}`).val()   || abrev;
        const nota  = $(`#notaAval_${id}`).val()  || '';
        const peso  = $(`#pesoAval_${id}`).val()  || '';
        avaliacoes.push({ abrev, den, nota, peso });
    });

    return { headers, valores, avaliacoes };
}

// ── Handler principal ───────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    // Resolve credenciais (token JWT ou user/pass direto)
    let user, pass;
    if (req.body.token) {
        const payload = validarTokenLogin(req.body.token);
        if (!payload) return res.status(401).json({ error: 'Token inválido ou expirado.' });
        user = payload.user;
        pass = payload.pass;
    } else {
        user = req.body.user;
        pass = req.body.pass;
    }

    if (!user || !pass) return res.status(400).json({ error: 'Usuário e senha obrigatórios.' });

    const jar = new CookieJar();
    const client = axios.create({
        baseURL: BASE_URL,
        validateStatus: () => true,
        decompress: true,
        timeout: 30000,
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });

    // Gerencia cookies manualmente via interceptors
    client.interceptors.request.use(config => {
        const url = (config.baseURL || BASE_URL) + (config.url || '');
        const cookies = jar.getCookiesSync(url).map(c => c.cookieString()).join('; ');
        if (cookies) config.headers['Cookie'] = cookies;
        return config;
    });
    client.interceptors.response.use(response => {
        const setCookies = response.headers['set-cookie'];
        if (setCookies) {
            const url = (response.config.baseURL || BASE_URL) + (response.config.url || '');
            setCookies.forEach(cookie => { try { jar.setCookieSync(cookie, url); } catch {} });
        }
        return response;
    });

    try {
        // ── PASSO 1: Login ─────────────────────────────────────────────────
        console.log('[scraper] Iniciando login...');
        const loginPage = await client.get('/sigaa/logar.do?dispatch=logOff', { headers: BASE_HEADERS });
        const loginFields = extractHiddenFields(loginPage.data);

        const loginParams = new URLSearchParams({
            'user.login': user,
            'user.senha': pass,
            ...loginFields,
        });
        const loginRes = await client.post('/sigaa/logar.do?dispatch=logOn', loginParams.toString(), { headers: BASE_HEADERS });

        // Detecta login inválido
        if (loginRes.data.includes('Usuário e/ou senha inválidos') || loginRes.data.includes('logar.do')) {
            console.log('[scraper] Credenciais inválidas');
            return res.status(401).json({ error: 'Usuário e/ou senha inválidos.' });
        }
        console.log('[scraper] Login OK');

        // ── PASSO 2: Portal discente ───────────────────────────────────────
        console.log('[scraper] Carregando portal discente...');
        const portalRes = await client.get('/sigaa/portais/discente/discente.jsf', { headers: BASE_HEADERS });
        const portalHtml = portalRes.data;

        const dadosInstitucionais = parseDadosInstitucionais(portalHtml);
        const scheduleRaw         = parseScheduleRaw(portalHtml);
        const horariosDetalhados  = interpretSchedule(scheduleRaw);
        const horariosSimplificados = gerarTabelaSimplificada(horariosDetalhados);
        const portalViewState     = extractHiddenFields(portalHtml)['javax.faces.ViewState'];
        const formAtuId           = extractFormAtualizacoesTurmasId(portalHtml);
        const turmas              = extractTurmas(portalHtml);

        console.log(`[scraper] ${turmas.length} turma(s) encontrada(s)`);

        // ── PASSO 3: Para cada turma ──────────────────────────────────────
        const avisosPorDisciplina = [];

        for (const turma of turmas) {
            console.log(`[scraper] Turma: ${turma.nome} (${turma.idTurma})`);

            // 3a: Entra no AVA
            const avaPayload = new URLSearchParams();
            avaPayload.set('formAtualizacoesTurmas', 'formAtualizacoesTurmas');
            if (formAtuId) {
                avaPayload.set(`formAtualizacoesTurmas:${formAtuId}`, `formAtualizacoesTurmas:${formAtuId}`);
            }
            avaPayload.set('idTurma', turma.idTurma);
            avaPayload.set('javax.faces.ViewState', portalViewState ?? 'j_id3');

            const avaRes = await client.post('/sigaa/portais/discente/discente.jsf', avaPayload.toString(), {
                headers: { ...BASE_HEADERS, Referer: `${BASE_URL}/sigaa/portais/discente/discente.jsf` },
            });
            const avaHtml = avaRes.data;

            const avisos      = parseAvisos(avaHtml);
            const avaMenuId   = extractFormMenuAvaId(avaHtml);
            const avaViewState = extractHiddenFields(avaHtml)['javax.faces.ViewState'] ?? 'j_id3';

            if (!avaMenuId) {
                console.log(`[scraper]   formMenuId não encontrado, pulando...`);
                avisosPorDisciplina.push({
                    disciplina: turma.nome,
                    idTurma: turma.idTurma,
                    avisos,
                    frequencia: [],
                    numeroAulasDefinidas: null,
                    porcentagemFrequencia: null,
                    notas: { headers: [], valores: [], avaliacoes: [], mensagem: 'AVA não acessível.' },
                });
                continue;
            }

            // 3b: Frequência
            const freqPayload = new URLSearchParams();
            freqPayload.set('formMenu', 'formMenu');
            freqPayload.set(`formMenu:j_id_jsp_${avaMenuId}_69`, `formMenu:j_id_jsp_${avaMenuId}_92`);
            freqPayload.set(`formMenu:j_id_jsp_${avaMenuId}_95`, `formMenu:j_id_jsp_${avaMenuId}_95`);
            freqPayload.set('javax.faces.ViewState', avaViewState);

            const freqRes = await client.post('/sigaa/ava/index.jsf', freqPayload.toString(), {
                headers: { ...BASE_HEADERS, Referer: `${BASE_URL}/sigaa/ava/index.jsf` },
            });
            const freqHtml = freqRes.data;

            const frequenciaNaoLancada = freqHtml.includes('A frequência ainda não foi lançada.');
            let frequencia = [];
            let numeroAulasDefinidas = null;
            let porcentagemFrequencia = null;

            if (!frequenciaNaoLancada && freqHtml.includes('linhaImpar')) {
                frequencia = parseFrequencia(freqHtml);
                const stats = parseFrequenciaStats(freqHtml);
                numeroAulasDefinidas = stats.numeroAulasDefinidas;
                porcentagemFrequencia = stats.porcentagemFrequencia;
                console.log(`[scraper]   ${frequencia.length} registros de frequência`);
            } else {
                console.log(`[scraper]   Frequência não lançada`);
            }

            // 3c: Notas
            const notasPayload = new URLSearchParams();
            notasPayload.set('formMenu', 'formMenu');
            notasPayload.set(`formMenu:j_id_jsp_${avaMenuId}_97`, `formMenu:j_id_jsp_${avaMenuId}_97`);
            notasPayload.set('javax.faces.ViewState', avaViewState);

            const notasRes = await client.post('/sigaa/ava/index.jsf', notasPayload.toString(), {
                headers: { ...BASE_HEADERS, Referer: `${BASE_URL}/sigaa/ava/index.jsf` },
            });
            const notasHtml = notasRes.data;

            let notas;
            if (notasHtml.includes('Ainda não foram lançadas notas.')) {
                notas = { headers: [], valores: [], avaliacoes: [], mensagem: 'Ainda não foram lançadas notas.' };
                console.log(`[scraper]   Notas não lançadas`);
            } else {
                const parsed = parseNotas(notasHtml);
                notas = parsed ?? { headers: [], valores: [], avaliacoes: [], mensagem: 'Ainda não foram lançadas notas.' };
                if (parsed) console.log(`[scraper]   Notas OK (${parsed.headers.length} avaliações)`);
            }

            avisosPorDisciplina.push({
                disciplina: turma.nome,
                idTurma: turma.idTurma,
                avisos,
                frequencia,
                numeroAulasDefinidas,
                porcentagemFrequencia,
                notas,
                ...(frequenciaNaoLancada && { mensagem: 'A frequência ainda não foi lançada.' }),
            });
        }

        console.log('[scraper] Concluído');
        return res.status(200).json({
            dadosInstitucionais,
            horariosDetalhados,
            horariosSimplificados,
            avisosPorDisciplina,
        });

    } catch (error) {
        const msg = error.message || 'Erro interno';

        if (
            msg.includes('ERR_CONNECTION_TIMED_OUT') ||
            msg.includes('net::ERR_') ||
            msg.includes('TimeoutError') ||
            msg.includes('ECONNREFUSED') ||
            msg.includes('ETIMEDOUT')
        ) {
            return res.status(503).json({
                error:
                    'Não foi possível conectar ao SIGAA. ' +
                    'O servidor sig.cefetmg.br bloqueou a conexão vinda desta plataforma. ' +
                    'Hospede o backend em um servidor com IP residencial ou VPS brasileira.',
            });
        }

        console.error('[scraper] Erro:', msg);
        return res.status(500).json({ error: msg });
    }
};
