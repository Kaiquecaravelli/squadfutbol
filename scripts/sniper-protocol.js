#!/usr/bin/env node
/**
 * sniper-protocol.js — Protocolo Sniper Militar
 *
 * Filosofia: "One Shot, One Kill" — só atirar quando o alvo está confirmado.
 * Inspirado no treinamento de sniper do SOCOM / Força Especial Americana:
 *
 *   Regra 1: Sem tiro = melhor do que tiro errado.
 *   Regra 2: Precisão > Quantidade. Um GREEN vale mais que cinco sinais duvidosos.
 *   Regra 3: Calibre o gatilho — quanto mais sinais confirmam, mais seguro o disparo.
 *   Regra 4: Relatório após cada missão. Aprende com cada tiro dado e cada tiro negado.
 *   Regra 5: Threshold dinâmico — eleva o padrão à medida que a precisão aumenta.
 *
 * Como funciona:
 *   1. Carrega todos os jogos históricos com resultado real.
 *   2. Para cada jogo, conta quantos "sinais confirmadores" existem por mercado.
 *   3. Agrupa por banda de sinal: COLD (1-2), WARM (3-4), HOT (5-6), ELITE (7+).
 *   4. Calcula precisão real por banda por mercado.
 *   5. Determina o "threshold sniper" — número mínimo de sinais para atingir a meta.
 *   6. Grava recomendações no PIE (sniper_thresholds) para uso no quant.js.
 *   7. Imprime relatório tático em formato militar.
 *
 * Uso:
 *   node scripts/sniper-protocol.js           → análise completa + salva thresholds
 *   node scripts/sniper-protocol.js --dry-run → análise completa, NÃO salva
 *   node scripts/sniper-protocol.js --report  → imprime último relatório salvo
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { isObsidianConfigured, updateSniperProtocol } from '../src/utils/obsidian.js';

const __dir    = dirname(fileURLToPath(import.meta.url));
const ROOT     = join(__dir, '..');
const PIE_PATH = join(ROOT, 'data/pie.json');
const DAILY_DIR      = join(ROOT, 'data/daily-matches');
const HIST_CACHE_DIR = join(ROOT, 'data/historical-cache');
const SNIPER_LOG     = join(ROOT, 'logs/sniper-report.jsonl');
const LOG_DIR        = join(ROOT, 'logs');

const ARGS     = process.argv.slice(2);
const DRY_RUN  = ARGS.includes('--dry-run');
const RPT_ONLY = ARGS.includes('--report');

mkdirSync(LOG_DIR, { recursive: true });

// ── Mercados avaliados com suas metas ─────────────────────────────────────────
const MARKET_TARGETS = {
  'Over 1.5':         98,
  'BTTS':             95,
  'Over 2.5':         92,
  'Over Corners 6.5': 90,
  'Over Corners 7.5': 85,
  'YC 2.5':           85,
  'YC 3.5':           75,
  'Over 3.5':         70,
};

// Ligas premium (mais confiáveis)
const PREMIUM_LEAGUES = new Set([
  'Premier League','La Liga','Serie A','Bundesliga','Ligue 1',
  'Champions League','Europa League','Brasileirão Betano',
]);

// ── Bandas de confiança (número de sinais confirmadores) ─────────────────────
// Analogia sniper:
//   COLD  = 1-2 sinais → "Alvo não confirmado" — abstain
//   WARM  = 3-4 sinais → "Alvo em avaliação" — cautela
//   HOT   = 5-6 sinais → "Alvo confirmado" — green light
//   ELITE = 7+  sinais → "Alvo eliminado" — disparo certeiro
const BANDS = [
  { label: 'COLD',  min: 1, max: 2,   color: 'gray'   },
  { label: 'WARM',  min: 3, max: 4,   color: 'yellow' },
  { label: 'HOT',   min: 5, max: 6,   color: 'green'  },
  { label: 'ELITE', min: 7, max: 999, color: 'cyan'   },
];

function getBand(signalCount) {
  return BANDS.find(b => signalCount >= b.min && signalCount <= b.max) || BANDS[0];
}

// ── Logger ────────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}
function log(icon, msg, color = 'white') {
  const line = `[${ts()}] ${icon}  ${msg}`;
  console.log(chalk[color]?.(line) ?? line);
}

// ── Carregamento de dados (limita a 90 dias para evitar OOM) ─────────────────
const MAX_HISTORY_DAYS = 90;

function loadAllMatches() {
  const sources = [DAILY_DIR, HIST_CACHE_DIR].filter(d => existsSync(d));
  if (!sources.length) return [];
  const seenIds = new Set();
  const all = [];

  // Calcula cutoff de 90 dias atrás (formato YYYY-MM-DD)
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_HISTORY_DAYS);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  for (const dir of sources) {
    // Ordena decrescente (mais recente primeiro) e filtra pelo cutoff no nome do arquivo
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.json') && f >= cutoffStr + '.json')
      .sort()
      .reverse();

    for (const file of files) {
      try {
        const raw     = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
        const matches = raw.matches || raw;
        if (!Array.isArray(matches)) continue;
        for (const m of matches) {
          if (!m.result || !m.match_stats) continue;
          const d   = m.match_date || file.replace('.json', '');
          const uid = `${(m.match || '').toLowerCase().replace(/\s+/g,'_')}_${d}`;
          if (seenIds.has(uid)) continue;
          seenIds.add(uid);
          all.push(m);
        }
      } catch { /* arquivo corrompido */ }
    }
  }
  return all;
}

