## 🔗 MAPA DE REQUISIÇÕES HTTP DO SIGAA

Este arquivo documenta exatamente quais requisições HTTP fazem o login funcionar.

---

## 📍 ENDPOINT 1: Obter Página de Login

### Request
```http
GET /sigaa/logar.do?dispatch=logOff HTTP/1.1
Host: sig.cefetmg.br
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)
Cache-Control: no-cache
```

### Response Headers (Importantes)
```
HTTP/1.1 200 OK
Content-Type: text/html;charset=ISO-8859-1
Set-Cookie: JSESSIONID=ABC123...;Path=/sigaa
Connection: Keep-Alive
```

### Response Body
```html
<form name="loginForm" method="post" 
      action="/sigaa/logar.do;jsessionid=ABC123?dispatch=logOn">
  
  <input type="hidden" name="width" value="0" />
  <input type="hidden" name="height" value="0" />
  <input type="hidden" name="urlRedirect" value="" />
  <input type="hidden" name="subsistemaRedirect" value="" />
  <input type="hidden" name="acao" value="" />
  <input type="hidden" name="acessibilidade" value="" />
  
  <input type="text" name="user.login" placeholder="Matrícula" />
  <input type="password" name="user.senha" placeholder="Senha" />
  
  <input type="submit" value="Entrar" />
</form>
```

---

## 📍 ENDPOINT 2: Realizar Login

### Request
```http
POST /sigaa/logar.do?dispatch=logOn HTTP/1.1
Host: sig.cefetmg.br
Content-Type: application/x-www-form-urlencoded
Content-Length: 150
Cookie: JSESSIONID=ABC123...

user.login=8474829&user.senha=minha_senha&width=0&height=0&urlRedirect=&subsistemaRedirect=&acao=&acessibilidade=
```

### Request Parameters (Form Data)
| Campo | Tipo | Obrigatório | Exemplo | Notas |
|-------|------|-------------|---------|-------|
| `user.login` | String | ✅ Sim | `8474829` | Sua matrícula |
| `user.senha` | String | ✅ Sim | `senha123` | Sua senha |
| `width` | Integer | ❌ Não | `0` | Largura da tela (pode ser vazio) |
| `height` | Integer | ❌ Não | `0` | Altura da tela (pode ser vazio) |
| `urlRedirect` | String | ❌ Não | `` | Vazio (página de redirecionamento) |
| `subsistemaRedirect` | String | ❌ Não | `` | Vazio |
| `acao` | String | ❌ Não | `` | Vazio (ação customizada) |
| `acessibilidade` | String | ❌ Não | `` | Vazio (modo acessibilidade) |

### Response - Success (200 OK)
```
HTTP/1.1 302 Found
Location: /sigaa/portal/home.html
Set-Cookie: JSESSIONID=XYZ789...;Path=/sigaa
```

**Response Body conterá:**
- ❌ NÃO conterá: `<input name="user.login"` ou `<input name="user.senha"`
- ✅ CONTERÁ elementos de: "sair", "logout", "aluno", "docente"

### Response - Failure (200 OK com formulário novamente)
```html
<!-- Mesma página com mensagem de erro -->
<form name="loginForm" ...>
  <!-- Campos de input novamente -->
</form>
```

**Response Body conterá:**
- ❌ Voltar ao mesmo formulário
- Pode conter mensagem de erro sobre credenciais

---

## 🔑 Key Points para Implementação

### 1. **Gerenciamento de Cookies**
```javascript
// Obrigatório: Manter cookies entre requisições
const jar = new CookieJar();
axios.defaults.jar = jar;  // ou use axios-cookiejar-support
```

### 2. **Content-Type Correto**
```
Content-Type: application/x-www-form-urlencoded
```
✅ Correto  
❌ Não usar `multipart/form-data`  
❌ Não usar `application/json`

### 3. **HTTPS sem validação (se necessário)**
```javascript
httpsAgent: new https.Agent({ rejectUnauthorized: false })
```
Use apenas se estiver atrás de proxy corporativo.

