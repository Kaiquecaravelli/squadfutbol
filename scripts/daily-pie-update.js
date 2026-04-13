#!/usr/bin/env node
/**
 * daily-pie-update.js
 * Rotina diária: lê partidas coletadas, analisa padrões e injeta no PIE.
 *
 * Uso:
 *   node scripts/daily-pie-update.js                  # processa ontem
 *   node scripts/daily-pie-update.js 2026-04-10       # data específica
 *   node scripts/daily-pie-update.js --template       # gera template vazio
 *   node scripts/daily-pie-update.js 2026-04-10 --template
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { batchSaveAnalysis, loadDB, getStats } from '../src/pie/pie-storage.js';
import { analyzeMatch } from './lib/match-analyzer.js';
import { isObsidianConfigured, updatePadroesAprendidos, updateRoiPerformance, rebuildDashboard } from '../src/utils/obsidian.js';

const __dir    = dirname(fileURLToPath(import.meta.url));
const ROOT     = join(__dir, '..');
const HIST     = join(ROOT, 'data/historical-patterns.json');
const DIR      = join(ROOT, 'data/daily-matches');
const EXEC_LOG = join(ROOT, 'logs/pie-execucoes.jsonl');

// ── Utilitários ───────────────────────────────────────────────────────────────
function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

// ── Template de coleta ────────────────────────────────────────────────────────
function makeTemplate(date) {
  return {
    date,
    source: 'flashscore.com.br',
    collected_at: new Date().toISOString(),
    _instructions: [
      'Preencha cada partida com resultado >= 1:1 (ambas as equipes marcaram).',
      'Remova ou ignore este campo _instructions antes de rodar o update.',
      'Campos obrigatorios: match, competition, result.',
      'Campos opcionais mas recomendados: ht_score, goals_timeline, match_stats, pre_match.',
    ],
    matches: [
      {
        match: 'Time Mandante vs Time Visitante',
        competition: 'Nome da Liga',
        result: {
          home_goals: 2,
          away_goals: 1,
          placar: '2-1',
        },
        ht_score: { home: 1, away: 0 },
        goals_timeline: [
          { minute: 15, team: 'home', scorer: 'Jogador (opcional)', type: 'open_play' },
          { minute: 60, team: 'home', type: 'open_play' },
          { minute: 75, team: 'away', type: 'open_play' },
        ],
        match_stats: {
          shots_home: 12,
          shots_away: 8,
          shots_on_goal_home: 5,
          shots_on_goal_away: 3,
          possession_home: 55,
          possession_away: 45,
          corners_home: 6,
          corners_away: 4,
          yellow_cards_home: 2,
          yellow_cards_away: 1,
          red_cards_home: 0,
          red_cards_away: 0,
        },
        pre_match: {
          home: { team: 'Time Mandante', position: null, form: null, goals_avg: null },
          away: { team: 'Time Visitante', position: null, form: null, goals_avg: null },
        },
        notes: '',
      },
    ],
  };
}

// ── Log de execução ───────────────────────────────────────────────────────────
function appendExecLog(entry) {
  try {
    mkdirSync(join(ROOT, 'logs'), { recursive: true });
    appendFileSync(EXEC_LOG, JSON.stringify(entry) + '\n', 'utf-8');
  } catch { /* silencioso */ }
}

// ── Main ──────────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const wantTpl    = args.includes('--template');
const dateArg    = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const date       = dateArg || yesterday();
const dataFile   = join(DIR, `${date}.json`);

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

// ── Modo template ─────────────────────────────────────────────────────────────
if (wantTpl) {
  if (existsSync(dataFile) && !args.includes('--force')) {
    console.log(`\n⚠️  Arquivo já existe: data/daily-matches/${date}.json`);
    console.log('   Use --force para sobrescrever.');
  } else {
    writeFileSync(dataFile, JSON.stringify(makeTemplate(date), null, 2), 'utf-8');
    console.log(`\n✅ Template criado: data/daily-matches/${date}.json`);
    console.log('\n📋 Próximos passos:');
    console.log('   1. Acesse flashscore.com.br > Resultados > Futebol > Encerrados > ' + date);
    console.log('   2. Para cada jogo com resultado >= 1:1, preencha o arquivo JSON');
    console.log('   3. Rode: npm run daily-update ' + date);
  }
  process.exit(0);
}

