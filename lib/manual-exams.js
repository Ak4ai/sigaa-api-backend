const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { validarTokenLogin } = require('../api/auth');
let database;
const cacheDir = () => process.env.EXAM_CACHE_DIR || path.resolve(__dirname, '../cache');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const normalized = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s*\([^)]*\)\s*$/, '').trim();
function db() {
    if (process.env.VERCEL) throw new Error('Manual exams require the persistent VPS database');
    if (database) return database;
    const dir = process.env.EXAM_DATA_DIR || path.resolve(__dirname, '../data/exams');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    database = new DatabaseSync(path.join(dir, 'exams.sqlite'), { timeout: 5000 });
    database.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS access (token TEXT PRIMARY KEY, owner TEXT, expires INTEGER, classes TEXT);
      CREATE TABLE IF NOT EXISTS terms (course TEXT PRIMARY KEY, term TEXT);
      CREATE TABLE IF NOT EXISTS exams (id TEXT PRIMARY KEY, class TEXT, course TEXT, term TEXT, date TEXT, title TEXT, owner TEXT);
      CREATE INDEX IF NOT EXISTS exams_class ON exams(class, term);`);
    database.prepare('INSERT OR IGNORE INTO settings VALUES (?, ?)').run('owner-key', crypto.randomBytes(32).toString('hex'));
    // Legacy entries were public and have neither a verified class nor an author.
    for (const course of ['computacao', 'mecatronica']) {
        const old = path.join(cacheDir(), `provas_${course}.json`);
        if (fs.existsSync(old)) {
            const backup = path.join(dir, `legacy-provas-${course}-${Date.now()}.json`);
            fs.copyFileSync(old, backup);
            fs.chmodSync(backup, 0o600);
            fs.unlinkSync(old);
        }
    }
    fs.chmodSync(path.join(dir, 'exams.sqlite'), 0o600);
    return database;
}
function officialEvents(course) {
    try {
        const value = JSON.parse(fs.readFileSync(path.join(cacheDir(), `calendario_${course}.json`), 'utf8'));
        return Array.isArray(value) ? value : Array.isArray(value.eventos) ? value.eventos : [];
    } catch { return []; }
}
function endOfTerm(course, term) {
    const [year, half] = term.split('.').map(Number);
    return officialEvents(course).filter(e => /fim.*aulas|t[eé]rmino.*(semestre|per[ií]odo)/i.test(`${e.tipo} ${e.titulo}`))
        .map(e => String(e.data || '').slice(0, 10)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) &&
            (half === 1 ? d >= `${year}-01-01` && d <= `${year}-08-31` : d >= `${year}-09-01` && d <= `${year + 1}-04-30`)).sort()[0];
}
function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function cleanup() {
    const store = db();
    store.prepare('DELETE FROM access WHERE expires <= ?').run(Date.now());
    for (const row of store.prepare('SELECT DISTINCT course, term FROM exams').all()) {
        const end = endOfTerm(row.course, row.term);
        if (end && end < today()) store.prepare('DELETE FROM exams WHERE course = ? AND term = ?').run(row.course, row.term);
    }
}
async function recordAcademicAccess(token, institution, schedule, turmas) {
    if (!token || !institution['Nome do Usuario']) return null;
    const payload = await validarTokenLogin(token);
    if (!payload?.user) return null;
    const course = normalized(institution.Curso).includes('COMPUTACAO') ? 'computacao' : 'mecatronica';
    const classes = [];
    for (const item of schedule) {
        const match = String(item.semestre).match(/\b(20\d{2})\s*[.\/-]\s*([12])\b/);
        if (!match || !item.turma || !item.disciplina) continue;
        const term = `${match[1]}.${match[2]}`;
        // Portal IDs can be absent or ambiguous when two groups share a title.
        // The schedule contains the actual discipline and group confirmed by SIGAA.
        const identity = `${normalized(item.disciplina)}:${normalized(item.turma)}`;
        const id = hash(`${course}:${term}:${identity}`);
        if (!classes.some(c => c.id === id)) classes.push({ id, disciplina: item.disciplina, turma: item.turma, semestre: term, curso: course });
    }
    const latest = classes.map(c => c.semestre).sort().at(-1);
    const active = classes.filter(c => c.semestre === latest);
    const store = db();
    const owner = crypto.createHmac('sha256', store.prepare('SELECT value FROM settings WHERE key = ?').get('owner-key').value).update(payload.user).digest('hex');
    store.exec('BEGIN IMMEDIATE');
    try {
        const previous = store.prepare('SELECT term FROM terms WHERE course = ?').get(course)?.term;
        if (latest && (!previous || latest > previous)) {
            store.prepare('INSERT OR REPLACE INTO terms VALUES (?, ?)').run(course, latest);
            store.prepare('DELETE FROM exams WHERE course = ? AND term < ?').run(course, latest);
        }
        store.prepare('INSERT OR REPLACE INTO access VALUES (?, ?, ?, ?)').run(hash(token), owner, Math.min(payload.exp * 1000, Date.now() + 86400000), JSON.stringify(active));
        store.exec('COMMIT');
    } catch (error) { store.exec('ROLLBACK'); throw error; }
    cleanup();
    return { cursoCalendario: course, turmasParaProvas: active };
}
async function getAccess(token) {
    cleanup();
    if (!token || !await validarTokenLogin(token)) return null;
    const row = db().prepare('SELECT * FROM access WHERE token = ? AND expires > ?').get(hash(token), Date.now());
    if (!row) return null;
    row.classes = JSON.parse(row.classes).filter(c => {
        const current = db().prepare('SELECT term FROM terms WHERE course = ?').get(c.curso)?.term;
        const end = endOfTerm(c.curso, c.semestre);
        return c.semestre === current && (!end || end >= today());
    });
    return row;
}
function list(access, course) {
    if (!access) return { turmas: [], eventos: [] };
    const turmas = access.classes.filter(c => c.curso === course).map(c => ({ ...c, provasCadastradas: db().prepare('SELECT COUNT(*) AS n FROM exams WHERE class = ? AND term = ?').get(c.id, c.semestre).n, limite: 6 }));
    const eventos = turmas.flatMap(c => db().prepare('SELECT * FROM exams WHERE class = ? AND term = ?').all(c.id, c.semestre).map(e => ({ id: e.id, data: e.date, titulo: e.title, disciplina: c.disciplina, turma: c.turma, semestre: c.semestre, tipo: 'prova', manual: true, porOutroUsuario: e.owner !== access.owner })));
    return { turmas, eventos };
}
function add(access, body) {
    const turma = access.classes.find(c => c.id === body.turmaId);
    if (!turma) return { status: 403, error: 'Turma não autorizada. Atualize seus dados no SIGAA.' };
    const date = body.data;
    const title = typeof body.titulo === 'string' ? body.titulo.trim() : '';
    const end = endOfTerm(turma.curso, turma.semestre);
    const [year, half] = turma.semestre.split('.').map(Number);
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date < today() || date < `${year}-01-01` || date > (end || `${year + (half === 2 ? 1 : 0)}-${half === 2 ? '06-30' : '08-31'}`) || !title || title.length > 120) return { status: 400, error: 'Informe um título de até 120 caracteres e uma data válida neste semestre.' };
    const store = db();
    store.exec('BEGIN IMMEDIATE');
    try {
        if (store.prepare('SELECT term FROM terms WHERE course = ?').get(turma.curso)?.term !== turma.semestre) {
            store.exec('ROLLBACK');
            return { status: 410, error: 'Este semestre foi encerrado. Atualize suas turmas.' };
        }
        const duplicate = store.prepare('SELECT id FROM exams WHERE class = ? AND term = ? AND date = ? AND title = ?').get(turma.id, turma.semestre, date, title);
        const count = store.prepare('SELECT COUNT(*) AS n FROM exams WHERE class = ? AND term = ?').get(turma.id, turma.semestre).n;
        if (!duplicate && count >= 6) { store.exec('ROLLBACK'); return { status: 409, error: 'Esta turma já tem seis provas manuais neste semestre.' }; }
        if (!duplicate) store.prepare('INSERT INTO exams VALUES (?, ?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), turma.id, turma.curso, turma.semestre, date, title, access.owner);
        store.exec('COMMIT');
        return { status: 200, success: true };
    } catch (error) { store.exec('ROLLBACK'); throw error; }
}
module.exports = { recordAcademicAccess, getAccess, list, add, officialEvents, cleanup };
const cleanupTimer = setInterval(() => {
    if (!database) return;
    try { cleanup(); } catch (error) { console.error('[manual-exams] Falha na limpeza:', error.code || error.name); }
}, 3600000);
cleanupTimer.unref();
