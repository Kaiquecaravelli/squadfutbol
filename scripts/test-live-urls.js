/**
 * test-live-urls.js — testa extração de URLs reais do DOM de apostas/ao-vivo
 * Mostra os primeiros 10 links encontrados para validar o formato
 */
import 'dotenv/config';
import { getSuperbetLiveEventMap } from '../src/scrapers/superbet.js';

console.log('🔍 Abrindo apostas/ao-vivo para extrair links DOM reais...\n');

const liveMap = await getSuperbetLiveEventMap();

if (liveMap.size === 0) {
  console.log('❌ Nenhum link encontrado — SPA pode não ter renderizado ou a página mudou.');
  process.exit(1);
}

// Mostra apenas entradas com URL (exclui matchName duplicates)
const entries = [...liveMap.entries()].filter(([k, v]) => k.includes('-x-') || !k.includes('·'));
console.log(`\n✅ ${entries.length} partidas mapeadas. Primeiros 10 links:\n`);

for (const [key, url] of entries.slice(0, 10)) {
  console.log(`  🔗 ${key}`);
  console.log(`     ${url}\n`);
}
