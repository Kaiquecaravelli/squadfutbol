#!/usr/bin/env node
/**
 * training-cycle.js
 * Rotina completa de treinamento diário do PIE.
 * Coleta → Injeta → Calibra → Analisa → Reporta → Sync Obsidian
 *
 * Meta: 98% de assertividade nos mercados tier-1 (Over 1.5, BTTS, Over 2.5)
 *
 * Uso:
 *   node scripts/training-cycle.js               # treina ontem
 *   node scripts/training-cycle.js 2026-04-10    # treina data específica
 *   node scripts/training-cycle.js --week        # treina os últimos 7 dias
 *   node scripts/training-cycle.js --report      # relatório de progresso (sem treinar)
 */

import { execSync, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadDB, getStats } from '../src/pie/pie-storage.js';

const __dir    = dirname(fileURLToPath(import.meta.url));
const ROOT     = join(__dir, '..');
const HIST     = join(ROOT, 'data/historical-patterns.json');
const TRAINING_LOG = join(ROOT, 'logs/training-history.jsonl');
const DIR      = join(ROOT, 'data/daily-matches');

// ── Meta de assertividade por mercado ──────────────────────────────────────────
const ACCURACY_TARGETS = {
  'Over 1.5':          { target: 98, tier: 1, risk: 'LOW',    note: 'Linha mais segura — ~90% base rate real' },
  'BTTS':              { target: 95, tier: 1, risk: 'LOW',    note: 'Ambas as equipes marcam — ~52% base rate' },
  'Over 2.5':          { target: 92, tier: 1, risk: 'MEDIUM', note: 'Jogo aberto — ~55% base rate' },
  'Over Corners 6.5':  { target: 90, tier: 2, risk: 'LOW',    note: '6+ escanteios — muito comum' },
  'Over Corners 7.5':  { target: 85, tier: 2, risk: 'MEDIUM', note: '8+ escanteios — ligas europeias' },
  'Over Corners 8.5':  { target: 78, tier: 2, risk: 'MEDIUM', note: '9+ escanteios — jogos abertos' },
  'YC 2.5':            { target: 85, tier: 2, risk: 'LOW',    note: '3+ cartões — muito frequente' },
  'YC 3.5':            { target: 75, tier: 2, risk: 'MEDIUM', note: '4+ cartões — rivalidades' },
  'YC 4.5':            { target: 65, tier: 3, risk: 'HIGH',   note: '5+ cartões — jogos tensos' },
  'Over 3.5':          { target: 70, tier: 2, risk: 'HIGH',   note: 'Jogo muito aberto — ~30% base rate' },
};

// ── Melhor odds de valor por mercado (guia para apostadores) ──────────────────
const VALUE_ODDS_GUIDE = {
  'Over 1.5': {
    min_odds: 1.18, sweet_spot: '1.20-1.35',
    rationale: 'Base rate 88-92% → qualquer odd acima de 1.11 tem EV positivo em jogos selecionados',
    filters: ['Evitar jogos com pressão por empate (título/rebaixamento)', 'Preferir ligas ofensivas (ESP, ENG, BRA)'],
  },
  'BTTS': {
    min_odds: 1.65, sweet_spot: '1.70-1.95',
    rationale: 'Base rate ~52-58% → odds acima de 1.72 têm EV positivo com seleção PIE',
    filters: ['Evitar times com defesas sólidas (xGA < 0.9)', 'Preferir clássicos e derbies'],
  },
  'Over 2.5': {
    min_odds: 1.55, sweet_spot: '1.60-1.85',
    rationale: 'Base rate ~55% em ligas tier-1 → odd mínima justa = 1.82',
    filters: ['Preferir jogos com xG combinado > 3.0', 'Evitar jogos de ida em copas (times se fecham)'],
  },
  'Over Corners 8.5': {
    min_odds: 1.75, sweet_spot: '1.80-2.10',
    rationale: 'Base rate ~45% → precisa de seleção rigorosa de times ofensivos e estilo lateral',
    filters: ['Premier League e Bundesliga > outras ligas', 'Times com média de corners > 5.5/jogo'],
  },
};

// ── Utilitários ───────────────────────────────────────────────────────────────
function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function getLast7Days() {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - 1 - i);
    return d.toISOString().split('T')[0];
  }).reverse();
}

function appendLog(entry) {
  try {
    mkdirSync(join(ROOT, 'logs'), { recursive: true });
    appendFileSync(TRAINING_LOG, JSON.stringify(entry) + '\n', 'utf-8');
  } catch { /* silencioso */ }
}

function runScript(script, args = []) {
  const result = spawnSync('node', [join(ROOT, script), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    encoding: 'utf-8',
  });
  return result.status === 0;
}

