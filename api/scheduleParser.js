const fs = require('fs').promises; // pode manter, mas não usaremos para salvar arquivo aqui
const { daysMap, timeSlots } = require('./constants');

/**
 * Interpreta o schedule bruto e transforma em array detalhado de horários,
 * expandindo códigos para dia, horário etc.
 * 
 * @param {Array} schedule - array com {semestre, disciplina, turma, rawCodes}
 * @returns {Array} detailed - array com horários detalhados
 */
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
            semestre: item.semestre,
            disciplina: item.disciplina,
            turma: item.turma,
            sala: item.sala || '',
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

/**
 * Gera a tabela simplificada agrupando horários contínuos da mesma disciplina, turma, dia e período.
 * 
 * @param {Array} detailedSchedule - array de horários detalhados gerados pela interpretSchedule
 * @returns {Array} grouped - tabela simplificada pronta para frontend
 */
function gerarTabelaSimplificada(detailedSchedule) {
  const dayOrder = ['Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];

  // Ordena por dia e horário inicial
  detailedSchedule.sort((a, b) => {
    const dayDiff = dayOrder.indexOf(a.dia) - dayOrder.indexOf(b.dia);
    if (dayDiff !== 0) return dayDiff;
    const [aStart] = a.horário.split('-');
    const [bStart] = b.horário.split('-');
    return aStart.localeCompare(bStart);
  });

  const grouped = [];
  detailedSchedule.forEach(row => {
    const [start, end] = row.horário.split('-');
    const last = grouped[grouped.length - 1];
    if (last
        && last.disciplina === row.disciplina
        && last.turma === row.turma
        && last.dia === row.dia
        && last.período === row.período
    ) {
      const [, lastEnd] = last.horário.split('-');
      if (lastEnd === start) {
        // Junta horários contínuos
        last.horário = `${last.horário.split('-')[0]}-${end}`;
        return;
      }
    }
    grouped.push({
      semestre: row.semestre,
      disciplina: row.disciplina,
      turma: row.turma,
      sala: row.sala || '',
      dia: row.dia,
      período: row.período,
      horário: row.horário,
      slot: row.slot
    });
  });

  return grouped;
}

module.exports = { interpretSchedule, gerarTabelaSimplificada };
