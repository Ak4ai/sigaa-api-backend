const crypto = require('crypto');
const { ScrapeQueue } = require('./scrape-queue');
const identityKey = crypto.randomBytes(32);

function setting(name, fallback, max = 1000000) {
    if (!process.env[name]) return fallback;
    const value = Number(process.env[name]);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Configuração inválida: ${name}`);
    return value;
}

const limits = {
    queue: setting('SCRAPER_QUEUE_LIMIT', 10, 100),
    totalMs: setting('SCRAPER_TOTAL_TIMEOUT_MS', 150000, 180000),
    runtimeMs: setting('SCRAPER_RUNTIME_TIMEOUT_MS', 120000, 180000),
    login: setting('LOGIN_RATE_LIMIT', 20),
    scrape: setting('SCRAPER_RATE_LIMIT', 30),
    api: setting('API_RATE_LIMIT', 3000)
};

function createRateLimiter({ limit, windowMs, maxKeys = 10000, now = Date.now }) {
    const clients = new Map();
    const cleanup = setInterval(() => {
        const time = now();
        for (const [key, entry] of clients) if (entry.expires <= time) clients.delete(key);
    }, Math.min(windowMs, 60000));
    cleanup.unref();
    const middleware = (req, res, next) => {
        if (req.method === 'OPTIONS') return next();
        // req.ip usa apenas o proxy confiável configurado no Express.
        const key = req.ip || req.socket?.remoteAddress || 'unknown';
        const time = now();
        let entry = clients.get(key);
        if (entry && entry.expires <= time) { clients.delete(key); entry = null; }
        if (!entry && clients.size < maxKeys) {
            entry = { count: 0, expires: time + windowMs };
            clients.set(key, entry);
        }
        if (!entry || entry.count >= limit) {
            res.setHeader('Retry-After', String(Math.max(1, Math.ceil(((entry?.expires || time + windowMs) - time) / 1000))));
            return res.status(429).json({ error: 'Muitas requisições. Aguarde antes de tentar novamente.' });
        }
        entry.count++;
        return next();
    };
    middleware.dispose = () => clearInterval(cleanup);
    return middleware;
}

function validScrapeBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    if (body.clientId !== undefined && (typeof body.clientId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.clientId))) return false;
    if (body.token !== undefined) return typeof body.token === 'string' && body.token.length > 0 && body.token.length <= 8192;
    return typeof body.user === 'string' && body.user.length > 0 && body.user.length <= 128 &&
        typeof body.pass === 'string' && body.pass.length > 0 && body.pass.length <= 1024;
}

function attachRequestBudget(req, res, { totalMs = limits.totalMs, runtimeMs = limits.runtimeMs } = {}) {
    const controller = new AbortController();
    req.scrapeSignal = controller.signal;
    let runtimeTimer;
    const abort = () => controller.abort(new DOMException('Consulta cancelada.', 'AbortError'));
    const timeout = () => {
        abort();
        if (!res.headersSent && !res.destroyed && !res.writableEnded) res.status(504).json({ error: 'A consulta excedeu o tempo máximo. Tente novamente mais tarde.' });
    };
    const totalTimer = setTimeout(timeout, totalMs);
    totalTimer.unref();
    const onClose = () => { if (!res.writableEnded) abort(); };
    const cleanup = () => {
        clearTimeout(totalTimer);
        clearTimeout(runtimeTimer);
        req.removeListener?.('aborted', abort);
        res.removeListener?.('close', onClose);
        res.removeListener?.('finish', cleanup);
    };
    req.once?.('aborted', abort);
    res.once?.('close', onClose);
    res.once?.('finish', cleanup);
    return {
        signal: controller.signal,
        start() { runtimeTimer = setTimeout(timeout, runtimeMs); runtimeTimer.unref(); },
        cleanup
    };
}

const standaloneLimit = createRateLimiter({ limit: limits.scrape, windowMs: 600000 });
const standaloneQueue = new ScrapeQueue(limits.queue);

function withRateProtection(handler, limit, windowMs = 600000) {
    const check = createRateLimiter({ limit, windowMs });
    return (req, res) => {
        if (!require('./browser-session').prepareBrowserRequest(req, res)) return;

        res.setHeader('Cache-Control', 'no-store');
        if (!req.apiRateLimited) {
            let admitted = false;
            check(req, res, () => { admitted = true; });
            if (!admitted) return;
        }
        return handler(req, res);
    };
}

function withScrapeProtection(handler) {
    return async (req, res) => {
        if (!require('./browser-session').prepareBrowserRequest(req, res)) return;

        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'OPTIONS') return handler(req, res);
        if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
        if (!validScrapeBody(req.body)) return res.status(400).json({ error: 'Parâmetros de consulta inválidos.' });
        // Na VPS, a fila já controla admissão e ciclo de vida do pedido.
        if (req.scrapeSignal) return handler(req, res);
        let admitted = false;
        standaloneLimit(req, res, () => { admitted = true; });
        if (!admitted) return;
        const budget = attachRequestBudget(req, res);
        try {
            let user = req.body.user, pass = req.body.pass;
            if (req.body.token) {
                const payload = await require('../api/auth').validarTokenLogin(req.body.token);
                budget.signal.throwIfAborted();
                if (!payload || !validScrapeBody({ user: payload.user, pass: payload.pass })) {
                    return res.status(401).json({ error: 'Token inválido ou expirado.' });
                }
                if (req.headers?.['x-profile-user'] && req.headers['x-profile-user'] !== payload.user) {
                    return res.status(409).json({ error: 'A conta ativa mudou em outra aba. Entre novamente na conta selecionada.' });
                }
                user = payload.user;
                pass = payload.pass;
            }
            await standaloneQueue.enqueue({
                identity: scrapeIdentity(user, pass), clientId: req.body.clientId || crypto.randomUUID(), signal: budget.signal,
                run: async () => { budget.start(); await handler(req, res); }
            });
        } catch (error) {
            if (budget.signal.aborted || res.headersSent || res.destroyed) return;
            if (error.status === 429) res.setHeader('Retry-After', '60');
            return res.status(error.status || 503).json({ error: error.status ? error.message : 'Não foi possível verificar a sessão.' });
        } finally { budget.cleanup(); }
    };
}

function scrapeIdentity(user, pass) {
    // Não armazenar credenciais e não deixar CPF conhecido bloquear outra senha.
    return crypto.createHmac('sha256', identityKey).update(JSON.stringify([user.trim().toLowerCase(), pass])).digest('hex');
}

module.exports = { limits, createRateLimiter, validScrapeBody, attachRequestBudget, withScrapeProtection, withRateProtection, scrapeIdentity };
