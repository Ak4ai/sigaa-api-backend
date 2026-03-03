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

// Middleware para parsear JSON
app.use(express.json());

// Rota de login
app.all('/api/login', (req, res) => loginHandler(req, res));

// Rota de scraper
app.all('/api/scraper', async (req, res) => {
    console.log('Recebida requisição para /api/scraper');
    try {
        await scraperHandler(req, res);
    } catch (error) {
        console.error('Erro no handler do scraper:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Erro interno do servidor.' });
        }
    }
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
