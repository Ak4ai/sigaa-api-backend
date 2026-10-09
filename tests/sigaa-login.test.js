const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVerifier } = require('../lib/sigaa-login');
const form = '<form><input type="hidden" name="csrf" value="fixture"><input name="user.senha" type="password"></form>';
const portal = '<div id="info-usuario"><p class="usuario"><span>Aluno de teste</span></p></div>';
const reply = (data, headers = {}, status = 200) => ({data,headers,status});
test('SIGAA verification carries cookies, encodes credentials and requires an authenticated portal', async () => {
    const requests = [];
    const verify = createVerifier({ request: async options => {
        requests.push(options);
        if (requests.length === 1) return reply(form, {'set-cookie':['JSESSIONID=fixture; Path=/sigaa; Secure; HttpOnly']});
        if (requests.length === 2) {
            assert.ok(options.headers.Cookie.includes('JSESSIONID=fixture'));
            assert.equal(new URLSearchParams(options.data).get('user.senha'),'pass & + spaces');
            assert.equal(new URLSearchParams(options.data).get('csrf'),'fixture');
            return reply('<p>Authenticated redirect result</p>');
        }
        assert.ok(options.headers.Cookie.includes('JSESSIONID=fixture'));
        return reply(portal);
    }});
    assert.equal(await verify('test-user','pass & + spaces'),true);
    assert.equal(requests.length,3);
});
test('SIGAA rejects wrong credentials, pending notices, blank portals and remote errors', async () => {
    for (const [html, expected] of [[form,401],['<div id="conteudo"><h2>Notificações Acadêmicas</h2></div>',403],['<p>Unconfirmed</p>',401]]) {
        let calls=0;
        const verify=createVerifier({request:async()=>reply(++calls===1?form:html)});
        await assert.rejects(verify('user','pass'),error=>error.status===expected);
    }
    await assert.rejects(createVerifier({request:async()=>reply('',{},503)})('user','pass'),error=>error.status===503);
});
test('SIGAA redirects capture rotated cookies and never forward credentials outside its HTTPS origin', async () => {
    let calls=0;
    const verify=createVerifier({request:async options=>{
        calls++;
        if(calls===1)return reply(form);
        if(calls===2)return reply('',{'set-cookie':['JSESSIONID=rotated; Path=/sigaa; Secure'],location:'/sigaa/portais/discente/discente.jsf'},302);
        assert.equal(options.method,'GET');assert.equal(options.data,undefined);
        assert.ok(options.headers.Cookie.includes('JSESSIONID=rotated'));
        return reply(portal);
    }});
    assert.equal(await verify('user','pass'),true);
    for(const location of ['http://sig.cefetmg.br/sigaa/','https://attacker.example/sigaa/']) {
        let requests=0;
        await assert.rejects(createVerifier({request:async()=>{requests++;return reply('',{location},302);}})('user','pass'),error=>error.status===503);
        assert.equal(requests,1);
    }
    const controller=new AbortController();controller.abort();
    let requests=0;
    await assert.rejects(createVerifier({request:async()=>{requests++;return reply(form);}})('user','pass',controller.signal));
    assert.equal(requests,0);
});