// ── Avalia resultado real de cada mercado ─────────────────────────────────────
function evalMarkets(match) {
  const r  = match.result || {};
  const s  = match.match_stats || {};
  const hg = r.home_goals ?? 0;
  const ag = r.away_goals ?? 0;
  const tc = (s.corners_home || 0) + (s.corners_away || 0);
  const yc = (s.yellow_cards_home || 0) + (s.yellow_cards_away || 0);

  return {
    'Over 1.5':          hg + ag > 1,
    'BTTS':              hg >= 1 && ag >= 1,
    'Over 2.5':          hg + ag > 2,
    'Over 3.5':          hg + ag > 3,
    'Over Corners 6.5':  tc > 6,
    'Over Corners 7.5':  tc > 7,
    'YC 2.5':            yc > 2,
    'YC 3.5':            yc > 3,
  };
}

// ── Extrai sinais confirmadores por mercado ───────────────────────────────────
// Cada mercado tem sua lista de sinais que "apontam para o resultado".
// Mais sinais ativos = maior confiança no disparo.
function extractMarketSignals(match) {
  const s   = match.match_stats || {};
  const ht  = match.ht_score    || null;
  const comp = (match.competition || '').toLowerCase();

  const totalShots   = (s.shots_home || 0) + (s.shots_away || 0);
  const totalSOG     = (s.shots_on_goal_home || 0) + (s.shots_on_goal_away || 0);
  const totalCorners = (s.corners_home || 0) + (s.corners_away || 0);
  const totalYC      = (s.yellow_cards_home || 0) + (s.yellow_cards_away || 0);
  const totalFouls   = (s.fouls_home || 0) + (s.fouls_away || 0);
  const possDiff     = Math.abs((s.possession_home || 50) - 50);
  const sogRatio     = totalShots > 0 ? totalSOG / totalShots : 0;
  const isPremium    = PREMIUM_LEAGUES.has(match.competition);
  const htTotal      = ht ? (ht.home || 0) + (ht.away || 0) : -1;

  // Over 1.5 — sinais que indicam jogo goleado
  const over15 = [
    totalShots >= 22,             // muitos chutes
    totalSOG >= 8,                // muitos chutes no alvo
    sogRatio >= 0.38,             // alta taxa conversão
    isPremium,                    // liga de alta produção
    possDiff <= 6,                // jogo equilibrado (mais gols)
    htTotal >= 1,                 // já marcou no 1T
    totalCorners >= 10,           // pressão ofensiva
    comp.includes('bundesliga'),  // liga mais goleada
  ].filter(Boolean).length;

  // BTTS — ambos marcam
  const btts = [
    totalShots >= 18,
    totalSOG >= 6,
    possDiff <= 8,                // posse equilibrada = ambos atacam
    htTotal >= 1,
    isPremium,
    sogRatio >= 0.35,
    !(comp.includes('serie a') || comp.includes('brasileir')), // penalidade defensiva
    totalCorners >= 9,
  ].filter(Boolean).length;

  // Over 2.5 — mais de 2 gols
  const over25 = [
    totalShots >= 25,
    totalSOG >= 9,
    sogRatio >= 0.40,
    htTotal >= 2,
    totalCorners >= 11,
    possDiff <= 5,
    isPremium,
    comp.includes('bundesliga') || comp.includes('premier'),
  ].filter(Boolean).length;

  // Over 3.5 — goleada
  const over35 = [
    totalShots >= 30,
    totalSOG >= 11,
    sogRatio >= 0.42,
    htTotal >= 2,
    totalCorners >= 13,
    possDiff <= 4,
    comp.includes('bundesliga'),
  ].filter(Boolean).length;

  // Over Corners 6.5
  const corners65 = [
    totalShots >= 22,
    possDiff <= 8,
    isPremium,
    totalSOG >= 7,
    comp.includes('premier') || comp.includes('bundesliga'),
    totalFouls >= 22,            // jogo frenético = mais escanteios
    sogRatio <= 0.45,            // chutes bloqueados viram escanteio
  ].filter(Boolean).length;

  // Over Corners 7.5
  const corners75 = [
    totalShots >= 26,
    possDiff <= 6,
    isPremium,
    totalSOG >= 9,
    totalFouls >= 24,
    sogRatio <= 0.42,
  ].filter(Boolean).length;

  // YC 2.5 — mais de 2 cartões amarelos
  const yc25 = [
    totalFouls >= 26,
    totalYC >= 3,                // já tem 3 = meta atingida (sinal pós-jogo)
    possDiff >= 10,              // desequilíbrio = mais faltas
    !isPremium,                  // ligas menos técnicas = mais YC
    comp.includes('brasileir') || comp.includes('argentina') || comp.includes('colombia'),
    (s.yellow_cards_home || 0) >= 2,
    (s.yellow_cards_away || 0) >= 2,
  ].filter(Boolean).length;

  // YC 3.5 — mais de 3 cartões
  const yc35 = [
    totalFouls >= 30,
    totalYC >= 4,
    possDiff >= 12,
    !isPremium,
    comp.includes('brasileir') || comp.includes('argentina'),
    (s.yellow_cards_home || 0) >= 2 && (s.yellow_cards_away || 0) >= 2,
  ].filter(Boolean).length;

  return {
    'Over 1.5': over15,
    'BTTS':     btts,
    'Over 2.5': over25,
    'Over 3.5': over35,
    'Over Corners 6.5': corners65,
    'Over Corners 7.5': corners75,
    'YC 2.5':   yc25,
    'YC 3.5':   yc35,
  };
}

