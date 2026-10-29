# SIGAA API (back-end)

API em **Node.js** que dá suporte ao [aplicativo web de consulta do SIGAA](https://github.com/Ak4ai/Sigaa-API-webapp): autentica o aluno no SIGAA do CEFET-MG e entrega horários, notas, frequências, novidades e calendário em JSON. É a base técnica do projeto de extensão **SAFE – Sistema de Acompanhamento Familiar do Estudante** (CEFET-MG).

> Projeto acadêmico e não oficial. Ele acessa o SIGAA em nome do próprio usuário, com as credenciais que ele informa, e foi desenhado para **não sobrecarregar o sistema institucional**.

## O que ele faz

- **Login validado no SIGAA:** a sessão só é criada depois que o login HTTPS no SIGAA funciona e o portal identifica o aluno. Credenciais inválidas, avisos pendentes, timeouts e falhas do SIGAA não criam sessão.
- **Consultas ao SIGAA** (`/api/scraper`): horários, frequências, notas, novidades e dados do aluno, com progresso consultável (`/api/scraper-progress`).
- **Calendário** (`/api/calendario`, `/api/calendario/eventos`).
- **Fila de consultas:** uma consulta roda por vez e até 10 ficam em espera. Uma segunda consulta da mesma conta recebe `409`. Fila cheia ou cota excedida recebe `429` com `Retry-After`. A posição na fila pode ser vista em `/api/queue-status`.
- **Prazo e cancelamento:** 150 s para o pedido inteiro (incluindo a espera) e 120 s de execução. Ao estourar, a API devolve `504` e cancela as chamadas ao SIGAA com `AbortSignal`.

## Segurança

| Área | Como é tratada |
|---|---|
| Sessão | Cookie `HttpOnly`, `Secure`, `SameSite=Lax` com um identificador opaco de 256 bits. Só o hash SHA-256 do identificador fica no SQLite do servidor |
| Credenciais | Cifradas no servidor com AES-256-GCM. Nada de senha ou usuário no cookie, nos logs ou no navegador |
| Validade | 7 dias com "manter conectado" e 12 horas sem. Logout apaga o registro no servidor |
| Limites por IP | Login: 20 por 10 min. Consultas: 30 por 10 min. API e polling: 3000 por minuto |
| Navegador | CSRF, verificação de origem, CSP e cabeçalhos de segurança (`lib/security-headers.js`) |
| Falha segura | Se o armazenamento de sessão falhar, a API recusa em vez de seguir sem proteção |

Detalhes em [`SESSION_SECURITY.md`](SESSION_SECURITY.md), [`SECURITY_HARDENING.md`](SECURITY_HARDENING.md), [`BROWSER_SECURITY.md`](BROWSER_SECURITY.md) e [`CALENDAR_DOWNLOAD_SECURITY.md`](CALENDAR_DOWNLOAD_SECURITY.md).

## Endpoints

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/api/health` | Saúde do serviço |
| `GET` | `/api/session` | Estado da sessão e token CSRF |
| `POST` | `/api/login` | Valida o login no SIGAA e cria a sessão |
| `POST` | `/api/logout` | Apaga a sessão no servidor |
| `ALL` | `/api/scraper` | Consulta os dados do aluno (passa pela fila) |
| `GET` | `/api/scraper-progress` | Progresso da consulta em andamento |
| `GET` | `/api/queue-status` | Posição na fila |
| `ALL` | `/api/calendario`, `/api/calendario/eventos` | Calendário acadêmico |

## Como rodar

Requer **Node.js 24 ou superior**.

```bash
npm install
cp .env.example .env   # preencha SECRET, ENC_SECRET e ENC_SECRET_USER
node server.js
```

Nunca versione o `.env`. Para gerar o PDF do boletim no front-end, `npm run sync:pdf` copia as bibliotecas de PDF para o diretório do app (veja `SECURITY_HARDENING.md`).

## Testes

```bash
npm test
```

Roda `node --test` em `tests/`, cobrindo sessão e cookies, proteção de requisições, login, download de calendário, turmas e períodos letivos e provas manuais.

## Deploy

`deploy.sh` chama `scripts/deploy-controlled.py`, que faz um deploy controlado:

1. clona uma release limpa e instala pelo lockfile;
2. roda os testes e a auditoria de dependências;
3. sobe uma **cópia candidata** em porta local separada e verifica saúde e logout;
4. só então troca o Nginx, espera as consultas antigas terminarem e inicia o serviço permanente (`systemd`);
5. se qualquer validação falhar, restaura a configuração e o back-end anteriores.

Segredos ficam fora do Git, em um diretório compartilhado com permissão `600`. Veja [`DEPLOY_SETUP.md`](DEPLOY_SETUP.md).

## Documentação

[`FLOW_DIAGRAM.md`](FLOW_DIAGRAM.md) (fluxo geral) · [`HTTP_REQUESTS_MAP.md`](HTTP_REQUESTS_MAP.md) (requisições ao SIGAA) · [`SCRAPER_DOCS.md`](SCRAPER_DOCS.md) · [`ISOLATED_RUNTIME.md`](ISOLATED_RUNTIME.md) · [`MANUAL_EXAMS.md`](MANUAL_EXAMS.md)

## Stack

Node.js · Express · axios · cheerio · tough-cookie · SQLite (sessões) · testes com `node --test`

---

Feito por [Henrique de Freitas Araújo](https://github.com/Ak4ai) no CEFET-MG, Campus Divinópolis.
