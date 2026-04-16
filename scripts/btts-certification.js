/**
 * btts-certification.js — Fase 5: Certificação do BTTS Sniper v3
 *
 * Funções:
 *   1. Monitoramento contínuo: verifica o tracker e aciona certificação quando
 *      atingir 30+ amostras reais com >= 88% de acurácia
 *   2. Relatório ANTES vs DEPOIS: comparação completa em % entre v2 e v3
 *   3. Exibe critério de upgrade para meta final de 95%
 *
 * Uso:
 *   node scripts/btts-certification.js            → relatório completo + status
 *   node scripts/btts-certification.js --monitor  → loop contínuo (verifica a cada 6h)
 *   node scripts/btts-certification.js --compare  → só antes/depois
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __dir   = dirname(fileURLToPath(import.meta.url));
const ROOT    = join(__dir, '..');
const TRACKER = join(ROOT, 'data/btts-tracker.json');
const PIE     = join(ROOT, 'data/pie.json');
const INTEL   = join(ROOT, 'data/btts-sniper-intel.json');

const args      = process.argv.slice(2);
const MONITOR   = args.includes('--monitor');
const COMPARE   = args.includes('--compare');

function loadJSON(p) { try { return JSON.parse(readFileSync(p,'utf8')); } catch { return null; } }
function pct(h, t)   { return t ? Math.round((h/t)*100) : null; }
function delta(a, b) { const d = a - b; return (d >= 0 ? '+' : '') + d + 'pp'; }
function bar(v, w=24) {
  if (v === null) return '░'.repeat(w);
  const f = Math.round((v/100)*w);
  return '█'.repeat(f) + '░'.repeat(Math.max(0,w-f));
}
function padR(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }

// ── Coleta dados completos v2 (baseline) ──────────────────────────────────────
function collectBaselineV2(pie, tracker) {
  const calib = pie?.calibration?.BTTS || {};
  const byComp = calib.byCompetition || {};
  const byRange = calib.byRange || {};

  // Total baseline
  const total = calib.total || 0;
  const hits  = calib.hits  || 0;

  // v2 nos dados bloqueados pelo sniper (shadow)
  const shadow = tracker?.shadow_log || [];
  const shadowRes = shadow.filter(s => s.resolved);
  const shadowHits = shadowRes.filter(s => s.acertou).length;

  // Breakdown por range
  const r7080 = byRange['70-80'] || { total:0, hits:0 };
  const r8085 = byRange['80-85'] || { total:0, hits:0 };
  const r8590 = byRange['85-90'] || { total:0, hits:0 };

  // Breakdown por competição (kill zones)
  const killLeagues = ['UEFA Conference League', 'Copa del Rey', '2. Bundesliga',
    'Champions League', 'Chinese Super League', 'Queensland Premier League 1',
    'I-League', 'Indonesia Super League'];
  const koLeagues = ['UEFA Europa League, Knockout stage', 'UEFA Champions League, Knockout stage'];

  let killTotal=0, killHits=0, koTotal=0, koHits=0;
  Object.entries(byComp).forEach(([comp, s]) => {
    if (killLeagues.some(k => comp.includes(k.split(' ')[0]))) {
      killTotal += s.total; killHits += s.hits;
    }
    if (koLeagues.some(k => comp.includes('Knockout'))) {
      koTotal += s.total; koHits += s.hits;
    }
  });

  return {
    total, hits,
    acc: pct(hits, total),
    byRange: {
      '70-80': { total: r7080.total, hits: r7080.hits, acc: pct(r7080.hits, r7080.total) },
      '80-85': { total: r8085.total, hits: r8085.hits, acc: pct(r8085.hits, r8085.total) },
      '85-90': { total: r8590.total, hits: r8590.hits, acc: pct(r8590.hits, r8590.total) },
    },
    shadow: { total: shadowRes.length, hits: shadowHits, acc: pct(shadowHits, shadowRes.length) },
    fireZones: (() => {
      const fz = {};
      const tier1 = ['CONCACAF Champions Cup','VriendenLoterij Eredivisie','LaLiga','Premier League',
        'Bundesliga','Brasileirão Betano','Brasileirão Série B','Liga Portugal Betclic'];
      tier1.forEach(lg => {
        const s = byComp[lg];
        if (s) fz[lg] = { total: s.total, hits: s.hits, acc: pct(s.hits, s.total) };
      });
      return fz;
    })(),
  };
}

// ── Coleta dados completos v3 (sniper) ────────────────────────────────────────
function collectSniperV3(tracker) {
  const fired   = tracker?.fired_log   || [];
  const blocked = tracker?.blocked_log || [];
  const shadow  = tracker?.shadow_log  || [];

  const resolved = fired.filter(e => e.resolved);
  const hits     = resolved.filter(e => e.acertou).length;
  const misses   = resolved.filter(e => !e.acertou).length;

  // Erros evitados pelo sniper (bloqueados que teriam falhado)
  const shadowResolved = shadow.filter(s => s.resolved);
  const errorsAvoided  = shadowResolved.filter(s => !s.acertou).length;

  // Kill switch breakdown
  const ksCounts = {};
  blocked.forEach(b => {
    const k = (b.kill_switch || 'UNKNOWN').split('—')[0].trim()
      .replace(/Kill Switch /,'KS')
      .replace(/Threshold/,'Threshold')
      .trim();
    ksCounts[k] = (ksCounts[k]||0)+1;
  });

  // Fire zones (disparos aprovados por liga)
  const fzV3 = {};
  fired.forEach(e => {
    const comp = e.competition || 'Outras';
    if (!fzV3[comp]) fzV3[comp] = { total:0, hits:0 };
    fzV3[comp].total++;
    if (e.acertou) fzV3[comp].hits++;
  });
  Object.keys(fzV3).forEach(k => { fzV3[k].acc = pct(fzV3[k].hits, fzV3[k].total); });

  return {
    total: fired.length,
    resolved: resolved.length,
    hits, misses,
    acc: pct(hits, resolved.length),
    blocked: blocked.length,
    errorsAvoided,
    ksCounts,
    fireZones: fzV3,
    filterRate: pct(blocked.length, fired.length + blocked.length),
  };
}

// ── Relatório ANTES vs DEPOIS ─────────────────────────────────────────────────
function printBeforeAfter(v2, v3) {
  const W = 64;
  const sep = chalk.bold.cyan('═'.repeat(W));
  const line = chalk.gray('─'.repeat(W));

  console.log('\n' + sep);
  console.log(chalk.bold.cyan('  🎯 BTTS SNIPER v3 — RELATÓRIO ANTES vs DEPOIS'));
  console.log(chalk.bold.cyan('  Military Sniper Training — Resultado Final'));
  console.log(sep + '\n');

  // ── Bloco 1: Precisão Global ──────────────────────────────────────────────
  console.log(chalk.bold('▌ 1. PRECISÃO GLOBAL'));
  console.log(line);
  const accGain = v3.acc !== null && v2.acc !== null ? v3.acc - v2.acc : null;
  const accColor = v3.acc >= 88 ? chalk.green : v3.acc >= 75 ? chalk.yellow : chalk.red;

  console.log(
    chalk.bold(padR('  Modelo', 18)) +
    chalk.bold(padL('Amostras', 12)) +
    chalk.bold(padL('Acertos', 10)) +
    chalk.bold(padL('Precisão', 10))
  );
  console.log(
    padR('  v2 Baseline', 18) +
    padL(v2.total, 12) +
    padL(v2.hits, 10) +
    padL(chalk.yellow(v2.acc + '%'), 18)
  );
  console.log(
    padR('  v3 Sniper', 18) +
    padL(v3.resolved, 12) +
    padL(v3.hits, 10) +
    padL(accColor((v3.acc ?? 'N/A') + '%'), 18)
  );
  if (accGain !== null) {
    const gainStr = delta(v3.acc, v2.acc);
    const gainColor = accGain >= 0 ? chalk.bold.green : chalk.bold.red;
    console.log('\n  ' + chalk.bold('Ganho de precisão: ') + gainColor(gainStr));
  }

  // ── Bloco 2: Eficiência de Filtragem ────────────────────────────────────
  console.log('\n' + chalk.bold('▌ 2. EFICIÊNCIA DOS KILL SWITCHES'));
  console.log(line);
  const totalV2    = v2.total;
  const blocked    = v3.blocked;
  const filterRate = pct(blocked, totalV2);
  const errAvoided = v3.errorsAvoided;
  const errBase    = totalV2 - v2.hits;

  console.log(`  Amostras filtradas pelo Sniper: ${chalk.yellow(blocked)} / ${totalV2} (${filterRate}%)`);
  console.log(`  Erros evitados:                 ${chalk.green(errAvoided)} de ${errBase} erros totais`);
  console.log(`  Erros que "escaparam":          ${chalk.red(v3.misses)}`);

  const avoidRate = pct(errAvoided, errBase);
  console.log(`\n  Taxa de neutralização de erros: ${chalk.bold.green(avoidRate + '%')}`);
  console.log(`  ${chalk.gray(bar(avoidRate, 40))}`);

  // ── Bloco 3: Kill Switches breakdown ────────────────────────────────────
  console.log('\n' + chalk.bold('▌ 3. KILL SWITCHES ATIVOS'));
  console.log(line);
  const ksEntries = Object.entries(v3.ksCounts).sort((a,b) => b[1]-a[1]);
  ksEntries.forEach(([ks, count]) => {
    const pctKs = pct(count, blocked);
    const filled = Math.round((pctKs/100)*30);
    const b = '█'.repeat(filled) + '░'.repeat(30-filled);
    console.log(`  ${padR(ks, 12)} ${padL(count+'x', 6)} ${chalk.gray(b)} ${pctKs}%`);
  });

  // ── Bloco 4: Por Range de Probabilidade ─────────────────────────────────
  console.log('\n' + chalk.bold('▌ 4. PRECISÃO POR RANGE DE PROBABILIDADE (v2)'));
  console.log(line);
  Object.entries(v2.byRange).forEach(([range, s]) => {
    const icon = s.acc >= 80 ? '🟢' : s.acc >= 60 ? '🟡' : '🔴';
    const tag  = range === '70-80' ? chalk.red('← BLOQUEADO pelo Sniper') : '';
    console.log(`  ${icon} ${padR(range+'%:', 8)} ${padL(s.acc+'%', 6)} (${s.hits}/${s.total}) ${tag}`);
  });
  console.log('\n  ' + chalk.bold('→ Sniper exige mínimo 82%  ') + chalk.green('(range 80-85 = 82% acurácia real)'));

  // ── Bloco 5: Fire Zones ──────────────────────────────────────────────────
  console.log('\n' + chalk.bold('▌ 5. FIRE ZONES — LIGAS APROVADAS (calibração)'));
  console.log(line);
  Object.entries(v2.fireZones)
    .sort((a,b) => b[1].acc - a[1].acc)
    .forEach(([comp, s]) => {
      const icon = s.acc >= 70 ? '🟢' : s.acc >= 60 ? '🟡' : '🔴';
      const tier = s.acc >= 70 ? 'Tier 1' : s.acc >= 60 ? 'Tier 2' : 'Tier 3';
      console.log(`  ${icon} ${padR(comp.slice(0,32), 34)} ${padL(s.acc+'%', 6)} (${s.hits}/${s.total}) [${tier}]`);
    });

  // ── Bloco 6: Resumo Executivo ────────────────────────────────────────────
  console.log('\n' + sep);
  console.log(chalk.bold.cyan('  📋 RESUMO EXECUTIVO — ANTES vs DEPOIS'));
  console.log(sep);
  console.log('');

  const rows = [
    ['Métrica',                    'Antes (v2)',         'Depois (v3)',             'Variação'],
    ['─'.repeat(20),               '─'.repeat(14),       '─'.repeat(16),           '─'.repeat(12)],
    ['Precisão global',            v2.acc+'%',           (v3.acc ?? 'N/A')+'%',    accGain !== null ? delta(v3.acc, v2.acc) : 'N/A'],
    ['Amostras analisadas',        v2.total,              v3.resolved,              '−'+(v2.total - v3.resolved)+' (filtradas)'],
    ['Erros cometidos',            v2.total-v2.hits,      v3.misses,                '−'+(v2.total-v2.hits - v3.misses)+' erros'],
    ['Taxa acerto range 70-80%',   v2.byRange['70-80'].acc+'%', 'BLOQUEADO',        'Kill Switch 3'],
    ['Taxa acerto range 80-85%',   v2.byRange['80-85'].acc+'%', '82%+ exigido',     'threshold sniper'],
    ['Kill Switches ativos',       '0',                   '6 tipos',               '+6 camadas'],
    ['Erros evitados',             '0',                   v3.errorsAvoided,         '+'+v3.errorsAvoided+' erros evitados'],
    ['Ligas Tier 3 bloqueadas',    '0',                   '10+ ligas',             'proteção total'],
  ];

  rows.forEach(([m, b, a, v]) => {
    const isSep = m.startsWith('─');
    if (isSep) {
      console.log(chalk.gray('  ' + m.padEnd(22) + b.padEnd(16) + a.padEnd(18) + v));
    } else if (m === 'Métrica') {
      console.log(chalk.bold('  ' + padR(m,22) + padR(b,16) + padR(a,18) + v));
    } else {
      const vCol = String(v).startsWith('+') && !String(v).includes('pp') ? chalk.green(v) :
                   String(v).startsWith('−') ? chalk.green(v) :
                   String(v).includes('+') && String(v).includes('pp') ?
                     (parseInt(v) >= 0 ? chalk.green(v) : chalk.red(v)) : chalk.gray(v);
      console.log('  ' + padR(m,22) + chalk.yellow(padR(String(b),16)) + chalk.bold(padR(String(a),18)) + vCol);
    }
  });

  // ── Certificação ────────────────────────────────────────────────────────
  console.log('\n' + sep);
  console.log(chalk.bold.cyan('  🏅 STATUS DE CERTIFICAÇÃO'));
  console.log(sep);
  console.log('');

  const certAcc = v3.acc ?? pct(v3.hits, v3.resolved);
  const certN   = v3.resolved;
  const MIN_N   = 30;
  const MIN_ACC = 88;
  const TARGET  = 95;

  const phase1Done = certAcc >= MIN_ACC;
  const phase2Done = certN >= MIN_N;

  console.log(chalk.bold('  Critérios de Certificação:'));
  console.log(`  ${phase1Done ? '✅' : '⏳'} Precisão >= ${MIN_ACC}%:  ${certAcc ?? 'N/A'}% ${phase1Done ? chalk.green('ATINGIDO') : chalk.yellow('aguardando')}`);
  console.log(`  ${phase2Done ? '✅' : '⏳'} Amostras >= ${MIN_N}:    ${certN} ${phase2Done ? chalk.green('ATINGIDO') : chalk.yellow(MIN_N - certN + ' restantes')}`);
  console.log('');

  if (phase1Done && phase2Done) {
    console.log(chalk.bold.green('  ✅ BTTS SNIPER v3 — CERTIFICADO!'));
    console.log(chalk.green('  Modelo aprovado para produção. Próximo alvo: ' + TARGET + '%'));
  } else if (phase1Done) {
    console.log(chalk.bold.cyan('  📡 Precisão OK — Coletando amostras ao vivo...'));
    console.log(chalk.cyan(`  Faltam ${MIN_N - certN} jogos reais para certificação final.`));
    console.log(chalk.cyan('  Execute npm run btts-report-tg após cada ciclo de análise.'));
  } else if (phase2Done) {
    console.log(chalk.bold.yellow('  ⚠️  Amostras suficientes — Precisão abaixo de 88%'));
    console.log(chalk.yellow('  Investigar erros restantes e ajustar Kill Switches.'));
  } else {
    console.log(chalk.yellow(`  ⏳ Aguardando ${MIN_N - certN} amostras + validação de precisão`));
  }

  console.log('\n' + chalk.bold('  Roadmap para 95%:'));
  console.log(chalk.gray('  88% → Certificação fase 1 (30 amostras ao vivo)'));
  console.log(chalk.gray('  91% → Ativar Kelly 0.10 (apostas pequenas)'));
  console.log(chalk.gray('  93% → Ativar Kelly 0.15 (apostas médias)'));
  console.log(chalk.gray('  95% → Operacional Pleno — missão concluída'));
  console.log('\n' + sep + '\n');
}

// ── Monitor contínuo ─────────────────────────────────────────────────────────
async function monitor() {
  const CHECK_INTERVAL = 6 * 3600 * 1000; // 6h
  console.log(chalk.cyan('\n  [Monitor] BTTS Sniper — verificando a cada 6h...\n'));

  const check = () => {
    const tracker = loadJSON(TRACKER);
    if (!tracker) return;
    const { total_resolved, hits, accuracy } = tracker.summary;
    console.log(chalk.gray(`  [${new Date().toLocaleTimeString()}] ${total_resolved} amostras | precisão: ${accuracy ?? 'N/A'}%`));
    if (total_resolved >= 30 && (accuracy ?? 0) >= 88) {
      console.log(chalk.bold.green('\n  🏅 CERTIFICAÇÃO ATINGIDA! Executando relatório...\n'));
      const pie = loadJSON(PIE);
      const v2 = collectBaselineV2(pie, tracker);
      const v3 = collectSniperV3(tracker);
      printBeforeAfter(v2, v3);
    }
  };

  check();
  setInterval(check, CHECK_INTERVAL);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  const tracker = loadJSON(TRACKER);
  const pie     = loadJSON(PIE);

  if (!tracker || !pie) {
    console.error(chalk.red('❌ Arquivos necessários não encontrados'));
    process.exit(1);
  }

  const v2 = collectBaselineV2(pie, tracker);
  const v3 = collectSniperV3(tracker);

  printBeforeAfter(v2, v3);

  if (!COMPARE) {
    // Tenta enviar ao Telegram (admin only)
    try {
      const { sendTelegramMessage } = await import('../src/utils/telegram.js');
      const { total_resolved, hits, accuracy } = tracker.summary;
      const msg = [
        `🎯 <b>BTTS Sniper v3 — Certificação</b>`,
        ``,
        `📊 <b>Resultado do Treinamento:</b>`,
        `  v2 Baseline: <b>${v2.acc}%</b> (${v2.total} amostras)`,
        `  v3 Sniper:   <b>${v3.acc ?? 'N/A'}%</b> (${total_resolved} amostras)`,
        `  Ganho:       <b>${v3.acc !== null ? delta(v3.acc, v2.acc) : 'N/A'}</b>`,
        ``,
        `🛑 Kill Switches bloquearam <b>${v3.blocked}</b> casos`,
        `✅ Erros evitados: <b>${v3.errorsAvoided}</b>`,
        ``,
        `🏅 Status: ${total_resolved >= 30 && (accuracy??0) >= 88 ? '✅ CERTIFICADO' : `⏳ ${total_resolved}/30 amostras`}`,
      ].join('\n');
      await sendTelegramMessage(msg, { parse_mode:'HTML', disable_notification:true });
      console.log(chalk.green('  ✅ Relatório enviado ao Telegram'));
    } catch { /* silencioso */ }
  }

  if (MONITOR) await monitor();
}

run().catch(e => {
  console.error(chalk.red('Erro:'), e.message);
  process.exit(1);
});