// ── Análise por banda: precisão por mercado por banda de sinal ────────────────
function analyzeBands(matches) {
  // market → band → { total, hits, abstentions }
  const stats = {};
  for (const market of Object.keys(MARKET_TARGETS)) {
    stats[market] = {};
    for (const band of BANDS) {
      stats[market][band.label] = { total: 0, hits: 0 };
    }
    stats[market]['TOTAL'] = { total: 0, hits: 0 };
  }

  for (const match of matches) {
    const outcomes = evalMarkets(match);
    const signals  = extractMarketSignals(match);

    for (const [market, hit] of Object.entries(outcomes)) {
      if (!(market in MARKET_TARGETS)) continue;
      const sigCount = signals[market] || 0;
      const band     = getBand(sigCount);

      stats[market][band.label].total++;
      if (hit) stats[market][band.label].hits++;
      stats[market]['TOTAL'].total++;
      if (hit) stats[market]['TOTAL'].hits++;
    }
  }

  return stats;
}

// ── Determina o threshold sniper (banda mínima para atingir a meta) ───────────
function computeSniperThresholds(bandStats) {
  const thresholds = {};

  for (const [market, target] of Object.entries(MARKET_TARGETS)) {
    const mStats = bandStats[market];

    // Testa cada banda acumulada (HOT+ELITE, só ELITE)
    let sniperBand = null;
    let sniperAcc  = null;

    // Testa da banda mais restritiva para mais permissiva
    for (let start = BANDS.length - 1; start >= 0; start--) {
      let total = 0, hits = 0;
      for (let i = start; i < BANDS.length; i++) {
        total += mStats[BANDS[i].label].total;
        hits  += mStats[BANDS[i].label].hits;
      }
      if (total >= 10) {
        const acc = Math.round((hits / total) * 100);
        if (acc >= target) {
          sniperBand = BANDS[start].label;
          sniperAcc  = acc;
        }
      }
    }

    // Se nenhuma banda atinge a meta, usa HOT (5+ sinais) como padrão
    if (!sniperBand) {
      sniperBand = 'HOT';
      const hd = mStats['HOT'];
      const ed = mStats['ELITE'];
      const t  = hd.total + ed.total;
      const h  = hd.hits  + ed.hits;
      sniperAcc = t > 0 ? Math.round((h / t) * 100) : null;
    }

    const bandDef = BANDS.find(b => b.label === sniperBand);
    thresholds[market] = {
      band:          sniperBand,
      minSignals:    bandDef?.min || 5,
      achievedAcc:   sniperAcc,
      target,
      gap:           sniperAcc != null ? target - sniperAcc : null,
    };
  }

  return thresholds;
}

