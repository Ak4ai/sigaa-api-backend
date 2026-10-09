const axios = require('axios');
const cheerio = require('cheerio');
const dns = require('node:dns').promises;
const net = require('node:net');
const { createCefetHttpsAgent } = require('./cefet-tls');

const ALLOWED_HOSTS = new Set([
    'www.eng-mecatronica.divinopolis.cefetmg.br',
    'www.eng-computacao.divinopolis.cefetmg.br',
    'www.dirgrad.cefetmg.br', 'dirgrad.cefetmg.br',
    'www.divinopolis.cefetmg.br', 'divinopolis.cefetmg.br',
    'www.cefetmg.br', 'cefetmg.br'
]);
const PAGES = Object.freeze({
    mecatronica: 'https://www.eng-mecatronica.divinopolis.cefetmg.br/calendario-letivo/',
    computacao: 'https://www.eng-computacao.divinopolis.cefetmg.br/2019/03/18/calendario-letivo/'
});
const LIMITS = Object.freeze({ htmlBytes: 2 * 1024 * 1024, pdfBytes: 20 * 1024 * 1024, htmlTimeoutMs: 15000, pdfTimeoutMs: 45000, redirects: 3 });
const blockedV4 = new net.BlockList();
for (const [address, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4]
]) blockedV4.addSubnet(address, prefix, 'ipv4');
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new net.BlockList();
blockedV6.addSubnet('2001::', 23, 'ipv6');
blockedV6.addSubnet('2001:db8::', 32, 'ipv6');
blockedV6.addSubnet('2002::', 16, 'ipv6');

function isPublicAddress(address) {
    const family = net.isIP(address);
    return family === 4 ? !blockedV4.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
}
function validateCalendarUrl(input, base) {
    const url = new URL(input, base);
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname) || url.username || url.password || url.port && url.port !== '443') {
        throw new Error('Destino do calendário não autorizado.');
    }
    url.hash = '';
    return url;
}
function selectCalendarPdfLink(html, pageUrl) {
    const $ = cheerio.load(html);
    function candidate(element) {
        const href = $(element).attr('href');
        if (!href) return null;
        try {
            const url = new URL(href, pageUrl);
            // Historical CEFET links use HTTP; request their HTTPS counterpart only.
            if (url.protocol === 'http:' && ALLOWED_HOSTS.has(url.hostname) && !url.port) url.protocol = 'https:';
            const safe = validateCalendarUrl(url);
            return /\.pdf$/i.test(safe.pathname) ? safe.href : null;
        } catch { return null; }
    }
    for (const element of $('ul.wp-block-list a').toArray()) {
        const link = candidate(element);
        if (link) return link;
    }
    for (const element of $('a').toArray()) {
        if (/calend[aá]rio/i.test($(element).text())) {
            const link = candidate(element);
            if (link) return link;
        }
    }
    return null;
}
function abortable(promise, signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const abort = () => { reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(value => {
            signal.removeEventListener('abort', abort); resolve(value);
        }, error => { signal.removeEventListener('abort', abort); reject(error); });
    });
}
function createCalendarClient({ lookup = (host, options) => dns.lookup(host, options), request = (url, options) => axios.get(url, options), limits = {} } = {}) {
    const settings = { ...LIMITS, ...limits };
    async function fetchResource(input, kind) {
        let url = validateCalendarUrl(input);
        const bytes = kind === 'pdf' ? settings.pdfBytes : settings.htmlBytes;
        const timeout = kind === 'pdf' ? settings.pdfTimeoutMs : settings.htmlTimeoutMs;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('Tempo limite do download do calendário excedido.')), timeout);
        try {
            for (let redirects = 0; redirects <= settings.redirects; redirects++) {
                const addresses = await abortable(lookup(url.hostname, { all: true, verbatim: true }), controller.signal);
                if (!Array.isArray(addresses) || !addresses.length || addresses.some(a => !isPublicAddress(a.address) || net.isIP(a.address) !== a.family)) {
                    throw new Error('O endereço do calendário resolve para uma rede não autorizada.');
                }
                const expectedHost = url.hostname;
                const pinnedLookup = (host, options, callback) => {
                    if (typeof options === 'function') { callback = options; options = {}; }
                    if (host !== expectedHost) return callback(new Error('Host inesperado no download.'));
                    if (options?.all) return callback(null, addresses.map(a => ({ address: a.address, family: a.family })));
                    const address = addresses.find(a => !options?.family || a.family === options.family);
                    if (!address) return callback(new Error('Família de endereço indisponível.'));
                    callback(null, address.address, address.family);
                };
                const agent = createCefetHttpsAgent({ lookup: pinnedLookup });
                let response;
                try {
                    response = await abortable(request(url.href, {
                        responseType: 'arraybuffer', httpsAgent: agent, proxy: false,
                        headers: { 'User-Agent': 'Mozilla/5.0', Accept: kind === 'pdf' ? 'application/pdf,application/octet-stream;q=0.9' : 'text/html' },
                        maxRedirects: 0, maxContentLength: bytes, maxBodyLength: bytes,
                        timeout, signal: controller.signal, validateStatus: () => true
                    }), controller.signal);
                } finally { agent.destroy(); }
                if ([301, 302, 303, 307, 308].includes(response.status)) {
                    if (redirects === settings.redirects || !response.headers.location) throw new Error('Redirecionamentos excessivos ou inválidos no calendário.');
                    url = validateCalendarUrl(response.headers.location, url);
                    continue;
                }
                if (response.status !== 200) throw new Error(`Calendário indisponível (HTTP ${response.status}).`);
                const data = Buffer.from(response.data);
                if (data.length > bytes) throw new Error('Arquivo do calendário excede o tamanho permitido.');
                if (kind === 'pdf' && (!data.subarray(0, 5).equals(Buffer.from('%PDF-')) || /text\/html|application\/json/i.test(response.headers['content-type'] || ''))) {
                    throw new Error('O arquivo recebido não é um PDF válido.');
                }
                return { data, url: url.href };
            }
        } finally { clearTimeout(timer); }
    }
    return {
        fetchPage: async url => { const response = await fetchResource(url, 'html'); return { html: response.data.toString('utf8'), url: response.url }; },
        downloadPdf: url => fetchResource(url, 'pdf')
    };
}
const client = createCalendarClient();
module.exports = { ...client, createCalendarClient, validateCalendarUrl, selectCalendarPdfLink, isPublicAddress, PAGES, LIMITS };
