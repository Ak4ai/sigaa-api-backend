# Deploy Automático via Git

## Setup (Já feito ✅)

A VM está configurada com:
- Repo git: `~/sigaa-api-backend-git` (clone do GitHub)
- Script de deploy: `~/deploy.sh`
- Node.js e npm em `/usr/bin/`

## Fluxo de Deploy

### Opção 1: Fazer commit → push → deploy na VM (RECOMENDADO)

```powershell
# 1. No seu local, faça alterações e commit
cd C:\Users\Henrique\Documents\GitHub\SIGAA_APP\sigaa-api-backend
git add api/scraper.js
git commit -m "fix: descrição das mudanças"
git push

# 2. Na VM, execute o deploy
ssh -i "$HOME\.ssh\oracle_key" ubuntu@163.176.42.177 ~/deploy.sh
```

Isso vai:
- Parar o servidor
- Git pull (pega suas mudanças)
- npm install (se necessário)
- Reiniciar o servidor com NODE_ENV=production

### Opção 2: Deploy direto do PowerShell (one-liner)

```powershell
ssh -i "$HOME\.ssh\oracle_key" ubuntu@163.176.42.177 "~/deploy.sh"
```

## Verificar Status

```powershell
# Ver se servidor está rodando
ssh -i "$HOME\.ssh\oracle_key" ubuntu@163.176.42.177 "ps aux | grep 'node server' | grep -v grep"

# Ver logs em tempo real
ssh -i "$HOME\.ssh\oracle_key" ubuntu@163.176.42.177 "tail -f ~/sigaa_server.log"
```

## Volumes no Cloud

Depois de fazer push para GitHub, você pode fazer deploy na VM em segundos com um único comando.

## Estrutura

```
Local (seu computador):
  C:\...\SIGAA_APP\sigaa-api-backend\
  ├── api/scraper.js (você edita aqui)
  ├── server.js
  ├── package.json
  └── ... (no repositório GitHub)

NA VM (163.176.42.177):
  ~/sigaa-api-backend-git/  ← clone git
  ├── api/scraper.js
  ├── server.js (rodando via nohup)
  └── node_modules/

  ~/deploy.sh  ← script de deploy automático
  ~/sigaa_server.log  ← logs do servidor
```

## Próximos Passos

1. **Abrir porta 8080** na Oracle Cloud Security List (ainda bloqueada externamente)
2. **Testar deploy**: Faça uma pequena mudança, push, e execute `~/deploy.sh`
