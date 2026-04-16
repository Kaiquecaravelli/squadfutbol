/**
 * btts-feedback-cycle.js — Fase 4: Loop de Feedback Acelerado
 *
 * Retroativamente aplica as regras do Sniper v3 sobre TODAS as predições
 * BTTS históricas no pie.json que já têm resultado real.
 *
 * Objetivo:
 *   Preencher o btts-tracker.json com dados históricos para:
 *   1. Medir a precisão real do Sniper v3 (vs baseline v2)
 *   2. Validar quantos erros os Kill Switches teriam evitado
 *   3. Calibrar Fire Zones por liga
 *   4. Verificar se a meta de 88% (caminho para 95%) já é atingível
 *
 * Uso:
 *   node scripts/btts-feedback-cycle.js            → processa + salva tracker
 *   node scripts/btts-feedback-cycle.js --dry-run  → processa sem salvar
 *   node scripts/btts-feedback-cycle.js --reset    → zera tracker antes de processar
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __dir    = dirname(fileURLToPath(import.meta.url));
const ROOT     = join(__dir, '..');
const PIE_PATH = join(ROOT, 'data/pie.json');
const TRACKER  = join(ROOT, 'data/btts-tracker.json');
const INTEL    = join(ROOT, 'data/btts-sniper-intel.json');

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const RESET   = args.includes('--reset');

// ── Kill Switch Engine — espelha a lógica do funnel-pre-live.js ───────────────
const KNOCKOUT_PATTERNS = [
  'knockout', 'round of 16', 'round of 32', 'quarter-final', 'quarter final',
  'semi-final', 'semi final', 'knockout stage', 'knockout phase',
];

const DEAD_LEAGUES = [
  'copa del rey', 'conference league', '2. bundesliga', 'second bundesliga',
  'championship', 'chinese super league', 'i-league',
  'queensland premier',     // Fase 4: 0% BTTS (erro confirmado)
  'indonesia super league', // amostra insuficiente
  'a-league.*men',          // Oceania
];

// Liga Tier map (da inteligência Fase 1 + correções Fase 4)
const TIER1 = [
  'eredivisie', 'laliga', 'la liga', 'premier league', 'bundesliga',
  'brasileirão betano', 'brasileirao betano', 'brasileirão série b', 'brasileirao serie b',
  'concacaf champions cup', 'liga portugal',
  // MLS removido do Tier 1 — 56% acurácia = Tier 2 neutro (Fase 4)
];

function applyKillSwitches(probabilidade, confianca, competition, recomendacao, matchData = {}) {
  const comp = (competition || '').toLowerCase();

  // KS1 — Fase eliminatória
  if (KNOCKOUT_PATTERNS.some(p => comp.includes(p))) {
    return { blocked: true, reason: 'Kill Switch 1 — fase eliminatória europeia' };
  }

  // KS2 — Liga morta (Tier 3)
  const isDeadLeague = DEAD_LEAGUES.some(p => { const re = new RegExp(p, 'i'); return re.test(comp); });
  if (isDeadLeague && !comp.includes('group')) {
    return { blocked: true, reason: `Kill Switch 2 — liga Tier 3 (${competition})` };
  }

  // KS2B — CONMEBOL grupo fraco (Fase 4: Libertadores Group E → 0% BTTS)
  if (/conmebol.*(libertadores|sudamericana).*(group|grupo)/i.test(comp)) {
    const homeBtts = matchData.home?.btts_pct ?? 0;
    const awayBtts = matchData.away?.btts_pct ?? 0;
    if (homeBtts < 55 || awayBtts < 55) {
      return { blocked: true, reason: `Kill Switch 2B — CONMEBOL grupo fraco (${competition})` };
    }
  }

  // KS3 — Threshold sniper (82% prob + 80% conf)
  // Verifica se é liga Tier 1 para threshold reduzido (80%)
  const isTier1 = TIER1.some(t => comp.includes(t));
  const minProb = isTier1 ? 80 : 82;
  const minConf = 80;

  if ((probabilidade || 0) < minProb) {
    return {
      blocked: true,
      reason: `Threshold — prob ${probabilidade}% < ${minProb}% (${isTier1 ? 'Tier1' : 'padrão'})`,
    };
  }

  if ((confianca || 0) < minConf) {
    return {
      blocked: true,
      reason: `Threshold — confiança ${confianca}% < ${minConf}%`,
    };
  }

  return { blocked: false, reason: null };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function pct(h, t) {
  return t ? Math.round((h / t) * 100) : null;
}

function bar(acc, width = 24) {
  if (acc === null) return '[ sem dados ]';
  const filled = Math.round((acc / 100) * width);
  return '[' + '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled)) + ']';
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log(chalk.bold.cyan('\n━'.repeat(60)));
  console.log(chalk.bold.cyan('  🎯 BTTS Sniper — Fase 4: Feedback Cycle Acelerado'));
  console.log(chalk.bold.cyan('━'.repeat(60) + '\n'));

  const pie = loadJSON(PIE_PATH);
  if (!pie) { console.error(chalk.red('❌ pie.json não encontrado')); process.exit(1); }

  let tracker = loadJSON(TRACKER);
  if (!tracker || RESET) {
    tracker = {
      _meta: {
        version: '1.0', created_at: new Date().toISOString(),
        description: 'BTTS Sniper v3 — Tracker pós backfill retroativo',
        model_version: 'sniper-v3', target_accuracy: 95, min_sample_for_cert: 30,
      },
      summary: { total_fired: 0, total_blocked: 0, total_resolved: 0, hits: 0, misses: 0, accuracy: null, last_updated: null },
      blocked_log: [], fired_log: [], shadow_log: [],
    };
    if (RESET) console.log(chalk.yellow('  ♻️  Tracker resetado.\n'));
  }

  // Deduplica: não processa prediction_id já no tracker
  const alreadyProcessed = new Set([
    ...(tracker.fired_log || []).map(e => e.prediction_id).filter(Boolean),
    ...(tracker.blocked_log || []).map(e => e.prediction_id).filter(Boolean),
  ]);

  // Build resultado lookup
  const resultByPredId = {};
  (pie.results || []).forEach(r => {
    if (r.prediction_id) resultByPredId[r.prediction_id] = r;
  });

  // Coleta todas as predições BTTS com resultado disponível
  const bttsPreds = (pie.predictions || []).filter(p => {
    if (alreadyProcessed.has(p.id)) return false;
    const btts = (p.markets || []).find(m => m.market === 'BTTS');
    if (!btts) return false;
    return !!resultByPredId[p.id];
  });

  // Inclui também calibration data (maior conjunto — 1597 amostras)
  // Simula usando byCompetition e byRange para calcular impacto dos Kill Switches
  const calibByComp = pie.calibration?.BTTS?.byCompetition || {};
  const calibByRange = pie.calibration?.BTTS?.byRange || {};

  console.log(chalk.bold(`📦 Predições BTTS com resultado: ${chalk.yellow(bttsPreds.length)}`));
  console.log(chalk.bold(`📊 Amostras calibração disponíveis: ${chalk.yellow(pie.calibration?.BTTS?.total || 0)}\n`));

  // ── Processa predições individuais ─────────────────────────────────────────
  let newFired = 0, newBlocked = 0;
  const firezone = {};
  const killzones = {};

  for (const pred of bttsPreds) {
    const btts = pred.markets.find(m => m.market === 'BTTS');
    if (!btts) continue;

    const result = resultByPredId[pred.id];
    const bttsOutcome = (result.market_outcomes || []).find(m => m.market === 'BTTS');
    if (!bttsOutcome) continue;

    const { blocked, reason } = applyKillSwitches(
      btts.probabilidade,
      btts.confianca,
      pred.competition,
      btts.recommendation || btts.recomendacao
    );

    const entry = {
      prediction_id: pred.id,
      match_name:    pred.match_name,
      competition:   pred.competition,
      match_date:    pred.match_date,
      fired_at:      pred.created_at,
      probabilidade: btts.probabilidade,
      confianca:     btts.confianca,
      recomendacao:  btts.recommendation || btts.recomendacao,
      resolved:      true,
      acertou:       bttsOutcome.acertou,
      score_real:    result.placar_real,
      resolved_at:   result.registered_at,
      source:        'backfill_historico',
    };

    if (blocked) {
      tracker.blocked_log.push({ ...entry, kill_switch: reason });
      // Shadow: v2 (prob >= 80%) teria disparado?
      const v2WouldFire = (btts.probabilidade >= 80) && (btts.recomendacao === 'SIM' || btts.recommendation === 'SIM');
      tracker.shadow_log.push({ ...entry, kill_switch: reason, v2_would_fire: v2WouldFire });
      killzones[reason] = (killzones[reason] || 0) + 1;
      newBlocked++;
    } else {
      tracker.fired_log.push(entry);
      // Rastreia por Fire Zone
      const comp = pred.competition || 'Outras';
      if (!firezone[comp]) firezone[comp] = { total: 0, hits: 0 };
      firezone[comp].total++;
      if (bttsOutcome.acertou) firezone[comp].hits++;
      newFired++;
    }
  }

  // ── Simula impacto nos dados de calibração (1597 amostras) ─────────────────
  // Aplica Kill Switches KS1+KS2 nas amostras de calibração por competição
  let calibFiredTotal = 0, calibFiredHits = 0;
  let calibBlockedTotal = 0, calibBlockedV2Errors = 0;

  for (const [comp, stats] of Object.entries(calibByComp)) {
    const compLow = comp.toLowerCase();
    const isKO = KNOCKOUT_PATTERNS.some(p => compLow.includes(p));
    const isDead = DEAD_LEAGUES.some(p => compLow.includes(p)) && !compLow.includes('group');

    if (isKO || isDead) {
      calibBlockedTotal += stats.total;
      calibBlockedV2Errors += (stats.total - stats.hits); // erros que seriam evitados
    } else {
      calibFiredTotal += stats.total;
      calibFiredHits += stats.hits;
    }
  }

  // Aplica Kill Switch de threshold (70-80% = 60.1% acurácia)
  const range7080 = calibByRange['70-80'] || { total: 0, hits: 0 };
  const range80up = Object.entries(calibByRange)
    .filter(([k]) => k !== '70-80')
    .reduce((acc, [, v]) => ({ total: acc.total + v.total, hits: acc.hits + v.hits }), { total: 0, hits: 0 });

  // Amostras que PASSARIAM no threshold 82% (proxy: 80-85 + 85-90 ranges)
  const thresholdPassed = range80up;
  // Amostras que SERIAM BLOQUEADAS pelo threshold (70-80)
  const thresholdBlocked = range7080;
  const thresholdErrorsAvoided = thresholdBlocked.total - thresholdBlocked.hits; // falsos SIM evitados

  // ── Atualiza summary do tracker ───────────────────────────────────────────
  const allFired    = tracker.fired_log.filter(e => e.resolved);
  const allBlocked  = tracker.blocked_log;
  const allShadow   = tracker.shadow_log;

  tracker.summary = {
    total_fired:    tracker.fired_log.length,
    total_blocked:  tracker.blocked_log.length,
    total_resolved: allFired.length,
    hits:           allFired.filter(e => e.acertou).length,
    misses:         allFired.filter(e => !e.acertou).length,
    accuracy:       pct(allFired.filter(e => e.acertou).length, allFired.length),
    last_updated:   new Date().toISOString(),
  };

  if (!DRY_RUN) {
    writeFileSync(TRACKER, JSON.stringify(tracker, null, 2), 'utf8');
    console.log(chalk.green(`  ✅ Tracker salvo com ${newFired} disparos + ${newBlocked} bloqueios\n`));
  }

  // ── Relatório ──────────────────────────────────────────────────────────────
  const { total_fired, total_blocked, total_resolved, hits, misses } = tracker.summary;
  const acc      = pct(hits, total_resolved);
  const baseline = pct(pie.calibration?.BTTS?.hits, pie.calibration?.BTTS?.total);

  console.log(chalk.bold('═'.repeat(60)));
  console.log(chalk.bold.green('  📊 RESULTADOS DO BACKFILL RETROATIVO'));
  console.log(chalk.bold('═'.repeat(60)));

  console.log(chalk.bold('\n🎯 SNIPER v3 — DISPAROS APROVADOS:'));
  console.log(`  Total disparos:   ${chalk.yellow(total_fired)}`);
  console.log(`  Resolvidos:       ${chalk.yellow(total_resolved)}`);
  console.log(`  ✅ Acertos:       ${chalk.green(hits)}`);
  console.log(`  ❌ Erros:         ${chalk.red(misses)}`);
  console.log(`  Precisão Sniper:  ${acc !== null ? chalk.bold.green(acc + '%') : chalk.gray('N/A')} ${bar(acc)}`);
  console.log(`  Precisão Baseline v2: ${chalk.yellow(baseline + '%')} ${bar(baseline)}`);
  if (acc !== null && baseline !== null) {
    const gain = acc - baseline;
    const gainColor = gain >= 0 ? chalk.green : chalk.red;
    console.log(`  Ganho do Sniper:  ${gainColor((gain >= 0 ? '+' : '') + gain + 'pp')}`);
  }

  console.log(chalk.bold('\n🛑 BLOQUEIOS — KILL SWITCHES:'));
  console.log(`  Total bloqueados: ${chalk.yellow(total_blocked)}`);
  // Calcula erros evitados (bloqueados que teriam falhado)
  const errorsAvoided = allBlocked.filter(e => e.resolved && !e.acertou).length;
  const v2WouldFire   = allShadow.filter(s => s.v2_would_fire).length;
  const v2WouldError  = allShadow.filter(s => s.v2_would_fire && s.resolved && !s.acertou).length;
  if (errorsAvoided > 0) console.log(`  Erros evitados:   ${chalk.green(errorsAvoided)} (v2 teria cometido)`);
  if (v2WouldFire > 0) {
    console.log(`  Shadow (v2): ${v2WouldFire} disparos → ${v2WouldError} erros que Sniper bloqueou`);
  }

  // Kill switch breakdown
  if (Object.keys(killzones).length) {
    const topKs = Object.entries(killzones).sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log('  Por Kill Switch:');
    topKs.forEach(([k, v]) => console.log(`    • ${k}: ${chalk.gray(v + 'x')}`));
  }

  // ── Análise das amostras de calibração (simulação maior) ──────────────────
  console.log(chalk.bold('\n📈 SIMULAÇÃO NAS 1597 AMOSTRAS DE CALIBRAÇÃO:'));
  console.log(`  Amostras que passariam no Sniper:  ${chalk.yellow(calibFiredTotal)}`);
  console.log(`  Precisão estimada (Fire Zones):    ${chalk.green(pct(calibFiredHits, calibFiredTotal) + '%')} ${bar(pct(calibFiredHits, calibFiredTotal))}`);
  console.log(`  Bloqueadas por Kill Switch KS1/KS2:${chalk.gray(' ' + calibBlockedTotal)}`);
  console.log(`  Erros evitados (KS1/KS2):          ${chalk.green(calibBlockedV2Errors)}`);
  console.log(`  Bloqueadas por Threshold (70-80%): ${chalk.gray(' ' + thresholdBlocked.total)}`);
  console.log(`  Falsos SIM evitados (threshold):   ${chalk.green(thresholdErrorsAvoided)}`);
  const totalErrorsAvoided = calibBlockedV2Errors + thresholdErrorsAvoided;
  console.log(`  ${chalk.bold('Total de erros evitados pelo Sniper: ' + chalk.green.bold(totalErrorsAvoided))}`);

  // ── Fire Zone por liga ─────────────────────────────────────────────────────
  if (Object.keys(firezone).length) {
    console.log(chalk.bold('\n🔥 FIRE ZONES — PRECISÃO POR LIGA (backfill):'));
    Object.entries(firezone)
      .sort((a, b) => b[1].total - a[1].total)
      .forEach(([comp, s]) => {
        const p = pct(s.hits, s.total);
        const icon = p >= 80 ? '🟢' : p >= 65 ? '🟡' : '🔴';
        console.log(`  ${icon} ${comp}: ${chalk.bold(p + '%')} (${s.hits}/${s.total})`);
      });
  }

  // ── Calibração por liga (dados completos do calibration) ──────────────────
  console.log(chalk.bold('\n📊 CALIBRAÇÃO COMPLETA — LIGAS TIER 1 (pós KS):'));
  const tier1Comps = Object.entries(calibByComp)
    .filter(([comp]) => {
      const c = comp.toLowerCase();
      return TIER1.some(t => c.includes(t));
    })
    .map(([comp, s]) => ({ comp, ...s, pct: pct(s.hits, s.total) }))
    .sort((a, b) => b.pct - a.pct);

  tier1Comps.forEach(({ comp, pct: p, hits: h, total: t }) => {
    const icon = p >= 80 ? '🟢' : p >= 65 ? '🟡' : '🔴';
    console.log(`  ${icon} ${comp}: ${chalk.bold(p + '%')} (${h}/${t})`);
  });

  // ── Certificação ──────────────────────────────────────────────────────────
  console.log(chalk.bold('\n🏅 STATUS DE CERTIFICAÇÃO:'));
  const certAcc = acc ?? pct(calibFiredHits, calibFiredTotal);
  const certSamples = total_resolved || calibFiredTotal;
  if (certSamples >= 30 && certAcc >= 88) {
    console.log(chalk.green(`  ✅ CRITÉRIOS DE FASE 5 ATINGIDOS: ${certAcc}% com ${certSamples} amostras`));
    console.log(chalk.green('  → Sniper v3 elegível para certificação!'));
  } else {
    console.log(chalk.yellow(`  Precisão: ${certAcc ?? 'N/A'}%  |  Amostras: ${certSamples}`));
    console.log(chalk.yellow(`  Meta certificação: 88%+ com 30+ amostras → depois 95%`));
    if (certAcc >= 88) {
      console.log(chalk.cyan(`  → Precisão OK! Acumular ${Math.max(0, 30 - certSamples)} amostras adicionais`));
    } else if (certSamples >= 30) {
      console.log(chalk.cyan(`  → Amostras OK! Precisão precisa subir ${88 - certAcc}pp`));
    }
  }

  console.log('\n' + chalk.bold.cyan('━'.repeat(60)) + '\n');
}

run().catch(e => {
  console.error(chalk.red('Erro:'), e.message);
  console.error(e.stack);
  process.exit(1);
});
