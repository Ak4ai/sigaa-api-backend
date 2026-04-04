# 🔄 FLUXO DE LOGIN DO SIGAA - Diagrama

## Sequência de Passos

```
┌─────────────────────────────────────────────────────────────────┐
│                    APLICAÇÃO DO USUÁRIO                          │
│                                                                   │
│  • Node.js (index.js)                                            │
│  • Python (sigaa_login_python.py)                               │
│  • cURL / Postman                                               │
└─────────┬───────────────────────────────────────────────────────┘
          │
          │ PASSO 1: Obter página de login
          ↓
┌─────────────────────────────────────────────────────────────────┐
│ GET /sigaa/logar.do?dispatch=logOff                             │
├─────────────────────────────────────────────────────────────────┤
│ → Servidor retorna:                                              │
│   • HTML da página de login                                      │
│   • Cookies (JSESSIONID)                                         │
│   • Campos ocultos (width, height, etc)                          │
│   • JSESSIONID na URL da action                                  │
└─────────┬───────────────────────────────────────────────────────┘
          │
          │ PASSO 2: Enviar credenciais
          ↓
┌─────────────────────────────────────────────────────────────────┐
│ POST /sigaa/logar.do?dispatch=logOn                             │
├─────────────────────────────────────────────────────────────────┤
│ Headers:                                                          │
│   Content-Type: application/x-www-form-urlencoded               │
│   Cookie: JSESSIONID=ABC123...                                  │
│                                                                   │
│ Body:                                                             │
│   user.login=8474829                                            │
│   user.senha=senha123                                           │
│   width=0                                                         │
│   height=0                                                        │
│   urlRedirect=                                                    │
│   subsistemaRedirect=                                            │
│   acao=                                                           │
│   acessibilidade=                                                │
└─────────┬───────────────────────────────────────────────────────┘
          │
          ↓
┌─────────────────────────────────────────────────────────────────┐
│         ⚡ SERVIDOR VALIDA CREDENCIAIS ⚡                        │
└─────────┬───────────────────────────────────────────────────────┘
          │
          ├─────────────────────┬──────────────────────┐
          │                     │                      │
       SUCESSO ❌             ⚠️                     ✅
          │               CREDENCIAIS                SUCCESS
          │                INVÁLIDAS                   │
          │                     │                      │
          ↓                     ↓                      ↓
   Retorna 200 OK        Retorna 200 OK        Retorna 302 Found
   com formulário        com formulário        → Location: /portal
   de login              + mensagem erro       nova sessão
   
   [Tentar novamente]    [Erro no app]         [Login OK!]
                                                    │
                                                    ↓
                                            PASSO 3 (opcional): 
                                            Acessar área autenticada
                                            GET /sigaa/portal/...
                                            Cookie: JSESSIONID=XYZ...
```

---

## 🔐 Fluxo Detalhado

### PASSO 1️⃣: Obter Página de Login

```
CLIENTE                              SERVIDOR SIGAA
   │                                     │
   ├──── GET /sigaa/logar.do?           │
   │      dispatch=logOff ─────────→    │ [Gera novo JSESSIONID]
   │                                    │ [Prepara formulário]
   │    ←─── 200 OK ─────────────────   │ [Retorna HTML]
   │        Set-Cookie: JSESSIONID      │
   │        [HTML do formulário]         │
   │                                     │
```

**Resposta esperada:**
- Status: `200 OK`
- Headers: `Set-Cookie: JSESSIONID=ABC123...`
- Body: HTML com `<form action="/sigaa/logar.do?dispatch=logOn">`

---

### PASSO 2️⃣: Enviar Credenciais

```
CLIENTE                              SERVIDOR SIGAA
   │                                     │
   ├──── POST /sigaa/logar.do? ─────→   │ [Valida user.login]
   │      dispatch=logOn                 │ [Valida user.senha]
   │      [Dados login]                  │ [Cria sessão autenticada]
   │      Cookie: JSESSIONID             │
   │                                     │
   │      ✅ Sucesso:                    │
   │    ←─── 302 Found ─────────────────  │ [Redireciona]
   │        Location: /sigaa/portal/...  │
   │                                     │
   │      ❌ Falha:                      │
   │    ←─── 200 OK ─────────────────── │ [Mostra form novamente]
   │        [HTML formulário]            │
   │                                     │
```

**Respostas possíveis:**
1. **Sucesso (302 Redirect)**: Salvar nova sessão e seguir redirect
2. **Falha (200 com form)**: Mostrar erro e permitir nova tentativa
3. **Erro de servidor (5xx)**: Retentar após timeout

---

## 📊 Máquina de Estados

```
┌──────────────┐
│  NÃO LOGADO  │  (Estado inicial)
└──────┬───────┘
       │
       │ GET /sigaa/logar.do?dispatch=logOff
       │
       ↓
┌──────────────────────────┐
│  AGUARDANDO CREDENCIAIS  │  (Página de login)
└──────┬───────────────────┘
       │
       │ POST /sigaa/logar.do?dispatch=logOn
       │ [user.login + user.senha]
       │
       ↓
       ├─────────────────────────────────┬──────────────────┐
       │                                 │                  │
    ✅ Valid                         ❌ Invalid          ⚠️  Error
       │                                 │                  │
       ↓                                 ↓                  ↓
    ┌────────────┐                ┌────────────┐      ┌─────────┐
    │  LOGADO    │ ←──────────────┤ AGUARD.    │      │ ERRO    │
    │ (Sessão OK)│    Retry       │ CRED.      │      │ (500)   │
    └────────────┘                └────────────┘      └─────────┘
       │
       │ Cookies mantêm sessão
       │ (JSESSIONID)
       │
       ↓
    Podem acessar:
    • /sigaa/portal/home.html
    • /sigaa/alunoAtividadeAulaPrincipal.do
    • /sigaa/docentePrincipal.do
    • etc...
```

