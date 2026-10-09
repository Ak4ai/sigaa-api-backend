# Logout e transporte dos tokens

O frontend envia credenciais e tokens apenas por HTTPS. HTTP é permitido somente
quando tanto a página quanto a API estão em localhost/loopback. Falhas de HTTPS e
redirecionamentos não provocam reenvio por HTTP.

`POST /api/logout`, com `{ "token": "..." }`, revoga a sessão até sua expiração.
Novos JWTs têm `jti` único. Tokens antigos sem `jti` são identificados por um hash
SHA-256 do token canonizado. O armazenamento não contém usuário, senha ou JWT.
Logout repetido e logout de token expirado são seguros e retornam sucesso.

## VPS e desenvolvimento local

Por padrão, as revogações ficam em `data/token-revocations/`, ignorado pelo Git.
Elas sobrevivem à reinicialização do processo. Os processos no mesmo servidor
precisam usar o mesmo diretório. Não apague esse diretório durante deploys.
Para mantê-lo fora do checkout, configure `TOKEN_REVOCATION_DIR` para um diretório
persistente com permissão de escrita para o usuário que executa o backend.

## Serverless e servidores diferentes

Configure `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN` no ambiente, usando
um banco compartilhado, persistente e sem remoção de chaves antes do TTL.
Todos os servidores precisam usar esse mesmo banco. O cliente usa o protocolo
[Redis REST](https://upstash.com/docs/redis/features/restapi), via HTTPS, com
`EXISTS` e `SET ... EXAT`. Configure o endpoint primário para consistência de leitura.
Não salve credenciais reais nos arquivos versionados.

Em Vercel, o backend recusa consultas com token e logout se Redis não estiver
configurado; o disco efêmero não é usado como alternativa. Se o armazenamento
falhar, a API retorna 503 e o frontend mantém a sessão local para permitir uma
nova tentativa de logout.

Publique primeiro o backend e depois o frontend. O logout já pode revogar tokens
emitidos antes dessa atualização, sem trocar os segredos existentes. Consultas
que já estavam em andamento podem terminar no servidor; o frontend descarta
resultados recebidos depois do logout.

Execute `npm test` no backend para verificar revogação, persistência, tokens
antigos, falhas de armazenamento e as rotas Express. No diretório do frontend,
execute `node --test tests/session-security.test.js` para verificar o transporte
HTTPS e a confirmação do logout antes de apagar os dados locais.
