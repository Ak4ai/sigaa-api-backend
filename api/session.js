const { prepareBrowserRequest, sessionHandler } = require('../lib/browser-session');
module.exports = async function handler(req, res) {
    if (!prepareBrowserRequest(req, res)) return;
    if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET.' });
    return sessionHandler(req, res);
};
