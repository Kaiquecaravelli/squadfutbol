#!/usr/bin/env node
/**
 * scrape-superbet-data.js
 * Raspa saldo e histórico de apostas da Superbet via Playwright.
 * Uso:
 *   node scripts/scrape-superbet-data.js --balance
 *   node scripts/scrape-superbet-data.js --history
 */
import 'dotenv/config';
import { scrapeBalance, scrapeBetHistory } from '../src/scrapers/superbet-placer.js';

const doBalance = process.argv.includes('--balance');
const doHistory = process.argv.includes('--history');

if (!doBalance && !doHistory) {
  console.error('Use --balance ou --history');
  process.exit(1);
}

async function main() {
  if (doBalance) {
    console.log('[scrape] Raspando saldo...');
    const result = await scrapeBalance();
    if (result.error) {
      console.error('[scrape] ERRO saldo:', result.error);
      process.exit(1);
    }
    console.log('[scrape] Saldo:', result.balanceText, '→', result.balance);
  }

  if (doHistory) {
    console.log('[scrape] Raspando histórico de apostas...');
    const result = await scrapeBetHistory({ maxPages: 3 });
    if (result.error) {
      console.error('[scrape] ERRO histórico:', result.error);
      process.exit(1);
    }
    console.log('[scrape] Apostas importadas:', result.total);
  }
}

main().catch(e => { console.error('[scrape] FATAL:', e.message); process.exit(1); });
