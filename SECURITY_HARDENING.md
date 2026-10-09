# Proteções de renderização, recursos e dependências

## Dados externos no frontend

Novidades, atividades, dados institucionais, notas e tabelas de horários usam
`textContent` para exibir texto recebido do SIGAA ou do armazenamento local.
Templates estruturados de comparação e resumo escapam os campos externos antes
de inserir HTML. Rótulos de links do Google Agenda também são escapados e links
de calendário só aceitam os esquemas HTTP e HTTPS.

As bibliotecas de PDF são distribuídas pelo próprio frontend, em `vendor/`, com
versões, hashes e licenças registradas. Para atualizá-las após instalar os pacotes
de desenvolvimento, execute `npm run sync:pdf`. Se o frontend estiver em outro
diretório, configure `SIGAA_FRONTEND_DIR`.

## Limites do backend

- Login: 20 requisições por IP em 10 minutos.
- Consultas: 30 requisições por IP em 10 minutos.
- API e polling: 3000 requisições por IP por minuto.
- Uma consulta em execução e até 10 em espera; consulta duplicada para a mesma
  conta retorna 409. Fila cheia ou cota excedida retorna 429 com `Retry-After`.
- Prazo de 150 segundos para o pedido inteiro, incluindo espera; execução de até
  120 segundos. O limite que vencer primeiro retorna 504 e cancela as chamadas
  HTTP ao SIGAA por `AbortSignal`.
- Desconexão remove pedidos em espera e cancela a consulta em execução. A fila
  só inicia o próximo trabalho depois que o anterior termina, sem liberar
  concorrência enquanto um trabalho ainda estiver cancelando.
- JSON de até 16 KB na aplicação Express; tipos, comprimento de credenciais e
  `clientId` são validados antes da entrada na fila.
- Cada resposta do SIGAA é limitada a 2 MB; os caches de progresso e entidades
  HTML também têm limite de entradas. Mensagens internas não são retornadas ao
  cliente como erro bruto. Respostas da API não entram no cache do service worker.

Os valores podem ser ajustados pelas variáveis documentadas em `.env.example`.
Cotas e fila são locais a **um processo Node**, incluindo nas funções serverless.
Para várias instâncias, aplique também limites centralizados no proxy ou em um
armazenamento compartilhado. Não assuma uma fila global entre funções Vercel.
IPs de uma rede ou campus podem compartilhar cotas; ajuste os limites conforme
o tráfego legítimo dessa rede.

O servidor escuta em `127.0.0.1` por padrão, com confiança apenas no proxy local.
Configure `HOST` e `TRUST_PROXY` explicitamente se a topologia for diferente.
Nginx deve aguardar pelo menos 180 segundos pela resposta do upstream para que o
prazo do backend seja aplicado; as configurações locais foram ajustadas.

## Dependências e publicação

Use Node **22.12 ou superior** (o ambiente testado usa Node 24). Instale com
`npm ci` para reproduzir o lockfile. Em produção, use `npm ci --omit=dev`.
Puppeteer e as ferramentas de PDF são dependências de desenvolvimento. O scraper
ativo usa Axios/Cheerio; o pacote Chromium e o pacote externo `crypto` foram
removidos. A criptografia continua usando o módulo nativo do Node.

`node_modules` fica apenas no disco local, ignorado pelo Git; o lockfile é
versionado. Ao publicar, inclua os arquivos `vendor/` do frontend e reinicie o
backend. Não restaure `node_modules` antigo de ZIPs de implantação.

## Verificação

No backend: `npm test`, `npm audit` e `npm audit --omit=dev`.
No frontend: `node --test tests/session-security.test.js` e
`node tests/login-profile-browser.cjs`.

Os testes do navegador injetam HTML malicioso em dados, notas, horários,
frequências, novidades e atividades; verificam exibição literal, ausência de
elementos executáveis e bloqueio de URL `javascript:`. Os testes HTTP exercitam
cotas, fila cheia, duplicação, desconexão, limite de corpo e expiração do pedido.
As requisições de teste usam fixtures e não acessam o SIGAA com credenciais reais.

O TLS das conexões CEFET foi habilitado com o certificado intermediário oficial
RNP/GlobalSign em `certs/rnp-icpedu-2025.crt`, verificado contra as raízes confiáveis
do Node. A validação de cadeia, hostname e expiração permanece ativa. Esse arquivo
é público e deve acompanhar a publicação de `lib/cefet-tls.js`.

A autorização da gravação de provas e os limites do download de PDFs continuam
pendentes. A rotação dos segredos invalida sessões antigas; o frontend oferece
novo login ao receber 401, preservando as consultas salvas.
