const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

// Cache em memória para evitar requisições excessivas à página externa (separado por curso)
const cache = {};
const CACHE_DURATION = 1 * 60 * 60 * 1000; // 1 hora de cache

module.exports = async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const curso = req.query.curso === 'mecatronica' ? 'mecatronica' : 'computacao';
    const targetUrl = curso === 'mecatronica'
        ? 'https://www.eng-mecatronica.divinopolis.cefetmg.br/calendario-letivo/'
        : 'https://www.eng-computacao.divinopolis.cefetmg.br/2019/03/18/calendario-letivo/';

    // Verifica se temos no cache e ainda está válido
    const now = Date.now();
    if (cache[curso] && (now - cache[curso].lastFetched < CACHE_DURATION)) {
        console.log(`[CALENDARIO] [${curso}] Retornando link do cache:`, cache[curso].link);
        return res.status(200).json({ link: cache[curso].link });
    }

    try {
        console.log(`[CALENDARIO] [${curso}] Buscando calendário da página externa...`);
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
        
        // Tenta primeiro o seletor padrão (primeiro link dentro de ul.wp-block-list)
        let primeiroLink = $('ul.wp-block-list a').first().attr('href');

        // Se não encontrar, tenta buscar o primeiro link para um PDF que tenha a palavra "calendário" no texto
        if (!primeiroLink) {
            $('a').each((i, el) => {
                const href = $(el).attr('href');
                const text = $(el).text().trim();
                if (href && href.toLowerCase().includes('.pdf') && (text.toLowerCase().includes('calendário') || text.toLowerCase().includes('calendario'))) {
                    if (!primeiroLink) {
                        primeiroLink = href;
                    }
                }
            });
        }

        if (primeiroLink) {
            cache[curso] = {
                link: primeiroLink,
                lastFetched: now
            };
            console.log(`[CALENDARIO] [${curso}] Link encontrado e cacheado:`, primeiroLink);
            return res.status(200).json({ link: primeiroLink });
        } else {
            console.warn(`[CALENDARIO] [${curso}] Link do PDF do calendário não encontrado no HTML.`);
            // Retorna a página de calendários como fallback caso não ache o PDF direto
            return res.status(200).json({ link: targetUrl, isFallback: true });
        }
    } catch (error) {
        console.error(`[CALENDARIO] [${curso}] Erro ao buscar calendário dinâmico:`, error.message);
        // Em caso de erro, retorna o cachedLink anterior se existir, senão retorna o link padrão
        const fallbackLink = (cache[curso] && cache[curso].link) || targetUrl;
        return res.status(200).json({ link: fallbackLink, error: error.message, isFallback: true });
    }
};
