const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { atualizarCalendariosBackground } = require('./api/cron-calendario');

(async () => {
    console.log("Iniciando teste de download e parsing de calendário...");
    if (!process.env.GEMINI_API_KEY) {
        console.error("ERRO: A variável GEMINI_API_KEY não está definida no arquivo .env");
        process.exit(1);
    }
    
    await atualizarCalendariosBackground();
    console.log("Teste concluído. Verifique a pasta 'cache' para ver se o arquivo JSON foi criado.");
})();
