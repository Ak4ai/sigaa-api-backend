const exams = require('../lib/manual-exams');
const { validarTokenLogin } = require('./auth');
const { createRateLimiter } = require('../lib/request-protection');
const writeLimit = createRateLimiter({ limit: 20, windowMs: 60000 });
module.exports = async function handler(req, res) {
    if (!require('../lib/browser-session').prepareBrowserRequest(req, res)) return;

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Método não permitido.' });
    if (req.method === 'POST') {
        let admitted = false;
        writeLimit(req, res, () => { admitted = true; });
        if (!admitted) return;
    }
    try {
        const token = /^Bearer ([^ ]+)$/i.exec(req.headers.authorization || '')?.[1];
        const payload = token ? await validarTokenLogin(token) : null;
        if (token && !payload) return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
        if (payload && req.headers['x-profile-user'] && req.headers['x-profile-user'] !== payload.user) {
            return res.status(409).json({ error: 'A conta ativa mudou em outra aba. Entre novamente na conta selecionada.' });
        }
        const access = await exams.getAccess(token);
        if (req.method === 'POST') {
            if (!token) return res.status(401).json({ error: 'Entre na sua conta para cadastrar provas.' });
            if (!access) return res.status(403).json({ error: 'Atualize seus dados no SIGAA para confirmar suas turmas.' });
            const result = exams.add(access, req.body || {});
            return res.status(result.status).json(result);
        }
        const course = req.query.curso === 'mecatronica' ? 'mecatronica' : 'computacao';
        const result = exams.list(access, course);
        return res.status(200).json({ eventos: [...exams.officialEvents(course), ...result.eventos], turmas: result.turmas, precisaAtualizar: !access });
    } catch (error) {
        console.error('[manual-exams] Falha no armazenamento:', error.code || error.name);
        return res.status(503).json({ error: 'Calendário temporariamente indisponível.' });
    }
};
