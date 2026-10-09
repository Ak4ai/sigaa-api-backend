const { fetchPage, selectCalendarPdfLink, PAGES } = require('../lib/calendar-download');

// Cache em memória para evitar requisições excessivas à página externa (separado por curso)
const cache = {};
const pending = {};
const CACHE_DURATION = 1 * 60 * 60 * 1000; // 1 hora de cache

module.exports = async function handler(req, res) {
    // CORS headers

    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const curso = req.query.curso === 'mecatronica' ? 'mecatronica' : 'computacao';
    const targetUrl = PAGES[curso];

    // Verifica se temos no cache e ainda está válido
    const now = Date.now();
    if (cache[curso] && (now - cache[curso].lastFetched < CACHE_DURATION)) {
        console.log(`[CALENDARIO] [${curso}] Retornando link do cache:`, cache[curso].link);
        return res.status(200).json({ link: cache[curso].link });
    }

    try {
        console.log(`[CALENDARIO] [${curso}] Buscando calendário da página externa...`);
        const primeiroLink = await (pending[curso] || (pending[curso] = fetchPage(targetUrl)
            .then(page => selectCalendarPdfLink(page.html, page.url))
            .finally(() => { delete pending[curso]; })));

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