// ── Relatório militar ─────────────────────────────────────────────────────────
function printMilitaryReport(bandStats, thresholds, totalMatches) {
  const DIVIDER = '═'.repeat(70);
  const LINE    = '─'.repeat(70);

  console.log(chalk.bold.red('\n' + DIVIDER));
  console.log(chalk.bold.red('  ██████  PROTOCOLO SNIPER — AVALIAÇÃO DE PRECISÃO  ██████'));
  console.log(chalk.bold.red('  "One Shot, One Kill" — Apenas disparos confirmados'));
  console.log(chalk.bold.red(DIVIDER));
  console.log(chalk.gray(`  Total de jogos analisados: ${totalMatches}`));
  console.log(chalk.gray(`  Bandas: COLD(1-2 sinais) | WARM(3-4) | HOT(5-6) | ELITE(7+)\n`));

  let totalShots = 0, totalHits = 0, totalAbstained = 0;

  for (const [market, target] of Object.entries(MARKET_TARGETS)) {
    const mStats = bandStats[market];
    const thresh = thresholds[market];

    console.log(chalk.bold.yellow(`\n  🎯 MERCADO: ${market.toUpperCase()} (meta: ${target}%)`));
    console.log(chalk.gray('  ' + LINE));

    for (const band of BANDS) {
      const d   = mStats[band.label];
      const acc = d.total > 0 ? Math.round((d.hits / d.total) * 100) : null;
      const isSniper = band.label === thresh.band || BANDS.indexOf(band) >= BANDS.findIndex(b => b.label === thresh.band);

      let indicator = '  ';
      if (acc === null) {
        console.log(chalk[band.color]?.(`  ${isSniper ? '🔫' : '⏸️ '} ${band.label.padEnd(5)}  — amostras insuficientes`) ?? '');
        continue;
      }

      const accStr  = String(acc).padStart(3);
      const sampStr = `(${d.total} shots)`.padEnd(12);
      const hitStr  = `${d.hits} GREEN`.padEnd(12);
      const missStr = `${d.total - d.hits} RED`;

      const accColor = acc >= target ? 'green' : acc >= target - 10 ? 'yellow' : 'red';
      const icon = isSniper ? '🔫' : '⏸️ ';
      const label = isSniper ? 'AUTORIZADO' : 'BLOQUEADO ';

      if (isSniper) {
        totalShots  += d.total;
        totalHits   += d.hits;
      } else {
        totalAbstained += d.total;
      }

      const line = `  ${icon} ${band.label.padEnd(5)} | ${label} | Precisão: ${accStr}%  ${sampStr} ${hitStr} ${missStr}`;
      console.log(chalk[accColor]?.(line) ?? line);
    }

    // Resumo do threshold
    const thAcc = thresh.achievedAcc != null ? `${thresh.achievedAcc}%` : 'N/A';
    const thGap = thresh.gap != null
      ? (thresh.gap <= 0 ? chalk.green(`META ATINGIDA (+${Math.abs(thresh.gap)}pp)`) : chalk.red(`gap: ${thresh.gap}pp`))
      : chalk.gray('sem dados');
    console.log(chalk.cyan(`\n  ⚡ THRESHOLD SNIPER: ${thresh.band} (≥${thresh.minSignals} sinais) → ${thAcc}  ${thGap}`));
  }

  // Resumo geral — estilo debriefing
  console.log(chalk.bold.red('\n' + DIVIDER));
  console.log(chalk.bold.red('  DEBRIEFING — RESUMO DA SESSÃO DE TREINAMENTO'));
  console.log(chalk.bold.red(DIVIDER));

  const overallAcc = totalShots > 0 ? Math.round((totalHits / totalShots) * 100) : 0;
  const abstainRate = totalMatches > 0 ? Math.round((totalAbstained / (totalShots + totalAbstained)) * 100) : 0;

  console.log(chalk.white(`  Total de disparos (bandas autorizadas): ${totalShots}`));
  console.log(chalk.green(`  Acertos (GREEN):                        ${totalHits}`));
  console.log(chalk.red(`  Erros   (RED):                          ${totalShots - totalHits}`));
  console.log(chalk.cyan(`  Precisão global (disparos autorizados): ${overallAcc}%`));
  console.log(chalk.gray(`  Abstençoes (sinais insuficientes):      ${totalAbstained}  (${abstainRate}% dos jogos)`));
  console.log(chalk.bold.yellow(`\n  Disciplina: ${abstainRate}% dos jogos REJEITADOS por falta de confirmação.`));
  console.log(chalk.bold.yellow(`  Isso NÃO é fraqueza — é precisão sniper.\n`));

  const marketsOnTarget = Object.values(thresholds).filter(t => t.gap != null && t.gap <= 0).length;
  console.log(chalk.bold.cyan(`  Mercados na meta: ${marketsOnTarget}/${Object.keys(MARKET_TARGETS).length}`));
  console.log(chalk.bold.red(DIVIDER + '\n'));

  return { totalShots, totalHits, totalAbstained, overallAcc, abstainRate, marketsOnTarget };
}

