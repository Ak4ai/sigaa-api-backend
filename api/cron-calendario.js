const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");

// Pastas de cache e temporária
const CACHE_DIR = path.resolve(__dirname, '../cache');
const TEMP_DIR = path.resolve(__dirname, '../temp');

// Cria as pastas se não existirem
fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

// Função principal de processamento do calendário por curso
async function processarCurso(curso) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.warn(`[CRON-CALENDARIO] [${curso}] GEMINI_API_KEY não configurada no .env. Pulando.`);
        return;
    }

    const targetUrl = curso === 'mecatronica'
        ? 'https://www.eng-mecatronica.divinopolis.cefetmg.br/calendario-letivo/'
        : 'https://www.eng-computacao.divinopolis.cefetmg.br/2019/03/18/calendario-letivo/';

    try {
        console.log(`[CRON-CALENDARIO] [${curso}] Buscando página para obter link do PDF...`);
        const response = await axios.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            timeout: 10000
        });

        const $ = cheerio.load(response.data);
        let pdfLink = $('ul.wp-block-list a').first().attr('href');

        if (!pdfLink) {
            $('a').each((i, el) => {
                const href = $(el).attr('href');
                const text = $(el).text().trim();
                if (href && href.toLowerCase().includes('.pdf') && (text.toLowerCase().includes('calendário') || text.toLowerCase().includes('calendario'))) {
                    if (!pdfLink) pdfLink = href;
                }
            });
        }

        if (!pdfLink) {
            console.error(`[CRON-CALENDARIO] [${curso}] Link do PDF do calendário não encontrado.`);
            return;
        }

        // Lê cache anterior se existir
        const cacheFilePath = path.join(CACHE_DIR, `calendario_${curso}.json`);
        let cacheData = null;
        if (fs.existsSync(cacheFilePath)) {
            try {
                cacheData = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
            } catch (e) {
                console.warn(`[CRON-CALENDARIO] [${curso}] Falha ao ler cache anterior, ignorando.`);
            }
        }

        // Se o PDF Link for idêntico ao já processado, não faz nada
        if (cacheData && cacheData.pdfUrl === pdfLink && Array.isArray(cacheData.eventos) && cacheData.eventos.length > 0) {
            console.log(`[CRON-CALENDARIO] [${curso}] PDF do calendário não mudou. Cache atualizado.`);
            return;
        }

        console.log(`[CRON-CALENDARIO] [${curso}] Novo PDF detectado: ${pdfLink}. Iniciando download e parsing via IA...`);

        // Faz o download do PDF
        const tempPdfPath = path.join(TEMP_DIR, `calendar_${curso}.pdf`);
        const pdfResponse = await axios.get(pdfLink, {
            responseType: 'arraybuffer',
            httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });
        fs.writeFileSync(tempPdfPath, pdfResponse.data);

        // Upload do arquivo para a File Manager API do Gemini
        console.log(`[CRON-CALENDARIO] [${curso}] Fazendo upload do PDF para o Gemini File Manager...`);
        const fileManager = new GoogleAIFileManager(apiKey);
        const uploadResult = await fileManager.uploadFile(tempPdfPath, {
            mimeType: "application/pdf",
            displayName: `Calendario CEFET Divinopolis ${curso}`,
        });

        console.log(`[CRON-CALENDARIO] [${curso}] Upload completo. Nome remoto: ${uploadResult.file.name}. Processando com IA...`);

        // Inicializa o Gemini
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            generationConfig: {
                responseMimeType: "application/json",
            }
        });

        // Prompt robusto para extração visual das cores e datas do calendário
        const prompt = `Analise atentamente as tabelas de calendário mensais presentes neste documento PDF.
Identifique cada mês e extraia todos os dias que possuem marcações de feriados (cor laranja), recessos escolares/férias (cor pêssego/salmão/bege) e início/término de aulas ou exames (cor roxa ou verde se houver).
Extraia também a lista textual descritiva de feriados e eventos que fica à direita de cada mês.

Siga rigorosamente as seguintes regras de mapeamento:
- Dias com cor laranja: Feriado ("feriado")
- Dias com cor pêssego/salmão: Recesso ("recesso")
- Dias com datas de início/término de aulas: início/fim ("inicio-aulas" ou "fim-aulas")
- Qualquer outro evento assinalado: "outros"

Formate as datas como string ISO YYYY-MM-DD. O ano letivo deste calendário é 2026.
Retorne um objeto JSON contendo estritamente uma lista de eventos sob a chave "eventos". Não adicione blocos de markdown ou comentários.

Exemplo de formato esperado:
{
  "eventos": [
    { "data": "2026-03-02", "titulo": "Início do Semestre Letivo", "tipo": "inicio-aulas" },
    { "data": "2026-04-03", "titulo": "Feriado - Sexta-feira da Paixão", "tipo": "feriado" },
    { "data": "2026-04-20", "titulo": "Recesso Escolar", "tipo": "recesso" }
  ]
}
`;

        const result = await model.generateContent([
            uploadResult.file,
            prompt
        ]);

        const jsonText = result.response.text();
        console.log(`[CRON-CALENDARIO] [${curso}] Resposta do Gemini recebida.`);

        // Limpa o arquivo no File Manager
        try {
            await fileManager.deleteFile(uploadResult.file.name);
            console.log(`[CRON-CALENDARIO] [${curso}] Arquivo temporário removido do File Manager.`);
        } catch (delErr) {
            console.warn(`[CRON-CALENDARIO] [${curso}] Falha ao deletar arquivo temporário remoto:`, delErr.message);
        }

        // Limpa o arquivo local
        try {
            if (fs.existsSync(tempPdfPath)) {
                fs.unlinkSync(tempPdfPath);
            }
        } catch (unlinkErr) {
            console.warn(`[CRON-CALENDARIO] [${curso}] Falha ao remover PDF local:`, unlinkErr.message);
        }

        // Valida e salva o JSON
        const parsedData = JSON.parse(jsonText);
        if (!parsedData || !Array.isArray(parsedData.eventos)) {
            throw new Error("Formato de resposta do Gemini inválido.");
        }

        // Adiciona metadados úteis para o cache
        const output = {
            pdfUrl: pdfLink,
            updatedAt: Date.now(),
            eventos: parsedData.eventos
        };

        fs.writeFileSync(cacheFilePath, JSON.stringify(output, null, 2), 'utf8');
        console.log(`[CRON-CALENDARIO] [${curso}] Calendário atualizado com sucesso com ${parsedData.eventos.length} eventos!`);

    } catch (error) {
        console.error(`[CRON-CALENDARIO] [${curso}] Erro geral de processamento:`, error.message);
    }
}

// Executa para todos os cursos suportados
async function atualizarCalendariosBackground() {
    console.log("[CRON-CALENDARIO] Iniciando checagem de atualizações dos calendários...");
    await processarCurso('mecatronica');
    await processarCurso('computacao');
    console.log("[CRON-CALENDARIO] Checagem de atualizações concluída.");
}

module.exports = {
    atualizarCalendariosBackground
};