// ── Verificação do arquivo ────────────────────────────────────────────────────
if (!existsSync(dataFile)) {
  console.log(`\n❌ Dados não encontrados: data/daily-matches/${date}.json`);
  console.log('\n📋 Fluxo recomendado:');
  console.log(`   1. npm run daily-template ${date}   → gera o template`);
  console.log('   2. Preencha com dados do flashscore.com.br');
  console.log(`   3. npm run daily-update ${date}     → processa e injeta no PIE`);
  process.exit(1);
}

// ── Leitura e validação ───────────────────────────────────────────────────────
let data;
try {
  data = JSON.parse(readFileSync(dataFile, 'utf-8'));
} catch (e) {
  console.error(`\n❌ JSON inválido em ${dataFile}: ${e.message}`);
  process.exit(1);
}

const allMatches = data.matches || [];
// Filtra jogos com resultado >= 1:1 (ambas marcaram pelo menos 1)
const qualified  = allMatches.filter(m => {
  const h = m.result?.home_goals ?? 0;
  const a = m.result?.away_goals ?? 0;
  return h >= 1 && a >= 1;
});
const skipped = allMatches.length - qualified.length;

console.log(`\n🧠 PIE — Atualização Diária: ${date}`);
console.log(`   Fonte: ${data.source || 'flashscore.com.br'}`);
console.log(`   Partidas no arquivo : ${allMatches.length}`);
console.log(`   Com resultado >= 1:1: ${qualified.length}${skipped > 0 ? ` (${skipped} ignoradas — sem BTTS)` : ''}`);
console.log('═'.repeat(64));

const predId   = `daily_${date.replace(/-/g, '')}`;
const execStart = Date.now();
const analyses = [];
let totH = 0;

// ── Histórico em lote (1 leitura + 1 gravação para todas as partidas) ─────────
const histData = JSON.parse(readFileSync(HIST, 'utf-8'));
for (const match of qualified) {
  const analysis = analyzeMatch(match);
  analyses.push(analysis);

  const score = match.result?.placar ?? `${match.result?.home_goals ?? 0}-${match.result?.away_goals ?? 0}`;
  const name  = (match.match || 'Jogo').substring(0, 36).padEnd(36);
  const p = analysis.positives.length, l = analysis.lessons.length, c = analysis.calibration.length;
  const w = analysis.calibration.filter(x => x.acertou).length;
  console.log(`  ✅ ${name} ${score.padEnd(6)}  +${p}P +${l}L +${c}C (${w} wins)`);

  // Histórico — inline para evitar N reads do arquivo
  const r  = match.result || {};
  const s  = match.match_stats || {};
  const tg = (r.home_goals || 0) + (r.away_goals || 0);
  const tc = s.corners_total ?? ((s.corners_home || 0) + (s.corners_away || 0));
  const ty = (s.yellow_cards_home || 0) + (s.yellow_cards_away || 0);
  const slug    = (match.match || '').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').substring(0, 40);
  const matchId = `daily_${date.replace(/-/g, '')}_${slug}`;
  if (!histData.matches.find(m => m.match_id === matchId)) {
    histData.matches.push({
      match_id: matchId, match: match.match, competition: match.competition,
      match_date: date, source: 'flashscore.com.br / daily-update',
      result: r, ht_score: match.ht_score, goals_timeline: match.goals_timeline,
      match_stats: s, pre_match: match.pre_match, notes: match.notes,
      market_outcomes: [
        { market: 'BTTS',             won: r.home_goals > 0 && r.away_goals > 0 },
        { market: 'Over 1.5',         won: tg >= 2 },
        { market: 'Over 2.5',         won: tg >= 3 },
        { market: 'Over 3.5',         won: tg >= 4 },
        { market: 'Over Corners 8.5', won: tc > 8.5 },
        { market: 'Over Corners 7.5', won: tc > 7.5 },
        { market: 'Over Corners 6.5', won: tc > 6.5 },
        { market: 'YC 4.5',           won: ty > 4.5 },
        { market: 'YC 3.5',           won: ty > 3.5 },
        { market: 'YC 2.5',           won: ty > 2.5 },
      ],
      auto_analyzed: true,
    });
    totH++;
  }
}
// Uma única gravação no histórico
writeFileSync(HIST, JSON.stringify(histData, null, 2), 'utf-8');

