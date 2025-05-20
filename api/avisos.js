// filepath: sigaa-api-backend/api/avisos.js
const fetchAvisos = async (page) => {
    await page.waitForSelector('.menu-direita', { timeout: 7000 });

    // Coleta avisos
    const avisos = await page.$$eval('.menu-direita > li', items => {
        return items.map(li => ({
            data: li.querySelector('.data')?.innerText.trim(),
            descricao: li.querySelector('.descricao')?.innerText.trim()
        }));
    });

    return avisos;
};

module.exports = {
    fetchAvisos
};