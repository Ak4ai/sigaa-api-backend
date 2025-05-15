// scheduleParser.js
const fs = require('fs').promises;
const { daysMap, timeSlots } = require('./constants');

function interpretSchedule(schedule) {
  const detailed = [];
  schedule.forEach(item => {
    const codes = item.rawCodes.split(/\s+/).filter(Boolean);
    codes.forEach(code => {
      const m = code.match(/^(\d+)([MTN])(\d+)$/);
      if (!m) return;
      const [, daysPart, period, slotsPart] = m;
      daysPart.split('').forEach(d => {
        slotsPart.split('').forEach(s => {
          const dayName = daysMap[d] || `Desconhecido(${d})`;
          const time = (timeSlots[period] && timeSlots[period][s]) || '??:??-??:??';
          detailed.push({
            disciplina: item.disciplina,
            turma: item.turma,
            dia: dayName,
            período: period,
            slot: s,
            horário: time
          });
        });
      });
    });
  });
  return detailed;
}

async function gerarTabelaSimplificada() {
  const raw = JSON.parse(await fs.readFile('./horarios.json', 'utf8'));
  const dayOrder = ['Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];
  raw.sort((a, b) => {
    const dayDiff = dayOrder.indexOf(a.dia) - dayOrder.indexOf(b.dia);
    if (dayDiff !== 0) return dayDiff;
    const [aStart] = a.horário.split('-');
    const [bStart] = b.horário.split('-');
    return aStart.localeCompare(bStart);
  });

  const grouped = [];
  raw.forEach(row => {
    const [start, end] = row.horário.split('-');
    const last = grouped[grouped.length - 1];
    if (last
        && last.disciplina === row.disciplina
        && last.turma === row.turma
        && last.dia === row.dia
        && last.período === row.período
    ) {
      const [lastEnd] = last.horário.split('-').slice(1);
      if (lastEnd === start) {
        last.horário = `${last.horário.split('-')[0]}-${end}`;
        return;
      }
    }
    grouped.push({
      disciplina: row.disciplina,
      turma: row.turma,
      dia: row.dia,
      período: row.período,
      horário: row.horário,
      slot: row.slot
    });
  });

  await fs.writeFile('./horarios_simplificados.json', JSON.stringify(grouped, null, 2), 'utf8');
  console.log('✅ Tabela simplificada salva em horarios_simplificados.json:');
  console.table(grouped);
}

module.exports = { interpretSchedule, gerarTabelaSimplificada };
