const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createRateLimiter, attachRequestBudget, validScrapeBody, scrapeIdentity } = require('../lib/request-protection');
const { ScrapeQueue } = require('../lib/scrape-queue');

function response() {
    return Object.assign(new EventEmitter(), {
        headers: {}, destroyed: false, writableEnded: false, headersSent: false,
        setHeader(key, value) { this.headers[key] = value; },
        status(code) { this.code = code; return this; },
        json(value) { this.body = value; this.headersSent = true; this.writableEnded = true; this.emit('finish'); return this; }
    });
}

test('rate limits reset by time, do not trust request headers and bound client storage', () => {
    let time = 0, passed = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, maxKeys: 2, now: () => time });
    const req = { method: 'POST', ip: 'client-a', headers: { 'x-forwarded-for': 'forged' } };
    try {
        limiter(req, response(), () => passed++);
        limiter(req, response(), () => passed++);
        const blocked = response();
        limiter({ ...req, headers: { 'x-forwarded-for': 'another-forgery' } }, blocked, () => passed++);
        assert.equal(passed, 2);
        assert.equal(blocked.code, 429);
        assert.equal(blocked.headers['Retry-After'], '1');
        time = 1001;
        limiter(req, response(), () => passed++);
        assert.equal(passed, 3);
        limiter({ method: 'GET', ip: 'client-b' }, response(), () => {});
        const overflow = response();
        limiter({ method: 'GET', ip: 'client-c' }, overflow, () => {});
        assert.equal(overflow.code, 429);
    } finally { limiter.dispose(); }
});

test('body validation rejects unexpected types, oversized credentials and unsafe client IDs', () => {
    assert.equal(validScrapeBody({ user: 'user', pass: ' password ' }), true);
    assert.equal(validScrapeBody({ token: 'a-token', clientId: 'valid_id-123' }), true);
    for (const body of [null, [], { user: {}, pass: 'x' }, { user: 'x', pass: 'a'.repeat(1025) }, { token: 'a'.repeat(8193) }, { token: 'x', clientId: '../other' }]) {
        assert.equal(validScrapeBody(body), false);
    }
    assert.equal(scrapeIdentity('user', 'password'), scrapeIdentity('user', 'password'));
    assert.notEqual(scrapeIdentity('user', 'wrong'), scrapeIdentity('user', 'password'));
});

test('queue caps waiting jobs, rejects duplicate accounts and removes abandoned requests', async () => {
    const queue = new ScrapeQueue(1);
    let finish;
    const gate = new Promise(resolve => { finish = resolve; });
    const a = new AbortController(), b = new AbortController(), c = new AbortController();
    const running = queue.enqueue({ identity: 'a', clientId: 'a', signal: a.signal, run: () => gate });
    const cancelled = assert.rejects(queue.enqueue({ identity: 'b', clientId: 'b', signal: b.signal, run: async () => assert.fail('Cancelled job must not run') }), { name: 'AbortError' });
    assert.equal(queue.status('b').position, 2);
    await assert.rejects(queue.enqueue({ identity: 'c', clientId: 'c', signal: c.signal, run: async () => {} }), { status: 429 });
    await assert.rejects(queue.enqueue({ identity: 'a', clientId: 'other', signal: c.signal, run: async () => {} }), { status: 409 });
    b.abort();
    await cancelled;
    assert.equal(queue.waiting.length, 0);
    assert.equal(queue.identities.size, 1);
    finish();
    await running;
    assert.equal(queue.identities.size, 0);
    assert.equal(queue.active, null);
});

test('disconnect aborts a running budget; normal response does not abort a successful job', () => {
    const req = new EventEmitter(), res = response();
    const budget = attachRequestBudget(req, res);
    res.emit('close');
    assert.equal(budget.signal.aborted, true);
    budget.cleanup();
    assert.equal(res.listenerCount('close'), 0);
    const successful = response();
    const other = attachRequestBudget(new EventEmitter(), successful);
    successful.status(200).json({ ok: true });
    successful.emit('close');
    assert.equal(other.signal.aborted, false);
});

