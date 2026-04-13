#!/usr/bin/env node
/**
 * sync-obsidian.js
 * Sincroniza o estado atual do PIE com o vault Obsidian em tempo real.
 *
 * Uso:
 *   npm run sync-obsidian          # atualiza tudo
 *   node scripts/sync-obsidian.js  # idem
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadDB, getStats, loadPieSnapshots } from '../src/pie/pie-storage.js';
import {
  isObsidianConfigured,
  updatePadroesAprendidos,
  updateRoiPerformance,
  rebuildDashboard,
  updateSniperProtocol,
  updateTreinamentoNoturno,
  updateEngajamento,
  updatePieEvolution,
} from '../src/utils/obsidian.js';
import { getOverallStats } from '../src/utils/engagement-tracker.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');
const HIST  = join(ROOT, 'data/historical-patterns.json');

if (!isObsidianConfigured()) {
  console.error('\n❌ Obsidian não configurado.');
  console.error('   Defina OBSIDIAN_VAULT_PATH no arquivo .env');
  console.error(`   Exemplo: OBSIDIAN_VAULT_PATH=C:/Users/SeuUsuario/Documents/Obsidian Vault`);
  process.exit(1);
}

console.log('\n🔄 PIE → Obsidian — Sincronização em tempo real');
console.log('═'.repeat(56));

const db    = loadDB();
const stats = getStats();
const hist  = JSON.parse(readFileSync(HIST, 'utf-8'));

const activeLessons   = db.lessons.filter(l => l.active);
const activePatterns  = db.positivePatterns.filter(p => p.active);
const tot = db.stats.acertos + db.stats.erros;
const pct = tot > 0 ? ((db.stats.acertos / tot) * 100).toFixed(1) : '0.0';

console.log(`\n  Padrões positivos ativos : ${activePatterns.length}`);
console.log(`  Lições ativas            : ${activeLessons.length}`);
console.log(`  Taxa global PIE          : ${pct}% (${tot} outcomes)`);
console.log(`  Partidas na base         : ${hist.matches?.length ?? '—'}`);

console.log('\n  Mercados calibrados:');
for (const [mkt, cal] of Object.entries(db.calibration).sort((a,b) => b[1].total - a[1].total)) {
  const acc  = ((cal.hits / cal.total) * 100).toFixed(1);
  const prog = Math.round((cal.total / 100) * 20);
  const bar  = '█'.repeat(Math.min(prog, 20)) + '░'.repeat(Math.max(0, 20 - prog));
  const falta = Math.max(0, 100 - cal.total);
  console.log(`  ${mkt.padEnd(18)} ${String(cal.total).padStart(3)}/100  ${bar}  ${acc.padStart(5)}%  ${falta > 0 ? 'faltam ' + falta : '✅'}`);
}

console.log('\n  Atualizando vault...');

// 1. Padrões Aprendidos
const r1 = updatePadroesAprendidos(activeLessons, db.calibration);
console.log(`  ${r1 ? '✅' : '❌'} 🧠 Padrões Aprendidos.md`);

// 2. ROI e Performance
const r2 = updateRoiPerformance(stats);
console.log(`  ${r2 ? '✅' : '❌'} 📈 ROI e Performance.md`);

// 3. Dashboard
const r3 = rebuildDashboard();
console.log(`  ${r3 ? '✅' : '❌'} 📊 Dashboard.md`);

// 4. Protocolo Sniper (se dados disponíveis no PIE)
const PIE_PATH = join(ROOT, 'data/pie.json');
if (existsSync(PIE_PATH)) {
  try {
    const pie     = JSON.parse(readFileSync(PIE_PATH, 'utf-8'));
    const sniperD = pie.sniper_thresholds;
    if (sniperD) {
      const r4 = updateSniperProtocol({
        thresholds:      sniperD.thresholds || {},
        totalMatches:    hist.matches?.length || 0,
        totalShots:      0,   // não disponível fora da sessão — usa dados salvos
        totalHits:       0,
        totalAbstained:  0,
        overallAcc:      0,
        abstainRate:     0,
        marketsOnTarget: Object.values(sniperD.thresholds || {}).filter(t => t.gap != null && t.gap <= 0).length,
      });
      console.log(`  ${r4 ? '✅' : '❌'} 🎯 Protocolo Sniper.md`);
    } else {
      console.log(`  ⏭️  🎯 Protocolo Sniper.md — sem dados (rode npm run sniper)`);
    }

    // 5. Treinamento Noturno (último log disponível)
    const PROG = join(ROOT, 'logs/training-progress.jsonl');
    if (existsSync(PROG)) {
      const lines = readFileSync(PROG, 'utf-8').trim().split('\n').filter(Boolean);
      // Último snapshot de relatório
      const lastReport = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean).filter(l => l.fase === 'relatorio').pop();
      if (lastReport) {
        const r5 = updateTreinamentoNoturno({
          accuracy:  lastReport.accuracy  || {},
          sniperThr: lastReport.sniperThr || (sniperD?.thresholds || {}),
          resumo:    lastReport.resumo    || {},
          duracao:   0,
        });
        console.log(`  ${r5 ? '✅' : '❌'} 🌙 Treinamento Noturno.md`);
      }
    }
  } catch (e) {
    console.warn(`  ⚠️  Sniper/Training sync: ${e.message}`);
  }
}

// 6. Evolução PIE (snapshots históricos)
try {
  const snaps = loadPieSnapshots(90);
  if (snaps.length) {
    const r6b = updatePieEvolution(snaps);
    console.log(`  ${r6b ? '✅' : '❌'} 📈 Evolução PIE.md  (${snaps.length} snapshots · taxa atual: ${snaps[0]?.globalRate ?? '—'}%)`);
  } else {
    console.log(`  ⏭️  📈 Evolução PIE.md — sem snapshots ainda (execute npm run daily para gerar)`);
  }
} catch (e) {
  console.log(`  ⏭️  📈 Evolução PIE.md — ${e.message}`);
}

// 7. Engajamento dos Membros
try {
  const engStats = getOverallStats({ daysBack: 30 });
  const r6 = updateEngajamento(engStats);
  console.log(`  ${r6 ? '✅' : '❌'} 📱 Engajamento dos Membros.md  (${engStats.totalSignals} sinais · ${engStats.totalClicks} cliques · ${engStats.clickRate}% taxa)`);
} catch (e) {
  console.log(`  ⏭️  📱 Engajamento dos Membros.md — ${e.message}`);
}

console.log('\n' + '═'.repeat(56));
console.log(`✅ Obsidian atualizado — ${new Date().toLocaleString('pt-BR')}`);
console.log(`   Vault: ${process.env.OBSIDIAN_VAULT_PATH}`);
console.log(`   Pasta: ${process.env.OBSIDIAN_FOLDER || 'Apostas Futebol'}\n`);
