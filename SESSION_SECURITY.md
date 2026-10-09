# Sessão em cookie HttpOnly

O login não retorna JWT ao JavaScript. A sessão fica em cookie
`__Host-sigaa_session`, com `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/` e sem
`Domain`. A opção manter conectado define Max-Age de sete dias; caso contrário,
o cookie dura a sessão do navegador. HTTP sem Secure é permitido somente no
desenvolvimento com host localhost/127.0.0.1. Não há fallback de HTTPS para HTTP.

`GET /api/session` confirma o cookie e retorna apenas usuário, expiração e uma
prova de CSRF. O frontend guarda somente metadados, nunca o JWT. A prova de CSRF
fica em memória; é um HMAC de um nonce aleatório em outro cookie HttpOnly. Login
e qualquer POST com cookie exigem `X-CSRF-Token`. Origens não autorizadas e
pedidos identificados pelo navegador como cross-site são recusados. CORS permite
credenciais somente para a origem da aplicação e a origem local do backend.

`POST /api/logout`, com `{}`, revoga o JWT recebido pelo cookie antes de apagá-lo.
Falhas de armazenamento mantêm a sessão para nova tentativa. Trocar de conta
revoga a sessão anterior. JWTs anteriores à versão 2 são recusados mesmo que
ainda não tenham expirado: a atualização exige novo login.

A interface publicada no GitHub Pages encaminha para
`https://ak4ai-sigaa.duckdns.org/`, que hospeda a interface e a API juntas.
Isso evita depender de cookies de terceiros bloqueados por navegadores.
O endereço antigo apaga seus tokens locais antes de encaminhar. Preferências e
perfis salvos são específicos de cada origem e não são transferidos ao servidor.

As credenciais continuam criptografadas dentro do JWT no cookie. Migrar para um
identificador de sessão com credenciais somente no servidor é uma etapa separada.

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
