# Download protegido do calendário

A página do calendário e o PDF usam o mesmo cliente em `lib/calendar-download.js`.
Somente os sites oficiais dos cursos, Divinópolis, Diretoria de Graduação e site
central do CEFET listados em `ALLOWED_HOSTS` são permitidos. Credenciais na URL,
endereços IP literais, outras portas e destinos externos são recusados.

Todas as conexões usam HTTPS com verificação de certificado. Links históricos
HTTP encontrados na página oficial são convertidos para HTTPS antes do pedido;
redirecionamentos que tentam voltar para HTTP são bloqueados.

O DNS é verificado antes da conexão. Endereços privados, locais e reservados são
recusados, inclusive IPv6 e IPv4 mapeado em IPv6. A conexão utiliza os endereços
já verificados, sem uma segunda consulta DNS. Proxies de ambiente são desativados.
Cada redirecionamento passa novamente por essas verificações; são permitidos
no máximo três.

Limites: página HTML de até 2 MiB em 15 segundos; PDF de até 20 MiB em 45 segundos.
O prazo cobre DNS, redirecionamentos e recebimento completo. O limite de bytes
também se aplica ao conteúdo descomprimido. Um arquivo sem assinatura `%PDF-`
ou uma resposta identificada como HTML/JSON não é enviada ao Gemini.

O endpoint de link compartilha consultas simultâneas de um mesmo curso e mantém
o fallback para o último link válido. Se o cron não consegue baixar um PDF,
o cache existente de eventos permanece intacto. A extração via Gemini e o formato
de eventos não foram alterados.

Execute `npm test`. A validação com os PDFs reais dos dois cursos deve ser feita
também na VPS, utilizando `fetchPage`, `selectCalendarPdfLink` e `downloadPdf`,
sem enviar novamente os documentos ao Gemini. Se o CEFET mudar para outro host,
verifique o novo destino oficial antes de ampliar `ALLOWED_HOSTS`.
