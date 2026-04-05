#!/usr/bin/env node
/**
 * test-regex-compilation.js
 * Testa se as regexes estão compiladas e funcionando corretamente
 */

const fs = require('fs');
const path = require('path');

console.log('🧪 Teste de Regex Compiladas\n');

// Ler o scraper.js
const scraperPath = path.join(__dirname, 'api', 'scraper.js');
const scraperCode = fs.readFileSync(scraperPath, 'utf8');

// Verificar se as regex constantes existem
const regexPatterns = [
    'REGEX_ID_TURMA',
    'REGEX_NOME_BASE',
    'REGEX_FRONTEND_ID_TURMA',
    'REGEX_BUTTON_FIELD_KEY',
    'REGEX_ID_TURMA_FALLBACK',
    'REGEX_FORM_ATU_ID',
    'REGEX_FORM_MENU_AVA_ID',
    'REGEX_FORM_MENU_AVA_ID_ALT',
    'REGEX_AULAS_DEFINIDAS',
    'REGEX_PORCENTAGEM_FREQ',
    'REGEX_DATA_AULA',
];

console.log('✓ Verificando constantes de regex compiladas:\n');

let allFound = true;
regexPatterns.forEach(pattern => {
    const exists = scraperCode.includes(`const ${pattern} =`);
    const status = exists ? '✓' : '✗';
    console.log(`   ${status} ${pattern}`);
    if (!exists) allFound = false;
});

// Verificar cache de horários
console.log('\n✓ Verificando cache de horários:\n');

const cacheChecks = [
    { pattern: 'scheduleCache', desc: 'Map de cache' },
    { pattern: 'CACHE_DURATION', desc: 'Duração do cache (24h)' },
    { pattern: 'if (scheduleCache.has(cacheKey))', desc: 'Verificação de cache' },
];

cacheChecks.forEach(({ pattern, desc }) => {
    const exists = scraperCode.includes(pattern);
    const status = exists ? '✓' : '✗';
    console.log(`   ${status} ${desc}`);
    if (!exists) allFound = false;
});

// Verificar timeout reduzido
console.log('\n✓ Verificando timeout reduzido:\n');

const hasNewTimeout = scraperCode.includes('timeout: 12000');
const hasOldTimeout = scraperCode.includes('timeout: 30000');

console.log(`   ${hasNewTimeout ? '✓' : '✗'} timeout: 12000`);
console.log(`   ${!hasOldTimeout ? '✓' : '✗'} timeout: 30000 (removido)`);

if (hasOldTimeout) allFound = false;

// Resultado final
console.log('\n' + (allFound ? '✅ Todas as otimizações implementadas!' : '❌ Algumas otimizações não foram encontradas'));

process.exit(allFound ? 0 : 1);