### 4. **Detecção de Login Bem-Sucedido**
```javascript
// Verifique estes indicadores na resposta
const success = 
  !html.includes('usuario') &&  // Não mostra campo de login
  !html.includes('senha') &&     // Não mostra campo de senha
  (html.includes('logout') ||    // Tem opção de sair
   html.includes('sair') ||      // Ou botão "Sair"
   html.includes('docente') ||   // Você é docente
   html.includes('aluno'));      // Ou aluno
```

---

## 🧪 Teste com cURL (Command Line)

### Step 1: Obter cookies
```bash
curl -i -c cookies.txt \
  "https://sig.cefetmg.br/sigaa/logar.do?dispatch=logOff"
```

### Step 2: Fazer login
```bash
curl -b cookies.txt -c cookies.txt \
  -X POST \
  -d "user.login=8474829&user.senha=senha&width=0&height=0" \
  "https://sig.cefetmg.br/sigaa/logar.do?dispatch=logOn" \
  -i
```

### Step 3: Verificar login (acessar página protegida)
```bash
curl -b cookies.txt \
  "https://sig.cefetmg.br/sigaa/portal/home.html" \
  -i
```

---

## 🧪 Teste com Python

```python
import requests
from requests.auth import HTTPBasicAuth

session = requests.Session()

# Step 1: Get login page e cookies
r1 = session.get('https://sig.cefetmg.br/sigaa/logar.do?dispatch=logOff',
                  verify=False)  # Se necessário desabilitar SSL
print(f"Step 1 Status: {r1.status_code}")

# Step 2: Login
r2 = session.post('https://sig.cefetmg.br/sigaa/logar.do?dispatch=logOn',
                   data={
                       'user.login': '8474829',
                       'user.senha': 'senha',
                       'width': '0',
                       'height': '0',
                       'urlRedirect': '',
                       'subsistemaRedirect': '',
                       'acao': '',
                       'acessibilidade': ''
                   })
print(f"Step 2 Status: {r2.status_code}")
print(f"Login bem-sucedido: {'logout' in r2.text.lower()}")

# Step 3: Acessar página protegida
r3 = session.get('https://sig.cefetmg.br/sigaa/portal/home.html')
print(f"Step 3 Status: {r3.status_code}")
```

---

## 🧪 Teste com Postman

1. **Create Collection**: "SIGAA Login"

2. **Request 1 - GET Login Page**
   - Method: `GET`
   - URL: `https://sig.cefetmg.br/sigaa/logar.do?dispatch=logOff`
   - Checked: "Save response cookies"

3. **Request 2 - POST Login**
   - Method: `POST`
   - URL: `https://sig.cefetmg.fr/sigaa/logar.do?dispatch=logOn`
   - Body (form-urlencoded):
     ```
     user.login: 8474829
     user.senha: senha
     width: 0
     height: 0
     urlRedirect: (empty)
     subsistemaRedirect: (empty)
     acao: (empty)
     acessibilidade: (empty)
     ```
   - Checked: "Use cookies from previous request"

---

## ❗ Possíveis Erros e Soluções

| Erro | Causa | Solução |
|------|-------|---------|
| 401 Unauthorized | Credenciais inválidas | Verifique matrícula e senha |
| 403 Forbidden | Cookies não salvos | Usar `CookieJar` / Postman mantém cookies |
| 400 Bad Request | Content-Type errado | Use `application/x-www-form-urlencoded` |
| SSL_ERROR | Certificado inválido | Adicionar `verify=False` ou flag HTTPS |
| 302 com loop | Sessão expirou | Refazer step 1 antes do step 2 |
| Response vazio | Timeout | Aumentar timeout da requisição |

---

## 📚 Recursos Adicionais

- **Documentação SIGAA**: https://sig.cefetmg.br/sigaa/
- **Sistema original**: Nilo Ney Coutinho Menezes (UFRN)
- **Repositório**: https://github.com/ufcg-lsd/sigaa

---

**Última atualização**: Abril de 2026
