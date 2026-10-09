# Provas compartilhadas

O cadastro exige Bearer JWT válido, não revogado, e uma consulta bem-sucedida ao
portal autenticado do SIGAA com o mesmo token nas últimas 24 horas. Emitir um
token em `/api/login` não autoriza o cadastro. A consulta confirma disciplina,
turma e semestre; esses campos nunca são aceitos como autorização no POST.

`POST /api/calendario/eventos` recebe `{ turmaId, data, titulo }`. O limite é de
seis provas por turma/disciplina/semestre, compartilhado entre os alunos.
Uma transação SQLite impede que requisições simultâneas excedam o limite.
Duplicatas exatas não consomem uma vaga adicional. Datas passadas, inválidas ou
posteriores ao encerramento conhecido do semestre são rejeitadas.

O GET mantém eventos institucionais públicos e só entrega provas manuais das
turmas confirmadas do solicitante. A resposta informa `manual` e
`porOutroUsuario`; não expõe nome, CPF, senha, token nem identificador do autor.
O autor é identificado internamente por HMAC com chave persistente privada.

O banco fica em `data/exams/exams.sqlite`, preservado pelo deploy da VPS.
Requer Node 24 ou superior. Não usar disco efêmero de funções Vercel: essa
execução recusa o armazenamento e retorna 503.

Na primeira utilização, arquivos antigos `cache/provas_*.json` são removidos do
calendário ativo e guardados somente em backup privado em `data/exams/`.
Eventos institucionais não são removidos. As provas do semestre anterior são
apagadas quando uma consulta ao SIGAA confirma o próximo semestre. Quando o
calendário institucional informa o término, a limpeza também ocorre após essa
data, em cada acesso e a cada hora. Sem uma data institucional reconhecida,
usa-se a mudança de semestre confirmada pelo SIGAA, sem presumir um término.

Após atualizar o site, clique em **Atualizar minhas turmas** para confirmar o
acesso. Essa confirmação precisa ser renovada a cada 24 horas.
