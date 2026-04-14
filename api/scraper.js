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
const { setProgress } = require('./progress');

const BASE_URL = 'https://sig.cefetmg.br';

const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'pt-BR,pt;q=0.9',
    'Content-Type': 'application/x-www-form-urlencoded',
};

// ── REGEX COMPILADAS (executa uma vez, reutiliza em todas as requisições) ────
const REGEX_ID_TURMA = /'idTurma'\s*:\s*'(\d+)'/;
const REGEX_NOME_BASE = /\s*\(.*\)\s*$/;
const REGEX_FRONTEND_ID_TURMA = /'frontEndIdTurma'\s*:\s*'([A-Fa-f0-9]{20,})'/;
const REGEX_BUTTON_FIELD_KEY = /\{'([^']+)'\s*:\s*'[^']*'\s*,\s*'frontEndIdTurma'/;
const REGEX_ID_TURMA_FALLBACK = /'idTurma'\s*:\s*'(\d+)'[^)]*\)[^>]*>([^<]+)/g;
const REGEX_FORM_ATU_ID = /formAtualizacoesTurmas:(j_id_jsp_\d+_\d+)['":]/;
const REGEX_FORM_MENU_AVA_ID = /id="formMenu:j_id_jsp_(\d+)_69"/;
const REGEX_FORM_MENU_AVA_ID_ALT = /formMenu:j_id_jsp_(\d+)_69/;
const REGEX_AULAS_DEFINIDAS = /Número de Aulas definidas pela CH do Componente:\s*(\d+)/i;
const REGEX_PORCENTAGEM_FREQ = /Porcentagem de Frequência em relação a CH:\s*(\d+)%/i;
const REGEX_DATA_AULA = /\d{2}\/\d{2}\/\d{4}/;
const REGEX_SCHEDULE_CODE = /\d+[MTN]\d+/;

// ── CACHE DE HORÁRIOS (não muda a cada 6 meses) ────────────────────────────
const scheduleCache = new Map(); // user → { timestamp, data }
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 horas

function hasScheduleCodesInRaw(scheduleRaw) {
    if (!Array.isArray(scheduleRaw) || scheduleRaw.length === 0) return false;
    return scheduleRaw.some(item => REGEX_SCHEDULE_CODE.test(String(item?.rawCodes || '')));
}

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

function detectarNotificacoesAcademicas(html) {
    const $ = load(html);
    const notificacao = $('#conteudo > h2').text().trim();
    
    if (notificacao.includes('Notificações Acadêmicas')) {
        console.log('[scraper] ⚠️ Notificações Acadêmicas detectadas - usuário deve acessar o site');
        return true;
    }
    return false;
}

function decodeHtmlEntities(str) {
    return load(`<x>${str}</x>`)('x').text();
}

function extractTurmas(html) {
    // Extrai todas as disciplinas do portal via form_acessarTurmaVirtual.
    // Cada disciplina tem: nome, frontEndIdTurma (hash SHA1), formId, buttonFieldKey.
    // Mapeia nome → idTurma numérico via formAtualizacoesTurmas para manter o contrato de output.
    const $ = load(html);
    const turmas = [];
    const seen = new Set();

    // 1. Mapa nome base (sem semestre) → idTurma numérico via links do painel formAtualizacoesTurmas
    const nomeToIdTurma = {};
    $('[onclick]').each((_, el) => {
        const oc = $(el).attr('onclick') || '';
        if (!oc.includes('formAtualizacoesTurmas')) return;
        const mId = oc.match(REGEX_ID_TURMA);
        if (!mId) return;
        const nomeLink = decodeHtmlEntities($(el).text().trim());
        if (nomeLink) {
            const nomeBase = nomeLink.replace(REGEX_NOME_BASE, '').trim().toUpperCase();
            nomeToIdTurma[nomeBase] = mId[1];
        }
    });

    // 2. Extrai cada linha com form_acessarTurmaVirtual
    $('tbody tr').each((_, row) => {
        const $row = $(row);
        const form = $row.find('form[id^="form_acessarTurmaVirtual"]').first();
        if (!form.length) return;

        const nomeRaw = $row.find('td.descricao a').text().trim()
            || $row.find('td.descricao').text().trim();
        if (!nomeRaw) return;
        const nome = decodeHtmlEntities(nomeRaw);

        // frontEndIdTurma: hash SHA1 no onclick do botão de acesso
        let frontEndIdTurma = null;
        let buttonFieldKey = null;
        $row.find('[onclick]').each((_, el) => {
            if (frontEndIdTurma) return;
            const oc = $(el).attr('onclick') || '';
            const mFe = oc.match(REGEX_FRONTEND_ID_TURMA);
            if (!mFe) return;
            frontEndIdTurma = mFe[1];
            // Campo do botão: {'form_acessarTurmaVirtualXXX:j_id_YYY':'...','frontEndIdTurma':...}
            const mBtn = oc.match(REGEX_BUTTON_FIELD_KEY);
            if (mBtn) buttonFieldKey = mBtn[1];
        });

        if (!frontEndIdTurma || seen.has(frontEndIdTurma)) return;
        seen.add(frontEndIdTurma);

        // idTurma numérico (pode ser null se disciplina não aparece no painel de avisos)
        const nomeBase = nome.replace(REGEX_NOME_BASE, '').trim().toUpperCase();
        const idTurma = nomeToIdTurma[nomeBase] || null;

        turmas.push({ nome, frontEndIdTurma, formId: form.attr('id'), buttonFieldKey, idTurma });
    });

    // Fallback: se nada foi encontrado, tenta via formAtualizacoesTurmas (HTML antigo)
    if (turmas.length === 0) {
        const pattern = REGEX_ID_TURMA_FALLBACK;
        let match;
        const seenFb = new Set();
        while ((match = pattern.exec(html)) !== null) {
            const idTurma = match[1];
            if (seenFb.has(idTurma)) continue;
            seenFb.add(idTurma);
            const nome = decodeHtmlEntities(match[2].trim());
            if (nome) turmas.push({ nome, frontEndIdTurma: null, formId: null, buttonFieldKey: null, idTurma });
        }
    }

    return turmas;
}

function extractFormAtualizacoesTurmasId(html) {
    const match = html.match(REGEX_FORM_ATU_ID);
    return match ? match[1] : null;
}

function extractFormMenuAvaId(html) {
    const match = html.match(REGEX_FORM_MENU_AVA_ID);
    if (match) return match[1];
    const match2 = html.match(REGEX_FORM_MENU_AVA_ID_ALT);
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
            if (REGEX_DATA_AULA.test(data) && status.length > 0) {
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

    const matchAulas = texto.match(REGEX_AULAS_DEFINIDAS);
    const matchPct   = texto.match(REGEX_PORCENTAGEM_FREQ);

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

    // Garante um clientId válido (usa alternativa padrão se não fornecido)
    const clientId = req.body.clientId || `scraper-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    
    // Verifica se deve pular o fetch de horários
    const skipSchedule = req.body.skipSchedule === true;
    
    // Resetar progresso no início
    setProgress(clientId, 0, 'Iniciando...');

    const jar = new CookieJar();
    const client = axios.create({
        baseURL: BASE_URL,
        validateStatus: () => true,
        decompress: true,
        timeout: 12000,
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

        // Detecta login inválido: verifica mensagens de erro SIGAA na página resultante
        // Não usar includes('logar.do') pois o portal também contém esse link (botão Sair)
        const loginInvalido =
            loginRes.data.includes('Usuário e/ou senha inválidos') ||
            loginRes.data.includes('Dados incorretos') ||
            loginRes.data.includes('Falha na autenticação') ||
            (loginRes.data.includes('input[type=password]') && loginRes.data.includes('user.senha'));
        if (loginInvalido) {
            console.log('[scraper] Credenciais inválidas');
            return res.status(401).json({ error: 'Usuário e/ou senha inválidos.' });
        }
        console.log('[scraper] Login OK');
        setProgress(clientId, 10, '🔓 Login realizado...');

        // ── PASSO 1.5: Verificar notificações acadêmicas pendentes ─────────
        const notificacoesPendentes = detectarNotificacoesAcademicas(loginRes.data);
        if (notificacoesPendentes) {
            return res.status(403).json({
                error: 'Notificações Acadêmicas Pendentes',
                type: 'ACADEMIC_NOTIFICATIONS_PENDING',
                message: 'Você tem notificações acadêmicas pendentes que precisam ser visualizadas no site do SIGAA.',
                instructions: 'Acesse o site https://sig.cefetmg.br, faça login e visualize as notificações acadêmicas na página inicial. Depois tente novamente.',
                sigaaUrl: 'https://sig.cefetmg.br/sigaa/logar.do'
            });
        }

        // ── PASSO 2: Portal discente ───────────────────────────────────────
        console.log('[scraper] Carregando portal discente...');
        const portalRes = await client.get('/sigaa/portais/discente/discente.jsf', { headers: BASE_HEADERS });
        const portalHtml = portalRes.data;

        const dadosInstitucionais = parseDadosInstitucionais(portalHtml);
        const scheduleRaw         = parseScheduleRaw(portalHtml);
        const scheduleRawHasCodes = hasScheduleCodesInRaw(scheduleRaw);
        
        // ── CACHE DE HORÁRIOS (24 horas) ou PULAR HORÁRIOS ──────────────────
        let horariosDetalhados, horariosSimplificados;
        
        if (skipSchedule) {
            // Pula o fetch de horários
            console.log('[scraper] ⏭️ Pulando horários (skipSchedule=true)');
            horariosDetalhados = [];
            horariosSimplificados = [];
            setProgress(clientId, 20, '⏭️ Horários pulados...');
        } else {
            // Processa horários normalmente com cache de 24h
            const cacheKey = user;
            const now = Date.now();
            
            if (scheduleCache.has(cacheKey)) {
                const cached = scheduleCache.get(cacheKey);
                if (now - cached.timestamp < CACHE_DURATION) {
                    const cachedIsEmpty = !Array.isArray(cached.horariosSimplificados) || cached.horariosSimplificados.length === 0;
                    if (cachedIsEmpty && scheduleRawHasCodes) {
                        console.warn('[scraper] Cache vazio ignorado: portal atual possui códigos de horário. Recalculando...');
                        horariosDetalhados = interpretSchedule(scheduleRaw);
                        horariosSimplificados = gerarTabelaSimplificada(horariosDetalhados);

                        if (horariosSimplificados.length > 0) {
                            scheduleCache.set(cacheKey, {
                                timestamp: now,
                                horariosDetalhados,
                                horariosSimplificados
                            });
                            console.log('[scraper] ✓ Horários recalculados e cache atualizado');
                        } else {
                            console.warn('[scraper] Recalculo retornou vazio apesar de códigos no portal; cache não atualizado.');
                        }
                    } else {
                        console.log('[scraper] ✓ Horários do cache (24h)');
                        horariosDetalhados = cached.horariosDetalhados;
                        horariosSimplificados = cached.horariosSimplificados;
                    }
                } else {
                    // Cache expirado, recalcula
                    horariosDetalhados = interpretSchedule(scheduleRaw);
                    horariosSimplificados = gerarTabelaSimplificada(horariosDetalhados);

                    if (horariosSimplificados.length > 0 || !scheduleRawHasCodes) {
                        scheduleCache.set(cacheKey, {
                            timestamp: now,
                            horariosDetalhados,
                            horariosSimplificados
                        });
                        console.log('[scraper] ✓ Horários recalculados e cacheados');
                    } else {
                        console.warn('[scraper] Horários vazios com códigos no portal; cache não atualizado.');
                    }
                }
            } else {
                // Primeiro acesso, calcula e cachea
                horariosDetalhados = interpretSchedule(scheduleRaw);
                horariosSimplificados = gerarTabelaSimplificada(horariosDetalhados);

                if (horariosSimplificados.length > 0 || !scheduleRawHasCodes) {
                    scheduleCache.set(cacheKey, {
                        timestamp: now,
                        horariosDetalhados,
                        horariosSimplificados
                    });
                    console.log('[scraper] ✓ Horários calculados e cacheados');
                } else {
                    console.warn('[scraper] Horários vazios com códigos no portal; cache não criado.');
                }
            }
            setProgress(clientId, 20, '📚 Portal carregado...');
        }

        // ── Extração de turmas, viewState, e formAtuId (independente do skipSchedule) ─
        const portalViewState     = extractHiddenFields(portalHtml)['javax.faces.ViewState'];
        const formAtuId           = extractFormAtualizacoesTurmasId(portalHtml);
        const turmas              = extractTurmas(portalHtml);

        console.log(`[scraper] ${turmas.length} turma(s) encontrada(s)`);

        // ── PASSO 3: Para cada turma ──────────────────────────────────────
        const avisosPorDisciplina = [];

        for (let i = 0; i < turmas.length; i++) {
            const turma = turmas[i];
            const progressPercent = Math.min(20 + (i + 1) * 10, 90); // 30%, 40%, ..., 90%
            setProgress(clientId, progressPercent, `⏳ Processando ${turma.nome}...`);

            // 3a: Entra no AVA via form_acessarTurmaVirtual + frontEndIdTurma (funciona para TODAS as disciplinas)
            const avaPayload = new URLSearchParams();
            if (turma.frontEndIdTurma && turma.formId) {
                avaPayload.set(turma.formId, turma.formId);
                if (turma.buttonFieldKey) {
                    avaPayload.set(turma.buttonFieldKey, turma.buttonFieldKey);
                }
                avaPayload.set('frontEndIdTurma', turma.frontEndIdTurma);
            } else {
                // Fallback: disciplinas extraídas via método antigo (sem frontEndIdTurma)
                avaPayload.set('formAtualizacoesTurmas', 'formAtualizacoesTurmas');
                if (formAtuId) {
                    avaPayload.set(`formAtualizacoesTurmas:${formAtuId}`, `formAtualizacoesTurmas:${formAtuId}`);
                }
                avaPayload.set('idTurma', turma.idTurma);
            }
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
            } else {
                const parsed = parseNotas(notasHtml);
                notas = parsed ?? { headers: [], valores: [], avaliacoes: [], mensagem: 'Ainda não foram lançadas notas.' };
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
        setProgress(clientId, 100, '✅ Concluído!');
        
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
