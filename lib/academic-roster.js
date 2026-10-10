const { load } = require('cheerio');
const termPattern = /\b(20\d{2})\s*[.\/-]\s*([12])\b/;
function termFrom(text) {
    const match = String(text || '').match(termPattern);
    if (match) return `${match[1]}.${match[2]}`;
    const written = String(text || '').match(/\b([12])\s*[º°o]?\s*semestre\s*(?:de|\/|-)?\s*(20\d{2})\b/i);
    return written ? `${written[2]}.${written[1]}` : '';
}
// Use the authenticated portal's enrollment rows, including classes without time codes.
function parseScheduleRaw(html) {
    const $ = load(html);
    const data = [];
    $('table').each((_, table) => {
        // HTML parsers may move a form placed around a <tr> out of that row.
        // Scope enrollment to its table, rather than requiring a form inside every row.
        const rows = $(table).find('tr').filter((_, row) => $(row).closest('table')[0] === table);
        const hasEnrollment = $(table).find('form[id^="form_acessarTurmaVirtual"], [onclick]').toArray().some(el =>
            $(el).closest('table')[0] === table && (String($(el).attr('id') || '').startsWith('form_acessarTurmaVirtual') || /frontEndIdTurma|['"]idTurma['"]/.test($(el).attr('onclick') || '')));
        if (!hasEnrollment) return;
        let currentTerm = termFrom($(table).children('caption, thead').text());
        rows.each((_, element) => {
            const row = $(element);
            const headerTerm = termFrom(row.children('td[colspan], th[colspan]').text());
            if (headerTerm) currentTerm = headerTerm;
            const desc = row.children('td.descricao').first();
            const infos = row.children('td.info').map((_, td) => $(td).text().trim()).get();
            const name = desc.find('a').first().text().trim() || desc.text().trim();
            if (!name || !infos.length) return;
            const term = termFrom(name) || currentTerm;
            data.push({ semestre: term, disciplina: name, turma: infos[0] || '', rawCodes: (infos[1] || '').split('(')[0].trim(), sala: infos[2] || '' });
        });
    });
    return data;
}
module.exports = { parseScheduleRaw };