---

## 🍪 Gerenciamento de Cookies

### JSESSIONID - Rastreamento de Sessão

```javascript
// Node.js - Automático com axios-cookiejar-support
const jar = new CookieJar();
const client = wrapper(axios.create({ jar }));

// Python - Automático com requests.Session()
session = requests.Session()
response1 = session.get(...)  // Salva cookies
response2 = session.post(...) // Reutiliza cookies
```

### Ciclo de Vida dos Cookies

```
Requisição 1: GET /sigaa/logar.do?dispatch=logOff
  ↓ [Sem cookies]
Resposta 1: Set-Cookie: JSESSIONID=ABC123
  ↓ [Salva JSESSIONID]
  
Requisição 2: POST /sigaa/logar.do?dispatch=logOn
  ↓ [Envia Cookie: JSESSIONID=ABC123]
Resposta 2: 302 Found (novo JSESSIONID gerado)
  ↓ [Atualiza JSESSIONID para XYZ789]
  
Requisição 3+: GET /sigaa/portal/...
  ↓ [Envia Cookie: JSESSIONID=XYZ789]
Resposta: 200 OK [Autenticado]
```

---

## 🎯 Fluxo em Pseudocódigo

```javascript
// Pseudocódigo - Estrutura geral

class SigaaLogin {
  
  async login(username, password) {
    
    // PASSO 1: Obter página
    const loginPage = await this.get('/sigaa/logar.do?dispatch=logOff');
    const cookies = this.extractCookies(loginPage);
    const hiddenFields = this.extractHiddenFields(loginPage);
    
    // PASSO 2: Enviar credenciais
    const payload = {
      'user.login': username,
      'user.senha': password,
      ...hiddenFields
    };
    
    const response = await this.post(
      '/sigaa/logar.do?dispatch=logOn',
      payload,
      { headers: { Cookie: cookies } }
    );
    
    // PASSO 3: Validar resposta
    if (this.isLoginSuccess(response)) {
      return { success: true, sessionId: this.extractSessionId() };
    } else {
      return { success: false, error: this.extractError(response) };
    }
  }
  
  isLoginSuccess(response) {
    // ❌ NÃO tem campo de login
    // ❌ NÃO tem campo de senha
    // ✅ TEM logout, docente, ou aluno
    return !response.includes('user.login') &&
           !response.includes('user.senha') &&
           (response.includes('logout') || 
            response.includes('docente') ||
            response.includes('aluno'));
  }
}
```

---

## 📈 Diagrama de Séquência (UML)

```
CLIENTE          HTTP         SERVIDOR
   │              │              │
   │──────GET────→│              │
   │     /logar.do│──────────────→│
   │              │         [busca db]
   │              │←─────Set-Cookie:─
   │←─────HTML────│              │
   │   (formulário)              │
   │              │              │
   │──────POST───→│              │
   │  /logar.do   │──────────────→│
   │  [credenciais]       [valida credenciais]
   │  Cookie: xxx │←─────válidas?──
   │              │              │
   │              │     SIM ✅    │
   │←─────302────│←─────redirect──
   │  (Redirect)  │   [cria sessão]
   │              │              │
   │  novo JSESSIONID mantido no cliente
   │  
   │──────GET────→│              │
   │  /portal/... │──────────────→│
   │  Cookie: yyy │  [valida sessão]
   │              │←──────────────
   │←─────200────│              │
   │   (conteúdo)              │
   │              │              │
```

---

## ⏱️ Timeline de Execução

```
t=0ms    : Iniciar GET /sigaa/logar.do?dispatch=logOff
t=50ms   : Receber resposta (HTML + cookies)
t=100ms  : Extrair campos ocultos
t=150ms  : Preparar payload de login
t=200ms  : Iniciar POST /sigaa/logar.do?dispatch=logOn
t=300ms  : Servidor validar credenciais
t=400ms  : Receber resposta (302 Redirect ou 200 com erro)
t=450ms  : Validar sucesso
t=500ms  : ✅ Login completo

⏱️ Tempo total: ~500ms (pode variar)
```

---

## 🔴 Pontos de Falha Comuns

```
❌ Falha: Não manter cookies entre requisições
   → Solução: Usar CookieJar (Node.js) ou Session (Python)

❌ Falha: Content-Type incorreto (application/json)
   → Solução: Usar application/x-www-form-urlencoded

❌ Falha: Ignorar campos ocultos
   → Solução: Extrair todos os campos de input do HTML

❌ Falha: Credenciais em formato errado
   → Solução: user.login deve ser matrícula, não nome

❌ Falha: Não seguir redirects (302)
   → Solução: axios.defaults.maxRedirects = 5

❌ Falha: Timeout na resposta
   → Solução: Aumentar timeout ou retentar
```

---

**Versão**: 1.0  
**Última atualização**: Abril de 2026
