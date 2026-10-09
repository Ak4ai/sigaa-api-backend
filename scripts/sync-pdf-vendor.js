const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const backend = path.resolve(__dirname, '..');
const frontend = process.env.SIGAA_FRONTEND_DIR || path.resolve(backend, '../teste_api_sigaa/sigaa-test/Sigaa-API-webapp');
if (!fs.existsSync(path.join(frontend, 'index.html'))) throw new Error('Configure SIGAA_FRONTEND_DIR para o checkout do frontend.');
const vendor = path.join(frontend, 'vendor');
fs.mkdirSync(vendor, { recursive: true });
const bundles = [
    ['jspdf', 'jspdf.umd.min.js'],
    ['jspdf-autotable', 'jspdf.plugin.autotable.min.js']
];
const versions = bundles.map(([name, file]) => {
    const source = path.join(backend, 'node_modules', name);
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    const data = fs.readFileSync(path.join(source, 'dist', file));
    fs.writeFileSync(path.join(vendor, file), data);
    const license = ['LICENSE', 'LICENSE.txt', 'LICENSE.md'].find(file => fs.existsSync(path.join(source, file)));
    if (!license) throw new Error(`Licença não encontrada: ${name}`);
    fs.copyFileSync(path.join(source, license), path.join(vendor, `${name}-LICENSE.txt`));
    return { package: name, version: manifest.version, file, sha256: crypto.createHash('sha256').update(data).digest('hex') };
});
fs.writeFileSync(path.join(vendor, 'versions.json'), JSON.stringify(versions, null, 2) + '\n');
console.log('Bibliotecas de PDF sincronizadas:', versions.map(item => `${item.package}@${item.version}`).join(', '));
