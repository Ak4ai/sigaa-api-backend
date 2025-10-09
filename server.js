const express = require('express');
const scraperHandler = require('./api/scraper');

const app = express();
const port = 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Define the route for your scraper API
app.post('/api/scraper', async (req, res) => {
    console.log('Recebida requisição para /api/scraper');
    try {
        // Call your existing handler
        await scraperHandler(req, res);
    } catch (error) {
        console.error('Erro no handler do scraper:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Erro interno do servidor.' });
        }
    }
});

app.listen(port, () => {
    console.log(`Servidor local rodando em http://localhost:${port}`);
    console.log('Para testar, envie uma requisição POST para http://localhost:3000/api/scraper');
    console.log('O corpo da requisição deve ser um JSON com seu usuário e senha:');
    console.log('{ "user": "seu_usuario", "pass": "sua_senha" }');
});
