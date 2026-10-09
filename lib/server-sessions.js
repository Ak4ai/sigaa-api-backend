const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
let database;
const fingerprint = id => crypto.createHash('sha256').update(id).digest('hex');
const validId = id => typeof id === 'string' && /^s3_[A-Za-z0-9_-]{43}$/.test(id);
function encryptionKey() {
    if (process.env.ENC_SECRET?.length !== 32 || process.env.ENC_SECRET_USER?.length !== 32) throw new Error('Invalid session encryption keys');
    return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(process.env.ENC_SECRET), Buffer.from(process.env.ENC_SECRET_USER), Buffer.from('sigaa-server-sessions-v3'), 32));
}
function store() {
    if (process.env.VERCEL) throw new Error('Sessions require persistent VPS storage');
    if (database) return database;
    const folder = process.env.SESSION_DATA_DIR || path.resolve(__dirname, '../data/sessions');
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    fs.chmodSync(folder, 0o700);
    const filename = path.join(folder, 'sessions.sqlite');
    fs.closeSync(fs.openSync(filename, 'a', 0o600));
    fs.chmodSync(filename, 0o600);
    database = new DatabaseSync(filename, { timeout: 5000 });
    database.exec('PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, expires INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);');
    fs.chmodSync(path.join(folder, 'sessions.sqlite'), 0o600);
    cleanup();
    return database;
}
function cleanup() { if (database) database.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now()); }
function encrypt(value, identity) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
    cipher.setAAD(Buffer.from(identity));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}
function decrypt(value, identity) {
    const bytes = Buffer.from(value, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(identity));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
}
function duration(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value * 1000;
    const match = /^(\d+)([smhd])$/.exec(value || '7d');
    if (!match) throw new Error('Invalid session duration');
    return Number(match[1]) * ({s:1000,m:60000,h:3600000,d:86400000}[match[2]]);
}
function create(payload, lifetime = '7d', previous) {
    const id = 's3_' + crypto.randomBytes(32).toString('base64url');
    const key = fingerprint(id);
    const exp = Math.floor((Date.now() + duration(lifetime)) / 1000);
    const ciphertext = encrypt({...payload, exp, jti: key}, key), db = store();
    db.exec('BEGIN IMMEDIATE');
    try {
        db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(key, ciphertext, exp * 1000);
        if (validId(previous)) db.prepare('DELETE FROM sessions WHERE id = ?').run(fingerprint(previous));
        db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return id;
}
function read(id) {
    if (!validId(id)) return null; // All credential-bearing JWTs are invalidated.
    const key = fingerprint(id), db = store();
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(key);
    if (!row) return null;
    if (row.expires <= Date.now()) { db.prepare('DELETE FROM sessions WHERE id = ?').run(key); return null; }
    try {
        const payload = decrypt(row.ciphertext, key);
        if (payload.exp * 1000 !== row.expires || payload.exp * 1000 <= Date.now()) throw new Error('Invalid expiration');
        return payload;
    }
    catch { db.prepare('DELETE FROM sessions WHERE id = ?').run(key); return null; }
}
function remove(id) {
    if (!validId(id)) return false;
    store().prepare('DELETE FROM sessions WHERE id = ?').run(fingerprint(id));
    return true;
}
const timer = setInterval(() => {
    try { cleanup(); } catch (error) { console.error('[sessions] Cleanup failed:', error.code || error.name); }
}, 600000);
timer.unref();
module.exports = { create, read, remove, cleanup };