// ── Injeção em lote no PIE (1 loadDB + 1 saveDB para todas as partidas) ───────
const dbAfter = batchSaveAnalysis(analyses, predId);

const totP = analyses.reduce((s, a) => s + a.positives.length, 0);
const totL = analyses.reduce((s, a) => s + a.lessons.length, 0);
const totC = analyses.reduce((s, a) => s + a.calibration.length, 0);
const totW = analyses.reduce((s, a) => s + a.calibration.filter(x => x.acertou).length, 0);
const totM = totC - totW;

// ── Resumo ────────────────────────────────────────────────────────────────────
const tot = dbAfter.stats.acertos + dbAfter.stats.erros;
const pct = tot > 0 ? ((dbAfter.stats.acertos / tot) * 100).toFixed(1) : '0.0';
const elapsed = ((Date.now() - execStart) / 1000).toFixed(1);

console.log('\n' + '─'.repeat(64));
console.log(`  Padrões positivos injetados  : ${totP}`);
console.log(`  Lições injetadas             : ${totL}`);
console.log(`  Outcomes calibração          : ${totC} (${totW} acertos / ${totM} erros)`);
console.log(`  Partidas salvas no histórico : ${totH} novas`);
console.log(`  Tempo de execução            : ${elapsed}s`);

console.log('\n📊 PIE — Estado global após update:');
console.log(`  Padrões positivos ativos : ${dbAfter.positivePatterns.filter(p => p.active).length}`);
console.log(`  Lições ativas            : ${dbAfter.lessons.filter(l => l.active).length}`);
console.log(`  Total outcomes           : ${tot} — Taxa: ${pct}%`);
console.log(`  Partidas na base         : ${histData.matches.length} jogos`);

console.log('\n📊 Calibração por mercado:');
for (const [mkt, cal] of Object.entries(dbAfter.calibration).sort((a,b) => b[1].total - a[1].total)) {
  const acc = ((cal.hits / cal.total) * 100).toFixed(1);
  const bar = '█'.repeat(Math.min(Math.round(cal.hits / cal.total * 10), 10));
  console.log(`  ${mkt.padEnd(18)} ${String(cal.hits + '/' + cal.total).padEnd(7)} ${acc.padStart(5)}%  ${bar}`);
}

// ── Obsidian sync ─────────────────────────────────────────────────────────────
if (isObsidianConfigured()) {
  process.stdout.write('\n🔄 Sincronizando Obsidian...');
  const stats = getStats();
  const activeLessons = dbAfter.lessons.filter(l => l.active);
  updatePadroesAprendidos(activeLessons, dbAfter.calibration);
  updateRoiPerformance(stats);
  rebuildDashboard();
  console.log(' ✅ Vault atualizado em tempo real.');
} else {
  console.log('\n⚠️  Obsidian não configurado (OBSIDIAN_VAULT_PATH em .env)');
}

// ── Log de execução ───────────────────────────────────────────────────────────
appendExecLog({
  type: 'daily-update', date, executed_at: new Date().toISOString(),
  elapsed_s: parseFloat(elapsed),
  matches_processed: qualified.length, matches_historic: totH,
  positives: totP, lessons: totL, calibration: totC, wins: totW, misses: totM,
  global_rate_pct: parseFloat(pct), total_outcomes: tot,
  obsidian_synced: isObsidianConfigured(),
});

console.log('\n' + '═'.repeat(64));
console.log(`✅ ATUALIZAÇÃO CONCLUÍDA — ${date} (${qualified.length} jogos processados)\n`);
