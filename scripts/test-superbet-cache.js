/**
 * test-superbet-cache.js — Testa o cache de URLs Superbet
 *
 * Força refresh do cache (prelive + live) e exibe todas as partidas indexadas.
 * Útil para verificar se o scraping está funcionando corretamente.
 *
 * Uso:
 *   node scripts/test-superbet-cache.js           → testa PRÉ-LIVE
 *   node scripts/test-superbet-cache.js --live    → testa AO VIVO
 *   node scripts/test-superbet-cache.js --both    → testa ambos
 *   node scripts/test-superbet-cache.js --lookup "Flamengo" "Palmeiras"
 */

import 'dotenv/config';
import chalk from 'chalk';
import { refreshCache, lookupMatchUrl, listCachedMatches } from '../src/scrapers/superbet-cache.js';

const args   = process.argv.slice(2);
const both   = args.includes('--both');
const live   = args.includes('--live');
const lookup = args.includes('--lookup');

async function run() {
  console.log('\n' + '═'.repeat(64));
  console.log('  🔗 Superbet URL Cache — Teste de Diagnóstico');
  console.log('═'.repeat(64) + '\n');

  if (lookup) {
    const home = args[args.indexOf('--lookup') + 1] || 'Flamengo';
    const away = args[args.indexOf('--lookup') + 2] || 'Palmeiras';
    const type = live ? 'live' : 'prelive';

    console.log(chalk.cyan(`  🔍 Buscando: "${home}" vs "${away}" (${type})`));
    const url = lookupMatchUrl(home, away, type);
    if (url) {
      console.log(chalk.green(`  ✅ URL encontrada:\n     ${url}`));
    } else {
      console.log(chalk.red(`  ❌ URL não encontrada no cache`));
      const info = listCachedMatches(type);
      console.log(chalk.gray(`  ℹ️  Cache tem ${info.count} partidas (atualizado há ${info.age_seconds}s)`));
    }
    return;
  }

  const types = both ? ['prelive', 'live'] : [live ? 'live' : 'prelive'];

  for (const type of types) {
    const label = type === 'live' ? '🔴 AO VIVO' : '🟢 PRÉ-LIVE';
    console.log(chalk.bold.cyan(`\n${label} — Forçando refresh do cache...\n`));

    const count = await refreshCache(type);

    if (count === 0) {
      console.log(chalk.yellow(`  ⚠️  Nenhuma partida encontrada. Possíveis causas:`));
      console.log(chalk.yellow(`     - Horário sem jogos disponíveis no Superbet`));
      console.log(chalk.yellow(`     - SPA não renderizou a tempo (tente aumentar SPA_WAIT)`));
      console.log(chalk.yellow(`     - Superbet bloqueou o acesso (tente com --headed)`));
      continue;
    }

    const info = listCachedMatches(type);
    console.log(chalk.white(`\n  📋 ${info.count} partidas indexadas:\n`));

    for (const e of info.entries) {
      console.log(chalk.green(`  ✅ ${e.home.padEnd(25)} vs  ${e.away.padEnd(25)}`));
      console.log(chalk.gray(`     ${e.url}`));
    }

    console.log(chalk.bold(`\n  Total: ${info.count} partidas`));
  }

  console.log('\n' + '═'.repeat(64) + '\n');
}

run().catch(e => {
  console.error(chalk.red(`\nERRO: ${e.message}`));
  process.exit(1);
});
