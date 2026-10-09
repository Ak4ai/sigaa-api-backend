# Deploy controlado

Use Node 24 LTS instalado e verificado em `~/.local/lib/node-v24.*-linux-x64`.
O deploy preserva o runtime anterior, os segredos e os dados.

Depois de publicar os commits dos dois reposit?rios:

```powershell
ssh -i "$HOME\.ssh\sigaa_oracle_ed25519" ubuntu@163.176.42.177 "~/deploy.sh"
```

Para fixar os commits, passe os hashes completos do backend e do frontend:

```sh
~/deploy.sh BACKEND_SHA FRONTEND_SHA
```

O script clona uma release limpa, instala o lockfile, executa testes e auditoria,
inicia uma copia candidata em porta local separada e verifica saude e logout.
Depois troca o Nginx, aguarda consultas antigas e inicia o servico permanente.
Se a validacao falhar, restaura a configuracao e o backend anterior.

- Servico: `sigaa-backend.service`, com reinicio automatico.
- Release ativa: `~/sigaa-current/backend`.
- Segredos: `~/sigaa-shared/.env`, permissao 600, fora do Git.
- Cache e dados: `~/sigaa-shared/`, compartilhados entre releases.
- Frontend na VPS: `~/sigaa-current/Sigaa-API-webapp`.
- Frontend publico adicional: GitHub Pages do repositorio `Sigaa-API-webapp`.

```sh
sudo systemctl status sigaa-backend
journalctl -u sigaa-backend -n 30
curl https://ak4ai-sigaa.duckdns.org/api/health
```

Publique o backend e valide a API antes de atualizar a branch `main` da interface
no GitHub Pages. Nunca copie `.env` ou chaves SSH para commits ou artefatos publicos.
