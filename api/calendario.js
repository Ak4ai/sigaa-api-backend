const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

// Cache em memória para evitar requisições excessivas à página externa
let cachedLink = null;
let lastFetched = 0;
const CACHE_DURATION = 1 * 60 * 60 * 1000; // 1 hora de cache

module.exports = async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const targetUrl = 'https://www.eng-computacao.divinopolis.cefetmg.br/2019/03/18/calendario-letivo/';

    // Verifica se temos no cache e ainda está válido
    const now = Date.now();
    if (cachedLink && (now - lastFetched < CACHE_DURATION)) {
        console.log('[CALENDARIO] Retornando link do cache:', cachedLink);
        return res.status(200).json({ link: cachedLink });
    }

    try {
        console.log('[CALENDARIO] Buscando calendário da página externa...');
        const response = await axios.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            httpsAgent: new https.Agent({
                rejectUnauthorized: false
            }),
            timeout: 5000 // timeout de 5 segundos
        });

        const html = response.data;
        const $ = cheerio.load(html);
        
        // Procura pelo primeiro link dentro de ul.wp-block-list
        const primeiroLink = $('ul.wp-block-list a').first().attr('href');

        if (primeiroLink) {
            cachedLink = primeiroLink;
            lastFetched = now;
            console.log('[CALENDARIO] Link encontrado e cacheado:', cachedLink);
            return res.status(200).json({ link: cachedLink });
        } else {
            console.warn('[CALENDARIO] Elemento ul.wp-block-list a não encontrado no HTML.');
            // Retorna a página de calendários como fallback caso não ache o PDF direto
            return res.status(200).json({ link: targetUrl, isFallback: true });
        }
    } catch (error) {
        console.error('[CALENDARIO] Erro ao buscar calendário dinâmico:', error.message);
        // Em caso de erro, retorna o cachedLink anterior se existir, senão retorna o link padrão
        const fallbackLink = cachedLink || targetUrl;
        return res.status(200).json({ link: fallbackLink, error: error.message, isFallback: true });
    }
};