// ── Persiste thresholds no PIE ────────────────────────────────────────────────
function saveThresholdsToPIE(thresholds) {
  try {
    const pie = existsSync(PIE_PATH)
      ? JSON.parse(readFileSync(PIE_PATH, 'utf-8'))
      : {};

    pie.sniper_thresholds = {
      updatedAt: new Date().toISOString(),
      thresholds,
    };

    writeFileSync(PIE_PATH, JSON.stringify(pie, null, 2));
    log('💾', 'Sniper thresholds salvos em data/pie.json', 'green');
  } catch (e) {
    log('⚠️', `Falha ao salvar thresholds: ${e.message}`, 'yellow');
  }
}

// ── Persiste relatório no log ─────────────────────────────────────────────────
function saveReport(summary, thresholds) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...summary,
      thresholds,
    });
    writeFileSync(SNIPER_LOG, line + '\n', { flag: 'a' });
  } catch { /* não crítico */ }
}

// ── Exibe último relatório salvo ──────────────────────────────────────────────
function showLastReport() {
  if (!existsSync(SNIPER_LOG)) {
    log('⚠️', 'Nenhum relatório sniper encontrado. Execute sem --report primeiro.', 'yellow');
    return;
  }
  const lines = readFileSync(SNIPER_LOG, 'utf-8').trim().split('\n');
  const last  = JSON.parse(lines[lines.length - 1]);
  console.log(chalk.bold.cyan('\n  Último relatório sniper:'));
  console.log(JSON.stringify(last, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(chalk.bold.red('\n' + '═'.repeat(70)));
  console.log(chalk.bold.red('  🎯 SNIPER PROTOCOL — INICIANDO AVALIAÇÃO DE PRECISÃO'));
  console.log(chalk.bold.red('═'.repeat(70) + '\n'));

  if (RPT_ONLY) {
    showLastReport();
    return;
  }

  log('📂', 'Carregando histórico de partidas...', 'cyan');
  const matches = loadAllMatches();

  if (matches.length < 20) {
    log('⚠️', `Apenas ${matches.length} partidas disponíveis — mínimo 20 para análise confiável`, 'yellow');
    if (matches.length === 0) {
      log('❌', 'Nenhuma partida com resultado encontrada. Execute historical-backfill.js primeiro.', 'red');
      process.exit(0);
    }
  }

  log('🔍', `${matches.length} partidas carregadas — iniciando análise de precisão por banda...`, 'cyan');

  const bandStats  = analyzeBands(matches);
  const thresholds = computeSniperThresholds(bandStats);
  const summary    = printMilitaryReport(bandStats, thresholds, matches.length);

  if (!DRY_RUN) {
    saveThresholdsToPIE(thresholds);
    saveReport(summary, thresholds);

    // Sincroniza com Obsidian em tempo real
    if (isObsidianConfigured()) {
      const obsResult = updateSniperProtocol({
        thresholds,
        totalMatches: matches.length,
        ...summary,
      });
      log(obsResult ? '📓' : '⚠️',
        obsResult ? `Obsidian atualizado → 🎯 Protocolo Sniper.md` : 'Obsidian: falha ao sincronizar',
        obsResult ? 'green' : 'yellow');
    }
  } else {
    log('🔍', 'DRY-RUN: nenhum dado salvo.', 'gray');
  }

  log('✅', 'Protocolo Sniper concluído.', 'green');
}

main().catch(e => {
  console.error(chalk.red(`\n[SNIPER PROTOCOL] ERRO CRÍTICO: ${e.message}`));
  process.exit(1);
});
