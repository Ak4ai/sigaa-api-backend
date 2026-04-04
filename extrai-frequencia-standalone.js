// Fluxo completo:
// 1. Login → portal discente (67KB)
// 2. Extrai idTurma + formAtualizacoesTurmas fields
// 3. POST discente.jsf com idTurma → entra no AVA da turma
// 4. POST index.jsf _95 → frequência (linhaImpar/linhaPar)
// 5. POST index.jsf _97 → notas (linhaImpar com matricula/nome/avaliações/resultado/faltas/sit)
// 6. Parser com cheerio
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as fs from 'fs/promises';
import { load } from 'cheerio';
import dotenv from 'dotenv';
import { URLSearchParams } from 'url';

dotenv.config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const baseURL = 'https://sig.cefetmg.br';
const baseHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Content-Type': 'application/x-www-form-urlencoded',
};

function extractHiddenFields(html) {
  const $ = load(html);
  const fields = {};
  $('input[type="hidden"]').each((_, el) => {
    const name = $(el).attr('name');
    const value = $(el).attr('value') ?? '';
    if (name) fields[name] = value;
  });
  return fields;
}

function extractTurmas(html) {
  // Extrai idTurma e nome das disciplinas dos links onclick
  const turmas = [];
  const pattern = /'idTurma':'(\d+)'[^}]*}\s*,\s*''\s*\)\s*;\s*\}\s*return[^>]*>([^<]+)</g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    turmas.push({ idTurma: match[1], nome: match[2].trim() });
  }

  // Deduplicar por idTurma
  const seen = new Set();
  return turmas.filter(t => {
    if (seen.has(t.idTurma)) return false;
    seen.add(t.idTurma);
    return true;
  });
}

