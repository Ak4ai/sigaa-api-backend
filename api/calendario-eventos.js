const fs = require('fs');
const path = require('path');

module.exports = function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const curso = req.query.curso === 'mecatronica' ? 'mecatronica' : 'computacao';

    // POST: Salvar nova data de prova
    if (req.method === 'POST') {
        try {
            const { disciplina, data, titulo } = req.body;
            if (!disciplina || !data || !titulo) {
                return res.status(400).json({ error: 'Parâmetros inválidos. Preencha todos os campos.' });
            }

            const cacheDir = path.resolve(__dirname, '../cache');
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }

            const customExamsPath = path.join(cacheDir, `provas_${curso}.json`);
            let customExams = [];
            if (fs.existsSync(customExamsPath)) {
                try {
                    customExams = JSON.parse(fs.readFileSync(customExamsPath, 'utf8'));
                } catch (e) {
                    console.error('Erro ao ler provas para salvar:', e.message);
                }
            }

            // Evita duplicados exatos
            const exists = customExams.some(e => e.disciplina === disciplina && e.data === data && e.titulo === titulo);
            if (!exists) {
                customExams.push({
                    data,
                    titulo,
                    disciplina,
                    tipo: 'prova'
                });
                fs.writeFileSync(customExamsPath, JSON.stringify(customExams, null, 2), 'utf8');
            }

            return res.status(200).json({ success: true, message: 'Prova adicionada com sucesso!' });
        } catch (error) {
            console.error('Erro ao adicionar prova:', error);
            return res.status(500).json({ error: 'Erro interno ao salvar prova.' });
        }
    }

    // GET: Listar todos os eventos (letivo + provas)
    if (req.method === 'GET') {
        try {
            const cacheDir = path.resolve(__dirname, '../cache');
            
            // 1. Carrega eventos letivos do curso
            const letivosPath = path.join(cacheDir, `calendario_${curso}.json`);
            let letivos = [];
            if (fs.existsSync(letivosPath)) {
                try {
                    const content = JSON.parse(fs.readFileSync(letivosPath, 'utf8'));
                    letivos = content.eventos || content || [];
                } catch (e) {
                    console.error('Erro ao ler calendario letivo:', e.message);
                }
            }

            // 2. Carrega provas salvas
            const customExamsPath = path.join(cacheDir, `provas_${curso}.json`);
            let customExams = [];
            if (fs.existsSync(customExamsPath)) {
                try {
                    customExams = JSON.parse(fs.readFileSync(customExamsPath, 'utf8'));
                } catch (e) {
                    console.error('Erro ao ler provas:', e.message);
                }
            }

            // 3. Mescla tudo e retorna
            const eventos = [...letivos, ...customExams];
            return res.status(200).json({ eventos });
        } catch (error) {
            console.error('Erro ao listar eventos:', error);
            return res.status(500).json({ error: 'Erro interno ao carregar eventos.' });
        }
    }

    return res.status(405).json({ error: 'Método não permitido.' });
};
