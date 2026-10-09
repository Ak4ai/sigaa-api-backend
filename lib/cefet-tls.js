const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const https = require('https');

// O servidor CEFET não entrega este intermediário junto com o certificado.
// Fonte oficial: https://secure.globalsign.com/cacert/rnpicpedugr46ovtlsca2025.crt
const intermediate = new crypto.X509Certificate(fs.readFileSync(path.join(__dirname, '../certs/rnp-icpedu-2025.crt')));
const trusted = intermediate.ca && tls.rootCertificates.some(pem => {
    try { return intermediate.verify(new crypto.X509Certificate(pem).publicKey); }
    catch (error) { return false; }
});
if (!trusted || Date.now() < Date.parse(intermediate.validFrom) || Date.now() > Date.parse(intermediate.validTo)) {
    throw new Error('Certificado intermediário CEFET inválido ou expirado.');
}

function createCefetHttpsAgent() {
    return new https.Agent({
        ca: [...tls.rootCertificates, intermediate.toString()],
        rejectUnauthorized: true
    });
}

module.exports = { createCefetHttpsAgent };
