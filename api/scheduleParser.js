// filepath: sigaa-api-backend/api/scheduleParser.js

function interpretSchedule(schedule) {
    // Logic to interpret the raw schedule data
    const interpreted = schedule.map(item => {
        return {
            semestre: item.semestre,
            disciplina: item.disciplina,
            turma: item.turma,
            rawCodes: item.rawCodes
        };
    });
    return interpreted;
}

function gerarTabelaSimplificada(detailedSchedule) {
    // Logic to generate a simplified version of the schedule
    const simplified = detailedSchedule.map(item => {
        return {
            disciplina: item.disciplina,
            turma: item.turma
        };
    });
    return simplified;
}

module.exports = { interpretSchedule, gerarTabelaSimplificada };