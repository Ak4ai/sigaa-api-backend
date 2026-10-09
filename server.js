// Carrega variáveis de ambiente ANTES de qualquer outro require
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const crypto = require('crypto');
const { validarTokenLogin } = require('./api/auth');
const { ScrapeQueue } = require('./lib/scrape-queue');
const { limits, createRateLimiter, validScrapeBody, attachRequestBudget, scrapeIdentity } = require('./lib/request-protection');
const fs = require('fs');
const loginHandler = require('./api/login');
const logoutHandler = require('./api/logout');
const scraperHandler = require('./api/scraper');
const calendarioHandler = require('./api/calendario');
const calendarioEventosHandler = require('./api/calendario-eventos');
const { atualizarCalendariosBackground } = require('./api/cron-calendario');
const { getProgress } = require('./api/progress');

const app = express();
const PORT = process.env.PORT || 3000;

// Diretório do frontend
let FRONTEND_DIR = path.resolve(
    __dirname,
    '../teste_api_sigaa/sigaa-test/Sigaa-API-webapp'
);
if (!fs.existsSync(FRONTEND_DIR)) {
    FRONTEND_DIR = path.resolve(__dirname, '../Sigaa-API-webapp');
}

const browserSession = require('./lib/browser-session');
app.use((req, res, next) => { browserSession.applyCors(req, res); next(); });

// Middleware para parsear JSON
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
app.use('/api', (req, res, next) => {
    req.apiRateLimited = true;
    res.setHeader('Cache-Control', 'no-store');
    next();
});
app.use('/api', createRateLimiter({ limit: limits.api, windowMs: 60000 }));
app.use('/api/login', createRateLimiter({ limit: limits.login, windowMs: 600000 }));
app.use('/api/scraper', createRateLimiter({ limit: limits.scrape, windowMs: 600000 }));
app.use(express.json({ limit: '16kb' }));
app.use('/api', browserSession.middleware);
app.get('/api/session', browserSession.sessionHandler);

app.get('/api/health', (req, res) => res.json({
    status: 'ok', release: process.env.RELEASE_VERSION || 'development'
}));

// ── Sistema de fila para scraping ────────────────────────────────────────
const scraperQueue = new ScrapeQueue(limits.queue);
let queueIdCounter = 0;

app.get('/api/queue-status', (req, res) => {
    const clientId = typeof req.query.clientId === 'string' ? req.query.clientId : '';
    res.setHeader('Cache-Control', 'no-store');
    res.json(scraperQueue.status(clientId));
});

// ── Novo endpoint: progresso em tempo real ────────────────────────────────
app.get('/api/scraper-progress', (req, res) => {
    const clientId = req.query.clientId || '';
    const progress = getProgress(clientId);
    res.json(progress);
});

// Rota de login
app.all('/api/login', (req, res) => loginHandler(req, res));
app.all('/api/logout', (req, res) => logoutHandler(req, res));

// Rota de calendário dinâmico
app.all('/api/calendario', (req, res) => calendarioHandler(req, res));
app.all('/api/calendario/eventos', (req, res) => calendarioEventosHandler(req, res));

// Rota de scraper — com fila
app.all('/api/scraper', async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
    if (!validScrapeBody(req.body)) return res.status(400).json({ error: 'Parâmetros de consulta inválidos.' });
    const budget = attachRequestBudget(req, res);
    try {
        let user = req.body.user, pass = req.body.pass;
        if (req.body.token) {
            const payload = await validarTokenLogin(req.body.token);
            budget.signal.throwIfAborted();
            if (!payload || !validScrapeBody({user: payload.user, pass: payload.pass})) {
                return res.status(401).json({ error: 'Token inválido ou expirado.' });
            }
            if (req.headers['x-profile-user'] && req.headers['x-profile-user'] !== payload.user) {
                return res.status(409).json({ error: 'A conta ativa mudou em outra aba. Entre novamente na conta selecionada.' });
            }
            user = payload.user;
            pass = payload.pass;
        }
        budget.signal.throwIfAborted();
        const clientId = req.body.clientId || crypto.randomUUID();
        req.body.clientId = clientId;
        res.setHeader('X-Queue-Id', String(++queueIdCounter));
        res.setHeader('Cache-Control', 'no-store');
        await scraperQueue.enqueue({
            identity: scrapeIdentity(user, pass), clientId, signal: budget.signal,
            run: async () => { budget.start(); await scraperHandler(req, res); }
        });
    } catch (error) {
        if (budget.signal.aborted || res.headersSent || res.destroyed) return;
        const status = error.status || 503;
        if (status === 429) res.setHeader('Retry-After', '60');
        const message = error.status ? error.message : 'Não foi possível realizar a consulta. Tente novamente.';
        res.status(status).json({ error: message });
    } finally {
        budget.cleanup();
    }
});

// Serve index.html usando a mesma origem da página para a API
app.get('/', (req, res) => {
    const indexPath = path.join(FRONTEND_DIR, 'index.html');
    if (!fs.existsSync(indexPath)) {
        return res.status(404).send('index.html não encontrado em: ' + indexPath);
    }
    let html = fs.readFileSync(indexPath, 'utf8');
    html = html.replace(
        '</head>',
        '  <script>window.API_BASE_URL = window.location.origin;</script>\n</head>'
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
});

// Serve arquivos estáticos do frontend (css, js, imagens)
app.use(express.static(FRONTEND_DIR));

// Agendador diário para verificar e atualizar calendários (24 horas)
const CRON_INTERVAL_MS = 24 * 60 * 60 * 1000;
if (process.env.DISABLE_CALENDAR_CRON !== '1') {
    setInterval(atualizarCalendariosBackground, CRON_INTERVAL_MS);
// Executa uma checagem inicial após 10 segundos ao ligar o servidor
    setTimeout(atualizarCalendariosBackground, 10000);
}

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Requisição muito grande.' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
    res.status(500).json({ error: 'Erro interno do servidor.' });
});

const server = app.listen(PORT, process.env.HOST || '127.0.0.1', () => {
    console.log(`\n✅ Servidor rodando em http://localhost:${PORT}`);
    console.log(`   Frontend:    http://localhost:${PORT}/`);
    console.log(`   API Login:   POST http://localhost:${PORT}/api/login`);
    console.log(`   API Scraper: POST http://localhost:${PORT}/api/scraper`);
    console.log(`\n   NODE_ENV: ${process.env.NODE_ENV}`);
    console.log('   Chrome: C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\n');
});

server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 50;
