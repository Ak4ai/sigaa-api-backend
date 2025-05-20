// This file contains functions for handling grades, such as fetching and processing grade data from the platform.

const fetchNotas = async (page, disciplina) => {
    const notasInfo = 'formMenu:j_id_jsp_122142787_99';
    await page.evaluate((codigo) => {
        if (typeof jsfcljs === 'function') {
            jsfcljs(
                document.getElementById('formMenu'),
                { [codigo]: codigo },
                ''
            );
        }
    }, notasInfo);

    await page.waitForSelector('table.tabelaRelatorio', { timeout: 3000 });

    const notasHeaders = await page.$$eval('table.tabelaRelatorio thead tr#trAval th', ths =>
        ths.map(th => th.innerText.trim()).filter(Boolean)
    );

    const notas = await page.$$eval('table.tabelaRelatorio tbody tr', rows =>
        rows.map(tr => {
            const tds = Array.from(tr.querySelectorAll('td'));
            return tds.map(td => td.innerText.trim());
        })
    );

    const avaliacoes = await page.$$eval('table.tabelaRelatorio thead tr#trAval th[id^="aval_"]', ths =>
        ths.map(th => {
            const id = th.id.replace('aval_', '');
            const abrev = document.getElementById('abrevAval_' + id)?.value || '';
            const den = document.getElementById('denAval_' + id)?.value || '';
            const nota = document.getElementById('notaAval_' + id)?.value || '';
            const peso = document.getElementById('pesoAval_' + id)?.value || '';
            return { abrev, den, nota, peso };
        })
    );

    return { headers: notasHeaders, valores: notas, avaliacoes };
};

module.exports = {
    fetchNotas,
};