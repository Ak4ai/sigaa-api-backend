const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCalendarClient, validateCalendarUrl, selectCalendarPdfLink, isPublicAddress, PAGES } = require('../lib/calendar-download');
const valid = 'https://www.dirgrad.cefetmg.br/calendar.pdf';
const publicLookup = async () => [{ address: '200.131.0.33', family: 4 }];
const pdf = Buffer.from('%PDF-1.4\nfixture');
const response = (data = pdf) => ({ status: 200, headers: { 'content-type': 'application/pdf' }, data });

test('calendar URLs reject arbitrary hosts, userinfo, downgrade, alternate ports and IP literals', () => {
    for (const url of [
        'http://www.dirgrad.cefetmg.br/calendar.pdf', 'file:///etc/passwd', 'https://localhost/calendar.pdf',
        'https://127.0.0.1/calendar.pdf', 'https://[::1]/calendar.pdf', 'https://2130706433/calendar.pdf',
        'https://www.dirgrad.cefetmg.br.attacker.test/calendar.pdf', 'https://attacker.test/cefetmg.br/calendar.pdf',
        'https://user:pass@www.dirgrad.cefetmg.br/calendar.pdf', 'https://www.dirgrad.cefetmg.br:8080/calendar.pdf'
    ]) assert.throws(() => validateCalendarUrl(url));
    assert.equal(validateCalendarUrl(valid + '#page=1').href, valid);
    assert.equal(validateCalendarUrl('/calendar.pdf', 'https://www.dirgrad.cefetmg.br/page').href, valid);
});
test('private, reserved and IPv4-mapped IPv6 addresses cannot be used', () => {
    for (const address of ['0.0.0.0','10.0.0.1','127.0.0.1','100.64.0.1','169.254.169.254','172.16.0.1','192.168.1.1','192.0.2.1','198.18.0.1','224.0.0.1','255.255.255.255','::1','::','fe80::1','fd00::1','::ffff:127.0.0.1','::ffff:200.131.0.33','2001:db8::1','2002:7f00:1::1','invalid']) assert.equal(isPublicAddress(address), false, address);
    for (const address of ['200.131.0.33','8.8.8.8','2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
});
test('link extraction keeps current CEFET priority, handles relative links and ignores unsafe candidates', () => {
    const html = '<ul class="wp-block-list"><li><a href="https://attacker.test/evil.pdf">Calendário</a></li><li><a href="/new.pdf">2026/2</a></li></ul><a href="/old.pdf">Calendário 2026/1</a>';
    assert.equal(selectCalendarPdfLink(html, PAGES.computacao), new URL('/new.pdf', PAGES.computacao).href);
    assert.equal(selectCalendarPdfLink('<a href="http://www.dirgrad.cefetmg.br/calendar.pdf">Calendário</a>', PAGES.computacao), valid);
    assert.equal(selectCalendarPdfLink('<a href="https://attacker.test/evil.pdf">Calendário</a>', PAGES.computacao), null);
    assert.equal(selectCalendarPdfLink('<ul class="wp-block-list"><a href="/not-pdf.png">Image</a></ul>', PAGES.computacao), null);
});
test('DNS validation happens before connecting and the checked addresses are pinned against rebinding', async () => {
    let requests = 0;
    const blocked = createCalendarClient({ lookup: async () => [{address:'127.0.0.1',family:4}], request: async () => { requests++; return response(); } });
    await assert.rejects(blocked.downloadPdf(valid), /rede/);
    assert.equal(requests, 0);
    let lookups = 0;
    const pinned = createCalendarClient({
        lookup: async () => (++lookups === 1 ? [{address:'200.131.0.33',family:4}] : [{address:'127.0.0.1',family:4}]),
        request: async (url, options) => {
            const addresses = await new Promise((resolve,reject) => options.httpsAgent.options.lookup(new URL(url).hostname, {all:true}, (err,value) => err ? reject(err) : resolve(value)));
            assert.deepEqual(addresses, [{address:'200.131.0.33',family:4}]);
            assert.equal(options.proxy, false);
            return response();
        }
    });
    assert.deepEqual((await pinned.downloadPdf(valid)).data, pdf);
    assert.equal(lookups, 1);
});
test('each redirect revalidates the host and DNS, including protocol downgrades', async () => {
    for (const location of ['https://attacker.test/evil.pdf','https://127.0.0.1/evil.pdf','http://www.dirgrad.cefetmg.br/calendar.pdf']) {
        let requests = 0;
        const client = createCalendarClient({lookup:publicLookup,request:async()=>{requests++;return {status:302,headers:{location},data:Buffer.alloc(0)};}});
        await assert.rejects(client.downloadPdf(valid), /autorizado/);
        assert.equal(requests, 1);
    }
    let requests = 0;
    const rebound = createCalendarClient({
        lookup:async host=>host==='www.dirgrad.cefetmg.br'?publicLookup():[{address:'169.254.169.254',family:4}],
        request:async()=>{requests++;return {status:302,headers:{location:'https://www.divinopolis.cefetmg.br/file.pdf'},data:Buffer.alloc(0)};}
    });
    await assert.rejects(rebound.downloadPdf(valid), /rede/);
    assert.equal(requests, 1);
    const seen = [];
    const allowed = createCalendarClient({lookup:publicLookup,request:async url=>{
        seen.push(url);
        return seen.length===1?{status:302,headers:{location:'/final.pdf'},data:Buffer.alloc(0)}:response();
    }});
    assert.equal((await allowed.downloadPdf(valid)).url, 'https://www.dirgrad.cefetmg.br/final.pdf');
    assert.equal(seen.length, 2);
});
test('download rejects oversized bodies, non-PDF responses, redirect loops and slow DNS or responses', async () => {
    const oversized = createCalendarClient({lookup:publicLookup,limits:{pdfBytes:8,htmlBytes:8},request:async()=>response()});
    await assert.rejects(oversized.downloadPdf(valid), /tamanho/);
    await assert.rejects(oversized.fetchPage(PAGES.computacao), /tamanho/);
    for (const reply of [response(Buffer.from('<html>error</html>')), {status:200,headers:{'content-type':'text/html'},data:pdf}, {status:404,headers:{},data:pdf}]) {
        await assert.rejects(createCalendarClient({lookup:publicLookup,request:async()=>reply}).downloadPdf(valid));
    }
    let count = 0;
    const loop = createCalendarClient({lookup:publicLookup,request:async()=>{count++;return {status:302,headers:{location:valid},data:Buffer.alloc(0)};}});
    await assert.rejects(loop.downloadPdf(valid), /Redirecionamentos/);
    assert.equal(count, 4);
    for (const overrides of [{lookup:()=>new Promise(()=>{})},{request:()=>new Promise(()=>{})}]) {
        const slow = createCalendarClient({lookup:publicLookup,request:async()=>response(),limits:{pdfTimeoutMs:30},...overrides});
        await assert.rejects(slow.downloadPdf(valid), /Tempo limite/);
    }
    assert.deepEqual((await createCalendarClient({lookup:publicLookup,request:async()=>({...response(),headers:{'content-type':'application/octet-stream'}})}).downloadPdf(valid)).data,pdf);
});

test('blocked cron download preserves both cached calendars and never uploads to Gemini', () => {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sigaa-calendar-safe-'));
    const cache = path.join(folder,'cache'), temp = path.join(folder,'temp');
    fs.mkdirSync(cache); fs.mkdirSync(temp);
    const original = JSON.stringify({pdfUrl:'https://www.dirgrad.cefetmg.br/old.pdf',eventos:[{data:'2026-12-20',titulo:'Existing event'}]});
    for (const course of Object.keys(PAGES)) fs.writeFileSync(path.join(cache,`calendario_${course}.json`),original);
    try {
        const script = `
            const assert=require('node:assert/strict');
            const real=require('./lib/calendar-download');
            let attempts=0,connections=0,uploads=0;
            const blocked=real.createCalendarClient({lookup:async()=>[{address:'127.0.0.1',family:4}],request:async()=>{connections++;throw new Error('must not connect');}});
            require.cache[require.resolve('./lib/calendar-download')].exports={...real,fetchPage:async url=>({url,html:'<ul class="wp-block-list"><a href="https://www.dirgrad.cefetmg.br/new.pdf">Calendario</a></ul>'}),downloadPdf:async url=>{attempts++;return blocked.downloadPdf(url);}};
            require.cache[require.resolve('@google/generative-ai/server')]={exports:{GoogleAIFileManager:class{constructor(){uploads++;throw new Error('must not upload');}}}};
            require('./api/cron-calendario').atualizarCalendariosBackground().then(()=>{assert.equal(attempts,2);assert.equal(connections,0);assert.equal(uploads,0);});
        `;
        const result = spawnSync(process.execPath,['-e',script],{cwd:path.resolve(__dirname,'..'),env:{...process.env,GEMINI_API_KEY:'test-only-unused-key',CALENDAR_CACHE_DIR:cache,CALENDAR_TEMP_DIR:temp},encoding:'utf8',timeout:10000});
        assert.equal(result.status,0,result.stderr);
        for (const course of Object.keys(PAGES)) assert.equal(fs.readFileSync(path.join(cache,`calendario_${course}.json`),'utf8'),original);
        assert.equal(fs.readdirSync(temp).length,0);
    } finally {
        for (const course of Object.keys(PAGES)) fs.unlinkSync(path.join(cache,`calendario_${course}.json`));
        fs.rmdirSync(cache);fs.rmdirSync(temp);fs.rmdirSync(folder);
    }
});
