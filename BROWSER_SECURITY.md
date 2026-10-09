# Proteções do navegador

O middleware `lib/security-headers.js` aplica CSP, bloqueio de enquadramento,
nosniff, política de referrer e restrição de câmera, microfone e geolocalização.
HSTS de um ano é enviado somente em HTTPS, respeitando o proxy confiável da VPS.
HTTP em localhost permanece disponível para desenvolvimento.

A CSP permite scripts e conexões somente na origem da aplicação. Scripts inline,
atributos de eventos e eval não são permitidos. Os scripts de redirecionamento e
PWA foram extraídos para arquivos locais, incluídos no cache do service worker.
A API utiliza a mesma origem da interface, sem injetar JavaScript no HTML.

Estilos inline permanecem permitidos para preservar os estilos dinâmicos da
interface. Google Fonts é permitido apenas nos destinos de CSS e fontes usados
pela aplicação. Imagens locais, data e blob continuam funcionando. Objetos,
iframes, enquadramento por terceiros e alteração da URL base são bloqueados.

O teste de navegador verifica os fluxos normais sem violações de CSP e confirma
que scripts inline e handlers injetados são bloqueados. Execute `npm test` no
backend e `node tests/login-profile-browser.cjs` no frontend.