test('waiting deadline returns 504 and removes the job without starting SIGAA requests', async () => {
    const queue = new ScrapeQueue(1);
    let finish;
    const running = queue.enqueue({ identity: 'first', clientId: 'first', signal: new AbortController().signal, run: () => new Promise(resolve => { finish = resolve; }) });
    const res = response();
    const budget = attachRequestBudget(new EventEmitter(), res, { totalMs: 10, runtimeMs: 100 });
    const rejected = assert.rejects(queue.enqueue({ identity: 'waiting', clientId: 'waiting', signal: budget.signal, run: async () => assert.fail('Expired job must not run') }), { name: 'AbortError' });
    await new Promise(resolve => setTimeout(resolve, 25));
    await rejected;
    assert.equal(res.code, 504);
    assert.equal(queue.waiting.length, 0);
    budget.cleanup();
    finish();
    await running;
});

test('HTTP routes enforce payload size, auth rate, queue admission and runtime cancellation', () => {
    const script = `
        const assert = require('node:assert/strict');
        process.env.PORT='0'; process.env.SECRET='test-only-secret';
        process.env.ENC_SECRET='a'.repeat(32); process.env.ENC_SECRET_USER='b'.repeat(32);
        process.env.SCRAPER_QUEUE_LIMIT='1'; process.env.LOGIN_RATE_LIMIT='1';
        process.env.SCRAPER_TOTAL_TIMEOUT_MS='2000'; process.env.SCRAPER_RUNTIME_TIMEOUT_MS='300';
        delete process.env.VERCEL; delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
        let running=0,maxRunning=0,cancelled=0;
        const scraperPath=require.resolve('./api/scraper');
        require.cache[scraperPath]={exports:async(req,res)=>{
            running++;maxRunning=Math.max(maxRunning,running);
            await new Promise(resolve=>req.scrapeSignal.addEventListener('abort',()=>{cancelled++;resolve();},{once:true}));
            running--;
        }};
        require.cache[require.resolve('./api/cron-calendario')]={exports:{atualizarCalendariosBackground:async()=>{}}};
        const express=require('express'),listen=express.application.listen;
        express.application.listen=function(...args){
            const server=listen.apply(this,args);
            server.once('listening',async()=>{
                try{
                    const base='http://127.0.0.1:'+server.address().port;
                    const bootstrap=await fetch(base+'/api/session');
                    const csrf=(await bootstrap.json()).csrf;
                    const cookie=bootstrap.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
                    const post=(endpoint,body,signal)=>fetch(base+endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,Cookie:cookie},body:JSON.stringify(body),signal});
                    assert.equal((await post('/api/login',{user:'a',pass:'b'})).status,200);
                    const rate=await post('/api/login',{user:'a',pass:'b'});
                    assert.equal(rate.status,429);assert.ok(rate.headers.get('Retry-After'));
                    assert.equal((await post('/api/scraper',{user:'a',pass:'b',padding:'x'.repeat(20000)})).status,413);
                    assert.equal((await fetch(base+'/api/scraper')).status,405);
                    const a=post('/api/scraper',{user:'a',pass:'b',clientId:'a'});
                    await new Promise(resolve=>setTimeout(resolve,30));
                    const controller=new AbortController();
                    const b=post('/api/scraper',{user:'b',pass:'b',clientId:'b'},controller.signal).catch(error=>error);
                    await new Promise(resolve=>setTimeout(resolve,30));
                    assert.equal((await post('/api/scraper',{user:'c',pass:'b',clientId:'c'})).status,429);
                    assert.equal((await post('/api/scraper',{user:'a',pass:'b',clientId:'duplicate'})).status,409);
                    controller.abort();await b;
                    await new Promise(resolve=>setTimeout(resolve,30));
                    const status=await (await fetch(base+'/api/queue-status?clientId=b')).json();
                    assert.equal(status.position,-1);assert.equal(status.queueLength,0);
                    const d=post('/api/scraper',{user:'d',pass:'b',clientId:'d'});
                    assert.equal((await a).status,504);assert.equal((await d).status,504);
                    assert.equal(maxRunning,1);assert.equal(cancelled,2);
                    server.closeAllConnections();
                    server.close(() => setTimeout(() => process.exit(0), 50));
                }catch(error){console.error(error);process.exit(1);}
            });return server;
        };require('./server');
    `;
    const result = spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
});
