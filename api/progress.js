/**
 * progress.js — Rastreamento de progresso de scraping em tempo real
 * Usado por: server.js (pool de progresso) e scraper.js (atualizar progresso)
 */

const progressTracker = new Map(); // clientId → { progress: 0-100, status: "..." }
const PROGRESS_CLEANUP_MS = 5 * 60 * 1000; // limpar depois de 5 min

function setProgress(clientId, progress, status) {
    progressTracker.set(clientId, { progress, status, lastUpdate: Date.now() });
}

function getProgress(clientId) {
    if (!clientId || !progressTracker.has(clientId)) {
        return { progress: 0, status: 'Iniciando...' };
    }
    return progressTracker.get(clientId);
}

function clearProgress(clientId) {
    progressTracker.delete(clientId);
}

// Limpeza automática de progresso antigo
setInterval(() => {
    const now = Date.now();
    for (const [clientId, data] of progressTracker.entries()) {
        if (now - data.lastUpdate > PROGRESS_CLEANUP_MS) {
            progressTracker.delete(clientId);
        }
    }
}, PROGRESS_CLEANUP_MS);

module.exports = { setProgress, getProgress, clearProgress };
