const axios = require('axios');
const { load } = require('cheerio');
const { CookieJar } = require('tough-cookie');
const { createCefetHttpsAgent } = require('./cefet-tls');
const origin = 'https://sig.cefetmg.br';
function failure(status, message, type) { return Object.assign(new Error(message), { status, type }); }
function createVerifier({ request = options => axios.request(options) } = {}) {
    return async function verifySigaaLogin(user, pass, signal = AbortSignal.timeout(30000)) {
        const jar = new CookieJar();
        const agent = createCefetHttpsAgent();
        async function send(path, method = 'GET', data) {
            let url = new URL(path, origin);
            for (let i = 0; i <= 5; i++) {
                signal.throwIfAborted();
                if (url.origin !== origin) throw failure(503, 'Redirecionamento inesperado na autenticação do SIGAA.');
                const response = await request({
                    url: url.href, method, data, signal, proxy: false, httpsAgent: agent,
                    timeout: 15000, maxRedirects: 0, maxContentLength: 2 * 1024 * 1024,
                    maxBodyLength: 16 * 1024, validateStatus: () => true,
                    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.getCookieStringSync(url.href) }
                });
                for (const cookie of response.headers['set-cookie'] || []) jar.setCookieSync(cookie, url.href);
                if ([301,302,303,307,308].includes(response.status)) {
                    if (i === 5 || !response.headers.location) throw failure(503, 'Redirecionamentos inválidos no SIGAA.');
                    url = new URL(response.headers.location, url);
                    if (response.status === 303 || method === 'POST' && [301,302].includes(response.status)) { method = 'GET'; data = undefined; }
                    continue;
                }
                if (response.status !== 200 || typeof response.data !== 'string') throw failure(503, 'O SIGAA está temporariamente indisponível.');
                return response.data;
            }
        }
        function pending(html) {
            return /notifica[cç][oõ]es acad[eê]micas/i.test(load(html)('#conteudo > h2').text()) || /notifica[cç][oõ]es acad[eê]micas pendentes/i.test(html);
        }
        try {
            const loginPage = await send('/sigaa/logar.do?dispatch=logOff');
            const $ = load(loginPage), fields = {};
            $('input[type="hidden"][name]').each((_, element) => { fields[$(element).attr('name')] = $(element).attr('value') || ''; });
            const params = new URLSearchParams({ ...fields, 'user.login': user, 'user.senha': pass });
            const result = await send('/sigaa/logar.do?dispatch=logOn', 'POST', params.toString());
            if (pending(result)) throw failure(403, 'Visualize suas notificações acadêmicas no SIGAA e tente novamente.', 'ACADEMIC_NOTIFICATIONS_PENDING');
            if (/usu[aá]rio e\/ou senha inv[aá]lid|dados incorretos|falha na autentica[cç][aã]o/i.test(result) || load(result)('input[name="user.senha"]').length) {
                throw failure(401, 'Usuário e/ou senha inválidos.');
            }
            const portal = await send('/sigaa/portais/discente/discente.jsf');
            if (pending(portal)) throw failure(403, 'Visualize suas notificações acadêmicas no SIGAA e tente novamente.', 'ACADEMIC_NOTIFICATIONS_PENDING');
            const doc = load(portal);
            if (doc('input[name="user.senha"]').length || !doc('#info-usuario p.usuario span').first().text().trim()) throw failure(401, 'Não foi possível confirmar o login no SIGAA.');
            signal.throwIfAborted();
            return true;
        } finally { agent.destroy(); }
    };
}
module.exports = { createVerifier, verifySigaaLogin: createVerifier() };
