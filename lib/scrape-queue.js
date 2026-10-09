class ScrapeQueue {
    constructor(maxWaiting = 10) {
        this.maxWaiting = maxWaiting;
        this.waiting = [];
        this.identities = new Set();
        this.active = null;
        this.times = [];
    }

    enqueue({ identity, clientId, signal, run }) {
        if (this.identities.has(identity)) return Promise.reject(Object.assign(new Error('Já existe uma consulta para esta conta.'), { status: 409 }));
        if (this.active && this.waiting.length >= this.maxWaiting) return Promise.reject(Object.assign(new Error('Fila cheia. Tente novamente em instantes.'), { status: 429 }));
        if (signal.aborted) return Promise.reject(signal.reason);
        return new Promise((resolve, reject) => {
            const job = { identity, clientId, signal, run, resolve, reject };
            job.cancel = () => {
                const index = this.waiting.indexOf(job);
                if (index === -1) return;
                this.waiting.splice(index, 1);
                this.release(job);
                reject(signal.reason);
            };
            this.identities.add(identity);
            signal.addEventListener('abort', job.cancel, { once: true });
            this.waiting.push(job);
            this.drain();
        });
    }

    release(job) {
        job.signal.removeEventListener('abort', job.cancel);
        this.identities.delete(job.identity);
    }

    async drain() {
        if (this.active || !this.waiting.length) return;
        const job = this.waiting.shift();
        this.active = job;
        const start = Date.now();
        try {
            job.signal.throwIfAborted();
            await job.run();
            if (!job.signal.aborted) {
                this.times.push(Date.now() - start);
                if (this.times.length > 20) this.times.shift();
            }
            job.resolve();
        } catch (error) {
            job.reject(error);
        } finally {
            this.release(job);
            this.active = null;
            this.drain();
        }
    }

    status(clientId) {
        const index = this.waiting.findIndex(job => job.clientId === clientId);
        const position = this.active?.clientId === clientId ? 1 : (index >= 0 ? index + 1 + (this.active ? 1 : 0) : -1);
        return {
            position, queueLength: this.waiting.length, processing: !!this.active,
            avgTimeMs: this.times.length ? Math.round(this.times.reduce((a, b) => a + b, 0) / this.times.length) : 60000
        };
    }
}

module.exports = { ScrapeQueue };