// ── Relatório de progresso ─────────────────────────────────────────────────────
function printProgressReport() {
  const db   = loadDB();
  const hist = JSON.parse(readFileSync(HIST, 'utf-8'));
  const cal  = db.calibration || {};
  const tot  = db.stats.acertos + db.stats.erros;
  const globalPct = tot > 0 ? ((db.stats.acertos / tot) * 100).toFixed(1) : '0.0';

  console.log('\n' + '═'.repeat(72));
  console.log('  🎯 PIE TRAINING REPORT — Progresso em Direção a 98% de Assertividade');
  console.log('═'.repeat(72));
  console.log(`\n  Taxa global     : ${globalPct}%  (${db.stats.acertos} acertos / ${tot} outcomes)`);
  console.log(`  Partidas na base: ${hist.matches.length} jogos históricos`);
  console.log(`  Padrões positivos: ${db.positivePatterns.filter(p => p.active).length} ativos`);
  console.log(`  Lições ativas   : ${db.lessons.filter(l => l.active).length}`);

  console.log('\n  Mercado            | Atual  | Meta  | Gap   | Status       | Tier | Risco');
  console.log('  ' + '─'.repeat(70));

  for (const [market, target] of Object.entries(ACCURACY_TARGETS).sort((a,b) => b[1].tier - a[1].tier || a[0].localeCompare(b[0]))) {
    const c = cal[market];
    if (!c || c.total === 0) {
      console.log(`  ${market.padEnd(18)} | N/A    | ${String(target.target+'%').padEnd(5)} | —     | ⚫ Sem dados  | T${target.tier}   | ${target.risk}`);
      continue;
    }
    const pct  = ((c.hits / c.total) * 100).toFixed(1);
    const gap  = (target.target - parseFloat(pct)).toFixed(1);
    const bar  = parseFloat(pct) >= target.target ? '✅ META ATINGIDA' :
                 parseFloat(pct) >= target.target - 5 ? '🟡 Quase lá' :
                 parseFloat(pct) >= target.target - 15 ? '🔵 Em progresso' : '🔴 Abaixo';
    console.log(`  ${market.padEnd(18)} | ${String(pct+'%').padEnd(6)} | ${String(target.target+'%').padEnd(5)} | ${gap > 0 ? '-'+gap+'%' : '✓'} | ${bar.padEnd(14)} | T${target.tier}   | ${target.risk}`);
  }

  console.log('\n  📊 Dados de calibração por mercado (total/acertos):');
  for (const [market, c] of Object.entries(cal).sort((a,b) => b[1].total - a[1].total)) {
    const pct = ((c.hits / c.total) * 100).toFixed(1);
    const bar = '█'.repeat(Math.min(Math.round(c.total / 5), 20)) + '░'.repeat(Math.max(0, 20 - Math.round(c.total / 5)));
    const meta = ACCURACY_TARGETS[market]?.target;
    const metaStr = meta ? ` meta:${meta}%` : '';
    console.log(`  ${market.padEnd(18)} ${String(c.hits+'/'+c.total).padEnd(8)} ${String(pct+'%').padStart(6)}  ${bar}${metaStr}`);
  }

  console.log('\n  💡 Melhores Mercados (menor risco + valor):\n');
  for (const [market, guide] of Object.entries(VALUE_ODDS_GUIDE)) {
    const c = cal[market];
    const curPct = c && c.total > 0 ? ((c.hits / c.total) * 100).toFixed(1) : 'N/A';
    console.log(`  ${market}:`);
    console.log(`    Odds sweet spot: ${guide.sweet_spot} | Odds mín: ${guide.min_odds}`);
    console.log(`    Acurácia atual : ${curPct}% | Base rate real: ${guide.rationale.split('→')[0].trim()}`);
    console.log(`    Filtros: ${guide.filters[0]}`);
    console.log();
  }

  console.log('═'.repeat(72) + '\n');
}

// ── Treino de uma data ────────────────────────────────────────────────────────
async function trainDate(date) {
  const dataFile = join(DIR, `${date}.json`);
  const start    = Date.now();

  console.log(`\n🏋️  Treinando: ${date}`);

  // Passo 1: Coleta SofaScore se arquivo não existir ou estiver incompleto
  if (!existsSync(dataFile)) {
    console.log('  📡 Arquivo não encontrado — coletando do SofaScore...');
    const ok = runScript('scripts/sofascore-collector.js', [date]);
    if (!ok) {
      console.log(`  ⚠️  Falha na coleta. Pulando ${date}.`);
      return null;
    }
  } else {
    const existing = JSON.parse(readFileSync(dataFile, 'utf-8'));
    if (existing._instructions) {
      console.log('  ⚠️  Template não preenchido — pulando.');
      return null;
    }
    const hasSofaIds = existing.matches?.some(m => m.sofa_id);
    if (!hasSofaIds && existing.matches?.length < 5) {
      console.log('  📡 Enriquecendo com dados SofaScore...');
      runScript('scripts/sofascore-collector.js', [date]);
    }
  }

  // Passo 2: Injeta no PIE
  console.log('  🧠 Injetando no PIE...');
  const ok = runScript('scripts/daily-pie-update.js', [date]);
  if (!ok) {
    console.log(`  ❌ Falha na injeção PIE para ${date}`);
    return null;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  appendLog({ date, trained_at: new Date().toISOString(), elapsed_s: parseFloat(elapsed), source: 'sofascore+pie' });
  return { date, elapsed };
}

// ── Main ──────────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const week    = args.includes('--week');
const report  = args.includes('--report');
const dateArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));

if (report) {
  printProgressReport();
  process.exit(0);
}

const dates = week ? getLast7Days() : dateArg ? [dateArg] : [yesterday()];

console.log('\n🏋️  PIE TRAINING CYCLE');
console.log(`   Datas: ${dates.join(', ')}`);
console.log('═'.repeat(60));

for (const date of dates) {
  await trainDate(date);
}

console.log('\n═'.repeat(60));
console.log('📊 Relatório final:');
printProgressReport();
