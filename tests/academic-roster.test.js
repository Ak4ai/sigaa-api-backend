const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseScheduleRaw } = require('../lib/academic-roster');
test('portal enrollment retains classes without schedules and ignores unrelated table headings', () => {
    const html = `<table><tbody>
      <tr><td colspan="5">Período 2026.2</td></tr>
      <tr><td colspan="5">Disciplinas matriculadas</td></tr>
      <tr><td class="descricao"><a>Matemática</a></td><td class="info">01</td><td class="info">2M12 (Sala A)</td><td class="info">A</td><td><form id="form_acessarTurmaVirtual1"></form></td></tr>
      <tr><td class="descricao">Projeto</td><td class="info">02</td><td class="info"></td><td class="info"></td><td><form id="form_acessarTurmaVirtual2"></form><table><tbody><tr><td colspan="2">Detalhes</td></tr></tbody></table></td></tr>
      </tbody></table><table><tbody><tr><td class="descricao">Estágio (2026.2)</td><td class="info">03</td><td><form id="form_acessarTurmaVirtual3"></form></td></tr></tbody></table>`;
    const rows = parseScheduleRaw(html);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(row => [row.disciplina, row.semestre, row.turma]), [['Matemática','2026.2','01'], ['Projeto','2026.2','02'], ['Estágio (2026.2)','2026.2','03']]);
    assert.equal(rows[1].rawCodes, '');
});
test('a semester from another table never grants enrollment to an ambiguous row', () => {
    const rows = parseScheduleRaw('<table><tr><td colspan="2">2026.2</td></tr></table><table><tr><td class="descricao">Sem período</td><td class="info">01</td><td><form id="form_acessarTurmaVirtual1"></form></td></tr></table>');
    assert.equal(rows[0].semestre, '');
});
test('enrollment spans multiple tbody blocks and malformed row forms without losing subjects', () => {
    const rows = parseScheduleRaw(`<table>
      <tbody><tr><td colspan="4">2º semestre de 2026</td></tr></tbody>
      <tbody><form id="form_acessarTurmaVirtualA"><tr><td class="descricao">Álgebra</td><td class="info">01</td><td class="info">2M12</td></tr></form></tbody>
      <tbody><tr><td colspan="4">Outras disciplinas matriculadas</td></tr>
      <tr><td class="descricao">Projeto</td><td class="info">02</td><td class="info"></td><td><form id="form_acessarTurmaVirtualB"></form></td></tr>
      <tr><td class="descricao">Estágio</td><td class="info">03</td><td class="info"></td><td><button onclick="open({'frontEndIdTurma':'abc'})">Abrir</button></td></tr></tbody>
      </table><table><tr><td colspan="2">2026.2</td></tr><tr><td class="descricao">Aviso externo</td><td class="info">01</td></tr></table>`);
    assert.deepEqual(rows.map(row => [row.disciplina,row.semestre,row.turma]), [['Álgebra','2026.2','01'],['Projeto','2026.2','02'],['Estágio','2026.2','03']]);
});
