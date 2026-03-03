// Carrega variáveis de ambiente ANTES de qualquer outro require
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const fs = require('fs');
const loginHandler = require('./api/login');
const scraperHandler = require('./api/scraper');

const app = express();
const PORT = process.env.PORT || 3000;

// Diretório do frontend
const FRONTEND_DIR = path.resolve(
    __dirname,
    '../teste_api_sigaa/sigaa-test/Sigaa-API-webapp'
);

// CORS global — deve vir ANTES de qualquer outro middleware
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

// Middleware para parsear JSON
app.use(express.json());

// ── Sistema de fila para scraping ────────────────────────────────────────
const scraperQueue = [];       // fila: [{ id, resolve, reject }]
let isScraperBusy = false;     // mutex: alguém está fazendo scraping?
let queueIdCounter = 0;        // ID incremental
const scrapeTimesMs = [];       // últimos N tempos de scraping para calcular média
const MAX_TIMES_HISTORY = 20;

function getAvgScrapeTimeMs() {
    if (scrapeTimesMs.length === 0) return 60000; // padrão: 60s
    return Math.round(scrapeTimesMs.reduce((a, b) => a + b, 0) / scrapeTimesMs.length);
}

async function processQueue() {
    if (isScraperBusy || scraperQueue.length === 0) return;
    isScraperBusy = true;
    const job = scraperQueue.shift();
    try {
        const startMs = Date.now();
        await job.run();
        const elapsed = Date.now() - startMs;
        scrapeTimesMs.push(elapsed);
        if (scrapeTimesMs.length > MAX_TIMES_HISTORY) scrapeTimesMs.shift();
    } catch (err) {
        console.error('Erro no job da fila:', err);
    } finally {
        isScraperBusy = false;
        processQueue(); // processa próximo
    }
}

// Endpoint para o frontend consultar posição na fila
app.get('/api/queue-status', (req, res) => {
    const queueId = parseInt(req.query.id, 10);
    const position = scraperQueue.findIndex(j => j.id === queueId);
    res.json({
        position: position === -1 ? 0 : position + 1, // 0 = está sendo processado ou já saiu
        queueLength: scraperQueue.length,
        processing: isScraperBusy,
        avgTimeMs: getAvgScrapeTimeMs()
    });
});

// Rota de login
app.all('/api/login', (req, res) => loginHandler(req, res));

// Rota de scraper — com fila
app.all('/api/scraper', async (req, res) => {
    if (req.method === 'OPTIONS') return res.status(200).end();

    const queueId = ++queueIdCounter;
    const position = scraperQueue.length + (isScraperBusy ? 1 : 0);

    // Se já tem alguém na fila ou processando, retorna posição para o front saber
    // O header X-Queue-Id permite o front fazer polling com /api/queue-status
    res.setHeader('X-Queue-Id', String(queueId));

    console.log(`[FILA] Job #${queueId} enfileirado (posição ${position + 1}, fila: ${scraperQueue.length + 1})`);

    // Enfileira e aguarda sua vez
    await new Promise((resolve, reject) => {
        scraperQueue.push({
            id: queueId,
            run: async () => {
                try {
                    console.log(`[FILA] Job #${queueId} iniciando scraping...`);
                    await scraperHandler(req, res);
                    resolve();
                } catch (error) {
                    console.error(`[FILA] Erro no job #${queueId}:`, error);
                    if (!res.headersSent) {
                        res.status(500).json({ error: 'Erro interno do servidor.' });
                    }
                    resolve(); // resolve anyway para não travar a fila
                }
            }
        });
        processQueue(); // tenta processar se não há ninguém rodando
    });
});

// Serve index.html injetando a URL local da API
app.get('/', (req, res) => {
    const indexPath = path.join(FRONTEND_DIR, 'index.html');
    if (!fs.existsSync(indexPath)) {
        return res.status(404).send('index.html não encontrado em: ' + indexPath);
    }
    let html = fs.readFileSync(indexPath, 'utf8');
    html = html.replace(
        '</head>',
        `  <script>window.API_BASE_URL = 'http://localhost:${PORT}';</script>\n</head>`
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
});

// Serve arquivos estáticos do frontend (css, js, imagens)
app.use(express.static(FRONTEND_DIR));

app.listen(PORT, () => {
    console.log(`\n✅ Servidor rodando em http://localhost:${PORT}`);
    console.log(`   Frontend:    http://localhost:${PORT}/`);
    console.log(`   API Login:   POST http://localhost:${PORT}/api/login`);
    console.log(`   API Scraper: POST http://localhost:${PORT}/api/scraper`);
    console.log(`\n   NODE_ENV: ${process.env.NODE_ENV}`);
    console.log('   Chrome: C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\n');
});