function extractFormAtualizacoesTurmasId(html) {
  // Extrai o ID dinâmico do formAtualizacoesTurmas (ex: j_id_jsp_161879646_439)
  const match = html.match(/formAtualizacoesTurmas:(j_id_jsp_\d+_\d+)['":]/);
  return match ? match[1] : null;
}

function extractFormMenuAvaId(html) {
  // Extrai o número dinâmico do formMenu no AVA (ex: 311393315)
  const match = html.match(/id="formMenu:j_id_jsp_(\d+)_69"/);
  if (match) return match[1];
  const match2 = html.match(/formMenu:j_id_jsp_(\d+)_69/);
  return match2 ? match2[1] : null;
}

function parseNotas(html) {
  const $ = load(html);

  // Extrai headers das avaliações (linha trAval)
  const avaliacoes = [];
  $('#trAval th[id^="aval_"]').each((_, th) => {
    const id = $(th).attr('id').replace('aval_', '');
    const abrev = $(`#abrevAval_${id}`).val() ?? $(th).text().trim();
    const nome  = $(`#denAval_${id}`).val()  ?? abrev;
    avaliacoes.push({ id, abrev, nome });
  });

  // Linha de dados do aluno (linhaImpar ou linhaPar)
  const row = $('tr.linhaImpar, tr.linhaPar').first();
  if (!row.length) return null;

  const tds = row.find('td');
  const matricula = $(tds[0]).text().trim();
  const nomeAluno = $(tds[1]).text().trim();

  // Notas individuais: colunas 2 até 2+avaliacoes.length
  const notasIndividuais = {};
  avaliacoes.forEach((av, i) => {
    notasIndividuais[av.abrev] = $(tds[2 + i]).text().trim() || '--';
  });

  const base = 2 + avaliacoes.length;
  const resultado  = $(tds[base]).text().trim()     || '--'; // Nota Unidade
  const reposicao  = $(tds[base + 1]).text().trim() || '--'; // Reposição
  const notaFinal  = $(tds[base + 2]).text().trim() || '--'; // Resultado
  const faltas     = $(tds[base + 3]).text().trim() || '--'; // Faltas
  const situacao   = $(tds[base + 4]).text().trim() || '--'; // Sit.

  return { matricula, nomeAluno, avaliacoes: notasIndividuais, resultado, reposicao, notaFinal, faltas, situacao };
}

function parseFrequencia(html) {
  const $ = load(html);
  const registros = [];

  $('tr.linhaImpar, tr.linhaPar').each((_, row) => {
    const tds = $(row).find('td');
    if (tds.length >= 2) {
      const data = $(tds[0]).text().trim();
      const status = $(tds[1]).text().trim();
      if (/\d{2}\/\d{2}\/\d{4}/.test(data) && status.length > 0) {
        registros.push({ data, status });
      }
    }
  });

  return registros;
}

async function main() {
  const jar = new CookieJar();
  const client = wrapper(axios.create({
    jar, baseURL, validateStatus: () => true, decompress: true, timeout: 25000,
  }));

  // PASSO 1: Login
  console.log('🔐 Login...');
  const loginPage = await client.get('/sigaa/logar.do?dispatch=logOff', { headers: baseHeaders });
  const loginFields = extractHiddenFields(loginPage.data);
  const loginParams = new URLSearchParams({
    'user.login': process.env.SIGAA_USER,
    'user.senha': process.env.SIGAA_PASSWORD,
    ...loginFields,
  });
  await client.post('/sigaa/logar.do?dispatch=logOn', loginParams.toString(), { headers: baseHeaders });
  console.log('✓ Logado\n');

  // PASSO 2: Portal discente → pega 67KB com turmas e ViewState
  console.log('📄 PASSO 2: GET portal discente');
  const portalRes = await client.get('/sigaa/portais/discente/discente.jsf', { headers: baseHeaders });
  console.log(`   Tamanho: ${portalRes.data.length} bytes`);
  await fs.writeFile('DEBUG-portal-discente.html', portalRes.data);

  const portalViewState = extractHiddenFields(portalRes.data)['javax.faces.ViewState'];
  const formAtuId       = extractFormAtualizacoesTurmasId(portalRes.data);
  const turmas          = extractTurmas(portalRes.data);

  console.log(`   ViewState             : ${portalViewState ?? '(não encontrado)'}`);
  console.log(`   formAtualizacoes ID   : ${formAtuId ?? '(não encontrado)'}`);
  console.log(`   Turmas encontradas    : ${turmas.length}`);
  turmas.forEach(t => console.log(`     → ${t.idTurma}  ${t.nome}`));

  if (!turmas.length) {
    console.log('\n❌ Nenhuma turma encontrada. Verifique DEBUG-portal-discente.html');
    return;
  }

  // PASSO 3: Para cada turma, entra no AVA e extrai frequência
  const resultado = [];

  for (const turma of turmas) {
    console.log(`\n📚 Turma: ${turma.nome} (${turma.idTurma})`);

    try {
      // PASSO 3a: POST discente.jsf → entra no AVA da turma
      const entrarAvaPayload = new URLSearchParams();
      entrarAvaPayload.set('formAtualizacoesTurmas', 'formAtualizacoesTurmas');
      if (formAtuId) {
        entrarAvaPayload.set(`formAtualizacoesTurmas:${formAtuId}`, `formAtualizacoesTurmas:${formAtuId}`);
      }
      entrarAvaPayload.set('idTurma', turma.idTurma);
      entrarAvaPayload.set('javax.faces.ViewState', portalViewState ?? 'j_id3');

      const avaRes = await client.post('/sigaa/portais/discente/discente.jsf', entrarAvaPayload.toString(), {
        headers: { ...baseHeaders, Referer: `${baseURL}/sigaa/portais/discente/discente.jsf` },
      });
      console.log(`   AVA entrada: ${avaRes.status} | ${avaRes.data.length} bytes`);
      await fs.writeFile(`DEBUG-ava-${turma.idTurma}.html`, avaRes.data);

      // PASSO 3b: Extrai formMenu ID e ViewState do AVA
      const avaMenuId    = extractFormMenuAvaId(avaRes.data);
      const avaViewState = extractHiddenFields(avaRes.data)['javax.faces.ViewState'] ?? 'j_id3';
      console.log(`   formMenu ID: ${avaMenuId ?? '(não encontrado)'} | ViewState: ${avaViewState}`);

      if (!avaMenuId) {
        console.log('   ❌ formMenu ID não encontrado no AVA, pulando...');
        continue;
      }

      // PASSO 3c: POST /sigaa/ava/index.jsf com formMenu → clica em Frequência
      const freqPayload = new URLSearchParams();
      freqPayload.set('formMenu', 'formMenu');
      freqPayload.set(`formMenu:j_id_jsp_${avaMenuId}_69`, `formMenu:j_id_jsp_${avaMenuId}_92`);
      freqPayload.set(`formMenu:j_id_jsp_${avaMenuId}_95`, `formMenu:j_id_jsp_${avaMenuId}_95`);
      freqPayload.set('javax.faces.ViewState', avaViewState);

      const freqRes = await client.post('/sigaa/ava/index.jsf', freqPayload.toString(), {
        headers: { ...baseHeaders, Referer: `${baseURL}/sigaa/ava/index.jsf` },
      });
      const hasLinhaImpar = freqRes.data.includes('linhaImpar');
      const hasPresente   = freqRes.data.includes('Presente');
      console.log(`   Freq POST : ${freqRes.status} | ${freqRes.data.length} bytes | linhaImpar: ${hasLinhaImpar ? '✅' : '❌'} | Presente: ${hasPresente ? '✅' : '❌'}`);
      await fs.writeFile(`DEBUG-freq-post-${turma.idTurma}.html`, freqRes.data);

      if (hasLinhaImpar || hasPresente) {
        const registros = parseFrequencia(freqRes.data);
        console.log(`   ✅ ${registros.length} registros de frequência!`);
        registros.slice(0, 5).forEach(r => console.log(`      ${r.data}  ${r.status}`));
        if (registros.length > 5) console.log(`      ... +${registros.length - 5} mais`);
        resultado.push({ turma: turma.nome, idTurma: turma.idTurma, frequencia: registros });
      }

      // ViewState atualizado da resposta de frequência
      const vsParaNotas = extractHiddenFields(freqRes.data)['javax.faces.ViewState'] ?? avaViewState;

      // PASSO 3d: POST _97 → Ver Notas (usa ViewState da resposta anterior)
      const notasPayload = new URLSearchParams();
      notasPayload.set('formMenu', 'formMenu');
      notasPayload.set(`formMenu:j_id_jsp_${avaMenuId}_97`, `formMenu:j_id_jsp_${avaMenuId}_97`);
      notasPayload.set('javax.faces.ViewState', avaViewState);

      const notasRes = await client.post('/sigaa/ava/index.jsf', notasPayload.toString(), {
        headers: { ...baseHeaders, Referer: `${baseURL}/sigaa/ava/index.jsf` },
      });
      const temNotas = notasRes.data.includes('linhaImpar') && notasRes.data.includes('Nota');
      console.log(`   Notas POST: ${notasRes.status} | ${notasRes.data.length} bytes | notas: ${temNotas ? '✅' : '❌'}`);

      if (temNotas) {
        const notas = parseNotas(notasRes.data);
        if (notas) {
          console.log(`   ✅ Notas: resultado=${notas.resultado} | notaFinal=${notas.notaFinal} | faltas=${notas.faltas} | sit=${notas.situacao}`);
          const idx = resultado.findIndex(r => r.idTurma === turma.idTurma);
          if (idx > -1) resultado[idx].notas = notas;
          else resultado.push({ turma: turma.nome, idTurma: turma.idTurma, notas });
        }
      }

    } catch (e) {
      console.log(`   ❌ Erro: ${e.message}`);
    }
  }

  if (resultado.length > 0) {
    await fs.writeFile('frequencia-completa.json', JSON.stringify(resultado, null, 2));
    console.log('\n✅ Frequência e notas salvas em frequencia-completa.json');
  } else {
    console.log('\n⚠️  Nenhuma frequência extraída — verifique os arquivos DEBUG-*');
  }
}

main().catch(e => console.error('❌', e.message));
