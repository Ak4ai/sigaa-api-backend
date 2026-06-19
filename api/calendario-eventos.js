const fs = require('fs');
const path = require('path');

module.exports = function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const curso = req.query.curso === 'mecatronica' ? 'mecatronica' : 'computacao';
    const cacheFilePath = path.resolve(__dirname, `../cache/calendario_${curso}.json`);

    if (fs.existsSync(cacheFilePath)) {
        try {
            const data = fs.readFileSync(cacheFilePath, 'utf8');
            return res.status(200).send(data);
        } catch (error) {
            console.error(`[CALENDARIO-EVENTOS] [${curso}] Erro ao ler cache:`, error.message);
            return res.status(500).json({ error: 'Erro ao ler arquivo de calendário.' });
        }
    } else {
        console.warn(`[CALENDARIO-EVENTOS] [${curso}] Arquivo de cache não encontrado.`);
        return res.status(200).json({ pdfUrl: null, eventos: [] });
    }
};
