# SIGAA Scraper – CEFET-MG

Extrai frequência e notas do SIGAA (sig.cefetmg.br) usando **axios + cheerio**, sem Puppeteer ou browser headless.

---

## Estrutura do projeto

```
extrai-frequencia-v3.js   ← script principal (frequência + notas)
login.js                  ← classe SigaaLoginHandler (exploratório)
sigaa-login.js            ← classe SigaaLogin (usada por index.js)
index.js                  ← teste de login isolado
frequencia-completa.json  ← output do script principal
.env                      ← credenciais (não commitado)
.env.example              ← modelo do .env
```

---

## Configuração

```bash
# 1. Instalar dependências
npm install

# 2. Criar .env com suas credenciais
copy .env.example .env
# editar .env:
#   SIGAA_USER=sua_matricula
#   SIGAA_PASSWORD=sua_senha

# 3. Rodar
node extrai-frequencia-v3.js
```

### Output

Gera `frequencia-completa.json` com frequência e notas de todas as disciplinas:

```json
[
  {
    "turma": "PESQUISA OPERACIONAL (2026.1)",
    "idTurma": "171206",
    "frequencia": [
      { "data": "03/03/2026", "status": "Presente" },
      { "data": "10/03/2026", "status": "2 Falta(s)" },
      { "data": "17/03/2026", "status": "Não Registrada" }
    ],
    "notas": {
      "matricula": "20233002910",
      "nomeAluno": "HENRIQUE DE FREITAS ARAÚJO",
      "avaliacoes": { "LST1": "--" },
      "resultado": "--",
      "reposicao": "--",
      "notaFinal": "--",
      "faltas": "0",
      "situacao": "--"
    }
  }
]
```

> Disciplinas sem avaliações cadastradas pelo professor retornam `notas: null`.

---

## Como funciona (fluxo técnico)

O SIGAA usa **JSF 2.x + RichFaces** rodando em JBoss 5.0. Toda interação é via `POST` com `javax.faces.ViewState` e IDs dinâmicos por sessão.

### Fluxo em 5 passos

```
PASSO 1 – Login
  GET  /sigaa/logar.do?dispatch=logOff        → cookies + campos ocultos
  POST /sigaa/logar.do?dispatch=logOn          → sessão autenticada

PASSO 2 – Portal discente
  GET  /sigaa/portais/discente/discente.jsf   → 67KB
       Extrai: idTurma[], formAtualizacoesTurmas ID dinâmico, ViewState

PASSO 3a – Entrar no AVA de cada disciplina
  POST /sigaa/portais/discente/discente.jsf
       Body: formAtualizacoesTurmas + idTurma + ViewState
       Retorna: AVA da turma (94–129KB)
       Extrai: formMenu ID dinâmico, avaViewState

PASSO 3b – Frequência
  POST /sigaa/ava/index.jsf
       Body: formMenu:j_id_jsp_{ID}_69 + _95 + ViewState
       Retorna: página de frequência (78KB)
       Parseia: tr.linhaImpar / tr.linhaPar → {data, status}

PASSO 3c – Notas
  POST /sigaa/ava/index.jsf
       Body: formMenu:j_id_jsp_{ID}_69 + _97 + ViewState (mesmo avaViewState)
       Retorna: página de notas (10KB se houver avaliações)
       Parseia: thead#trAval → cabeçalhos; tr.linhaImpar → dados
```

### Mapa de sufixos do formMenu

| Sufixo | Função              |
|--------|---------------------|
| `_69`  | PanelBar (raiz)     |
| `_92`  | Seção "Alunos"      |
| `_95`  | Frequência          |
| `_97`  | Ver Notas           |

### IDs dinâmicos (variam por sessão)

- **Portal**: `formAtualizacoesTurmas:j_id_jsp_161879646_439`
- **AVA**: `formMenu:j_id_jsp_XXXXXXXXX_*` — extraído do HTML do AVA via regex `id="formMenu:j_id_jsp_(\d+)_69"`

### ViewState

- `portalViewState` — do portal discente, usado apenas no POST do PASSO 3a
- `avaViewState` — do AVA de cada disciplina, usado nos POSTs de frequência **e** notas

---

## Descobertas técnicas importantes

### Por que não funciona com fetch/XHR simples

O SIGAA renderiza tudo server-side. Cada POST precisa:
1. ViewState correto da sessão atual
2. Todos os campos ocultos do formulário
3. Cookies de sessão mantidos entre requisições (CookieJar)

### Por que os IDs mudam

`j_id_jsp_311393315_95` é gerado pelo JSF no momento da renderização. O número central (`311393315`) é diferente a cada sessão e deve ser extraído do HTML antes de usar.

### Estrutura HTML da frequência

```html
<table>
  <tr class="linhaImpar">
    <td>03/03/2026</td>   <!-- data -->
    <td>Presente</td>      <!-- status -->
  </tr>
  <tr class="linhaPar">
    <td>10/03/2026</td>
    <td>2 Falta(s)</td>
  </tr>
</table>
```

### Estrutura HTML das notas

```html
<thead>
  <tr id="trAval">
    <th id="aval_56810264">LST1</th>   <!-- uma coluna por avaliação -->
  </tr>
</thead>
<!-- inputs hidden com metadados da avaliação -->
<input id="abrevAval_56810264" value="LST1"/>
<input id="denAval_56810264"   value="Lista 01 - Modelagem de Problemas"/>

<tr class="linhaImpar">
  <td>20233002910</td>                   <!-- matrícula -->
  <td>HENRIQUE DE FREITAS ARAÚJO</td>    <!-- nome -->
  <td>--</td>                            <!-- nota LST1 -->
  <td>0</td>                             <!-- Nota Unidade -->
  <td>--</td>                            <!-- Reposição -->
  <td>--</td>                            <!-- Resultado Final -->
  <td>--</td>                            <!-- Faltas -->
  <td>--</td>                            <!-- Situação -->
</tr>
```

---

## Dependências

| Pacote                    | Uso                                 |
|---------------------------|-------------------------------------|
| `axios`                   | Requisições HTTP                    |
| `axios-cookiejar-support` | Gerenciamento automático de cookies |
| `tough-cookie`            | CookieJar                           |
| `cheerio`                 | Parser HTML (jQuery server-side)    |
| `dotenv`                  | Variáveis de ambiente               |

---

## Arquivos de contexto

- [FLOW_DIAGRAM.md](FLOW_DIAGRAM.md) — diagrama do fluxo de login
- [HTTP_REQUESTS_MAP.md](HTTP_REQUESTS_MAP.md) — mapa completo de requisições HTTP
