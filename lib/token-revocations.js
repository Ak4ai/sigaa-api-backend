const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const directory = path.resolve(process.env.TOKEN_REVOCATION_DIR || path.join(__dirname, '../data/token-revocations'));
const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
let lastCleanup = 0;

function fingerprint(token, payload) {
    // Canonicalização também cobre tokens antigos sem jti e variantes de base64.
    const identity = payload.jti
        ? `jti:${payload.jti}`
        : token.split('.').map(part => Buffer.from(part, 'base64url').toString('base64url')).join('.');
    return crypto.createHash('sha256').update(identity).digest('hex');
}

function configuration() {
    if (redisUrl || redisToken) {
        if (!redisUrl || !redisToken || new URL(redisUrl).protocol !== 'https:') {
            throw new Error('Configure URL HTTPS e token do armazenamento de revogações.');
        }
        return 'redis';
    }
    if (process.env.VERCEL) {
        throw new Error('Revogações em serverless exigem armazenamento Redis compartilhado.');
    }
    return 'file';
}

async function redisCommand(command) {
    const response = await fetch(redisUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(5000),
        redirect: 'error'
    });
    if (!response.ok) throw new Error('Armazenamento de revogações indisponível.');
    const data = await response.json();
    if (data.error || !Object.hasOwn(data, 'result')) throw new Error('Resposta inválida do armazenamento de revogações.');
    return data.result;
}

async function isRevoked(token, payload) {
    const hash = fingerprint(token, payload);
    if (configuration() === 'redis') {
        const result = await redisCommand(['EXISTS', `sigaa:revoked:${hash}`]);
        if (result !== 0 && result !== 1) throw new Error('Resposta inválida do armazenamento de revogações.');
        return result === 1;
    }
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
        await fs.stat(path.join(directory, `${hash}-${payload.exp}.revoked`));
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

async function revoke(token, payload) {
    const hash = fingerprint(token, payload);
    if (configuration() === 'redis') {
        const result = await redisCommand(['SET', `sigaa:revoked:${hash}`, '1', 'EXAT', payload.exp]);
        if (result !== 'OK') throw new Error('Revogação não foi confirmada pelo armazenamento.');
        return;
    }
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    // Arquivo vazio: sua criação exclusiva é atômica entre processos.
    try {
        await fs.writeFile(path.join(directory, `${hash}-${payload.exp}.revoked`), '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
    // A limpeza é independente da confirmação da revogação.
    if (Date.now() - lastCleanup > 60000) {
        lastCleanup = Date.now();
        const now = Math.floor(Date.now() / 1000);
        fs.readdir(directory).then(names => Promise.all(names.map(name => {
            const match = /^[a-f0-9]{64}-(\d+)\.revoked$/.exec(name);
            if (match && Number(match[1]) <= now) return fs.unlink(path.join(directory, name)).catch(() => {});
        }))).catch(() => {});
    }
}

module.exports = { isRevoked, revoke };
