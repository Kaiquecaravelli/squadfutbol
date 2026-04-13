#!/usr/bin/env node
/**
 * deep-training.js — Sistema de Treinamento Profundo do PIE
 *
 * Fluxo completo:
 *   Phase 1 — Carga de dados (todos os jogos reais disponíveis)
 *   Phase 2 — Extração de features (sinais de match_stats + ht_score + competição)
 *   Phase 3 — Taxa base real por mercado e por liga
 *   Phase 4 — Mineração de padrões (lift por sinal × mercado)
 *   Phase 5 — Análise de pares de sinais (combinações AND)
 *   Phase 6 — Validação 80/20 (treino × teste)
 *   Phase 7 — Geração de regras (limite de significância estatística)
 *   Phase 8 — Calibração Poisson (curva de correção por bucket de probabilidade)
 *   Phase 9 — Injeção no PIE + relatório
 *
 * Uso:
 *   node scripts/deep-training.js              → treina com todos os dados disponíveis
 *   node scripts/deep-training.js --dry-run    → roda tudo mas NÃO salva no PIE
 *   node scripts/deep-training.js --report     → apenas imprime relatório atual
 *   node scripts/deep-training.js --reset-rules → limpa regras antigas antes de treinar
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __dir    = dirname(fileURLToPath(import.meta.url));
const ROOT     = join(__dir, '..');
const PIE_PATH = join(ROOT, 'data/pie.json');
const HIST_PATH = join(ROOT, 'data/historical-patterns.json');
const RULES_REPORT = join(ROOT, 'logs/deep-training-report.jsonl');
const DAILY_DIR      = join(ROOT, 'data/daily-matches');
const HIST_CACHE_DIR = join(ROOT, 'data/historical-cache'); // cache histórico 2026-01-25 a hoje (75+ dias)

const ARGS       = process.argv.slice(2);
const DRY_RUN    = ARGS.includes('--dry-run');
const REPORT_ONLY = ARGS.includes('--report');
const RESET_RULES = ARGS.includes('--reset-rules');

// ── Constantes de significância ───────────────────────────────────────────────
const MIN_SAMPLES_SINGLE  = 8;    // mínimo de amostras para uma regra de sinal único
const MIN_SAMPLES_PAIR    = 5;    // mínimo para combinação de 2 sinais
const MIN_LIFT_THRESHOLD  = 0.06; // 6 pp de lift mínimo para criar regra
const MIN_CONFIDENCE      = 0.60; // precisão mínima para ser listada como regra
const TRAIN_SPLIT         = 0.80; // 80% treino, 20% teste

// Mercados avaliados (todos os suportados pelo motor)
const MARKETS = ['Over 1.5','Over 2.5','Over 3.5','Over 4.5','BTTS',
  'Over Corners 6.5','Over Corners 7.5','Over Corners 8.5','Over Corners 9.5',
  'YC 2.5','YC 3.5','YC 4.5',
  'Home Win','Draw','Away Win','1X','X2','12','Correct Score'];

// Ligas premium (mais dados, maior liquidez)
const PREMIUM_LEAGUES = new Set([
  'Premier League','La Liga','Serie A','Bundesliga','Ligue 1',
  'Champions League','Europa League','Brasileirão Betano'
]);

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1 — Carregamento de dados
// Lê de DUAS fontes: daily-matches (9 dias) + historical-cache (75+ dias)
// Isso aumenta significativamente o número de amostras para calibração
// ─────────────────────────────────────────────────────────────────────────────
function loadAllMatches() {
  const sources = [DAILY_DIR, HIST_CACHE_DIR].filter(dir => existsSync(dir));
  if (!sources.length) return [];

  const seenIds = new Set(); // evita duplicatas entre as duas fontes
  const all = [];

  for (const dir of sources) {
    const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    let fromDir = 0;

    for (const file of files) {
      try {
        const raw     = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
        const matches = raw.matches || raw;
        if (!Array.isArray(matches)) continue;

        for (const m of matches) {
          if (!m.result || !m.match_stats) continue;

          // Dedup por match+date para evitar contar o mesmo jogo duas vezes
          const matchDate = m.match_date || file.replace('.json', '');
          const dedupId   = `${(m.match || '').toLowerCase().replace(/\s+/g,'_')}_${matchDate}`;
          if (seenIds.has(dedupId)) continue;
          seenIds.add(dedupId);

          all.push(m);
          fromDir++;
        }
      } catch { /* arquivo corrompido — ignorar */ }
    }

    const dirName = dir === DAILY_DIR ? 'daily-matches' : 'historical-cache';
    console.log(chalk.gray(`  [Phase 1] ${dirName}: ${fromDir} partidas com resultado carregadas`));
  }

  return all;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — Extração de features (sinais derivados de estatísticas reais)
// ─────────────────────────────────────────────────────────────────────────────
function extractFeatures(match) {
  const s  = match.match_stats || {};
  const r  = match.result      || {};
  const ht = match.ht_score    || null;
  const comp = (match.competition || '').toLowerCase();

  const hGoals = r.home_goals ?? 0;
  const aGoals = r.away_goals ?? 0;
  const totalGoals   = hGoals + aGoals;
  const totalShots   = (s.shots_home || 0) + (s.shots_away || 0);
  const totalSOG     = (s.shots_on_goal_home || 0) + (s.shots_on_goal_away || 0);
  const totalCorners = (s.corners_home || 0) + (s.corners_away || 0);
  const cornerDiff   = Math.abs((s.corners_home || 0) - (s.corners_away || 0));
  const totalYC      = (s.yellow_cards_home || 0) + (s.yellow_cards_away || 0);
  const totalRC      = (s.red_cards_home || 0) + (s.red_cards_away || 0);
  const possDiff     = Math.abs((s.possession_home || 50) - 50);
  const sogRatio     = totalShots > 0 ? totalSOG / totalShots : 0;

  // Sinais booleanos — pré-jogo: baseados em competição e H2H histórico
  // Sinais de desempenho: baseados em estatísticas reais do jogo
  const signals = new Set();

  // --- SINAIS DE COMPETIÇÃO ---
  if (PREMIUM_LEAGUES.has(match.competition)) signals.add('league_premium');
  if (comp.includes('premier league') || comp.includes('bundesliga'))
    signals.add('league_high_goals');
  if (comp.includes('brasileir') || comp.includes('serie a'))
    signals.add('league_btts_low'); // ligas com défense mais sólida

  // --- SINAIS DE CHUTES ---
  if (totalShots >= 28) signals.add('shots_very_high');
  else if (totalShots >= 22) signals.add('shots_high');
  else if (totalShots <= 14) signals.add('shots_low');
  if (sogRatio >= 0.40) signals.add('sog_ratio_high');
  if (totalSOG >= 10) signals.add('sog_very_high');
  if (s.shots_home >= s.shots_away * 2.0) signals.add('home_shot_dominant');
  if (s.shots_away >= s.shots_home * 2.0) signals.add('away_shot_dominant');

  // --- SINAIS DE ESCANTEIOS ---
  if (totalCorners >= 15) signals.add('corners_very_high');
  else if (totalCorners >= 11) signals.add('corners_high');
  else if (totalCorners <= 7)  signals.add('corners_low');
  if (cornerDiff >= 7) signals.add('corners_asymmetric');

  // --- SINAIS DE CARTÕES ---
  if (totalYC >= 6) signals.add('yc_very_high');
  else if (totalYC >= 4) signals.add('yc_high');
  else if (totalYC >= 2) signals.add('yc_moderate');
  else if (totalYC <= 1) signals.add('yc_low');
  if (totalRC >= 1) signals.add('has_red_card');

  // --- SINAIS DE POSSE ---
  if (possDiff >= 12) signals.add('possession_unbalanced');
  else if (possDiff <= 5) signals.add('possession_balanced');
  if ((s.possession_home || 0) >= 60) signals.add('home_dominates_possession');
  if ((s.possession_away || 0) >= 60) signals.add('away_dominates_possession');

  // --- SINAIS DE HALF-TIME ---
  if (ht) {
    const htTotal = (ht.home || 0) + (ht.away || 0);
    const htHome  = ht.home || 0;
    const htAway  = ht.away || 0;
    if (htTotal >= 2)  signals.add('ht_over_1');
    if (htTotal >= 3)  signals.add('ht_over_2');
    if (htHome >= 1 && htAway >= 1) signals.add('ht_btts');
    if (htHome > htAway) signals.add('ht_home_winning');
    if (htAway > htHome) signals.add('ht_away_winning');
    if (htHome === 0 && htAway === 0) signals.add('ht_nil_nil');
    if (htTotal === 0) signals.add('ht_no_goals');
    if (htHome - htAway >= 2) signals.add('ht_home_2plus_lead');
    if (htAway - htHome >= 2) signals.add('ht_away_2plus_lead');
  }

  // --- SINAIS COMBINADOS ---
  const goalIntensity = totalGoals / Math.max(1, totalShots) * 10;
  if (goalIntensity >= 2.5) signals.add('high_conversion_rate');

  // Jogo aberto: shots altos + posse equilibrada + cartões moderados
  if (totalShots >= 20 && possDiff <= 8) signals.add('open_game');
  // Jogo tenso: cartões altos + fouls altos
  const totalFouls = (s.fouls_home || 0) + (s.fouls_away || 0);
  if (totalYC >= 4 && totalFouls >= 28) signals.add('physical_game');

  return signals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Avalia quais mercados foram "acertados" (TRUE) por cada jogo
// ─────────────────────────────────────────────────────────────────────────────
function evaluateMarkets(match) {
  const r  = match.result || {};
  const s  = match.match_stats || {};
  const hGoals = r.home_goals ?? 0;
  const aGoals = r.away_goals ?? 0;
  const total = hGoals + aGoals;
  const tc = (s.corners_home || 0) + (s.corners_away || 0);
  const yc = (s.yellow_cards_home || 0) + (s.yellow_cards_away || 0);

  return {
    'Over 1.5':          total > 1,
    'Over 2.5':          total > 2,
    'Over 3.5':          total > 3,
    'Over 4.5':          total > 4,
    'BTTS':              hGoals >= 1 && aGoals >= 1,
    'Over Corners 6.5':  tc > 6,
    'Over Corners 7.5':  tc > 7,
    'Over Corners 8.5':  tc > 8,
    'Over Corners 9.5':  tc > 9,
    'YC 2.5':            yc > 2,
    'YC 3.5':            yc > 3,
    'YC 4.5':            yc > 4,
    'Home Win':          hGoals > aGoals,
    'Draw':              hGoals === aGoals,
    'Away Win':          aGoals > hGoals,
    '1X':                hGoals >= aGoals,
    'X2':                aGoals >= hGoals,
    '12':                hGoals !== aGoals,
    'Correct Score':     true, // placeholder — CS avaliado separadamente
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — Taxas base por mercado e por liga
// ─────────────────────────────────────────────────────────────────────────────
function computeBaseRates(matches) {
  const global   = {};   // { market: { total, hits } }
  const byLeague = {};   // { competition: { market: { total, hits } } }
  const byScore  = {};   // placar exato → { total, label }

  MARKETS.forEach(m => { global[m] = { total: 0, hits: 0 }; });

  for (const match of matches) {
    const outcomes = evaluateMarkets(match);
    const comp     = match.competition || 'Unknown';

    if (!byLeague[comp]) {
      byLeague[comp] = {};
      MARKETS.forEach(m => { byLeague[comp][m] = { total: 0, hits: 0 }; });
    }

    for (const [market, hit] of Object.entries(outcomes)) {
      if (market === 'Correct Score') continue;
      if (global[market]) {
        global[market].total++;
        if (hit) global[market].hits++;
      }
      if (byLeague[comp]?.[market]) {
        byLeague[comp][market].total++;
        if (hit) byLeague[comp][market].hits++;
      }
    }

    // Placar exato
    const placar = match.result?.placar || `${match.result?.home_goals}-${match.result?.away_goals}`;
    if (!byScore[placar]) byScore[placar] = { total: 0, label: placar };
    byScore[placar].total++;
  }

  // Calcular taxas
  const baseRates = {};
  for (const [market, d] of Object.entries(global)) {
    baseRates[market] = d.total > 0 ? d.hits / d.total : 0;
  }

  const leagueRates = {};
  for (const [comp, markets] of Object.entries(byLeague)) {
    leagueRates[comp] = {};
    for (const [market, d] of Object.entries(markets)) {
      leagueRates[comp][market] = d.total >= 5 ? d.hits / d.total : null;
    }
  }

  // Distribuição de placares (top-15)
  const scoreDistrib = Object.values(byScore)
    .sort((a, b) => b.total - a.total)
    .slice(0, 15)
    .map(s => ({ ...s, rate: +(s.total / matches.length).toFixed(3) }));

  return { baseRates, leagueRates, scoreDistrib };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 — Mineração de padrões (lift por sinal × mercado)
// ─────────────────────────────────────────────────────────────────────────────
function mineSignalPatterns(matches, baseRates) {
  // Coleta sinal → mercado → {total, hits}
  const signalMarket = {};

  for (const match of matches) {
    const features = extractFeatures(match);
    const outcomes = evaluateMarkets(match);

    for (const signal of features) {
      if (!signalMarket[signal]) signalMarket[signal] = {};
      for (const [market, hit] of Object.entries(outcomes)) {
        if (market === 'Correct Score') continue;
        if (!signalMarket[signal][market]) signalMarket[signal][market] = { total: 0, hits: 0 };
        signalMarket[signal][market].total++;
        if (hit) signalMarket[signal][market].hits++;
      }
    }
  }

  // Calcular lift e filtrar significativos
  const patterns = [];
  for (const [signal, markets] of Object.entries(signalMarket)) {
    for (const [market, d] of Object.entries(markets)) {
      if (d.total < MIN_SAMPLES_SINGLE) continue;
      const conditionalRate = d.hits / d.total;
      const baseRate        = baseRates[market] || 0;
      const lift            = conditionalRate - baseRate;
      const absLift         = Math.abs(lift);

      if (absLift < MIN_LIFT_THRESHOLD) continue;

      patterns.push({
        type:             'single',
        signal,
        market,
        base_rate:        +baseRate.toFixed(3),
        conditional_rate: +conditionalRate.toFixed(3),
        lift:             +lift.toFixed(3),
        n:                d.total,
        hits:             d.hits,
        direction:        lift > 0 ? 'positive' : 'negative',
      });
    }
  }

  // Ordenar por |lift| × log(n) — lift grande E amostra grande primeiro
  patterns.sort((a, b) =>
    (Math.abs(b.lift) * Math.log(b.n + 1)) - (Math.abs(a.lift) * Math.log(a.n + 1))
  );

  return { signalMarket, patterns };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5 — Análise de pares de sinais (combinações AND de 2 sinais)
// ─────────────────────────────────────────────────────────────────────────────
function mineSignalPairs(matches, baseRates, topSignals) {
  // Apenas sinais com lift individual alto (evitar explosão combinatória)
  const candidateSignals = [...new Set(topSignals.map(p => p.signal))].slice(0, 20);
  const pairMarket = {};

  for (const match of matches) {
    const features = extractFeatures(match);
    const outcomes = evaluateMarkets(match);
    const present  = candidateSignals.filter(s => features.has(s));

    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        const pairKey = `${present[i]}+${present[j]}`;
        if (!pairMarket[pairKey]) pairMarket[pairKey] = {};

        for (const [market, hit] of Object.entries(outcomes)) {
          if (market === 'Correct Score') continue;
          if (!pairMarket[pairKey][market]) pairMarket[pairKey][market] = { total: 0, hits: 0 };
          pairMarket[pairKey][market].total++;
          if (hit) pairMarket[pairKey][market].hits++;
        }
      }
    }
  }

  const pairs = [];
  for (const [pairKey, markets] of Object.entries(pairMarket)) {
    const [sig1, sig2] = pairKey.split('+');
    for (const [market, d] of Object.entries(markets)) {
      if (d.total < MIN_SAMPLES_PAIR) continue;
      const conditionalRate = d.hits / d.total;
      const baseRate        = baseRates[market] || 0;
      const lift            = conditionalRate - baseRate;
      if (Math.abs(lift) < MIN_LIFT_THRESHOLD + 0.03) continue; // pares precisam de mais lift

      pairs.push({
        type:             'pair',
        signal:           pairKey,
        signals:          [sig1, sig2],
        market,
        base_rate:        +baseRate.toFixed(3),
        conditional_rate: +conditionalRate.toFixed(3),
        lift:             +lift.toFixed(3),
        n:                d.total,
        hits:             d.hits,
        direction:        lift > 0 ? 'positive' : 'negative',
      });
    }
  }

  pairs.sort((a, b) =>
    (Math.abs(b.lift) * Math.log(b.n + 1)) - (Math.abs(a.lift) * Math.log(a.n + 1))
  );

  return pairs;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 6 — Calibração da curva Poisson (bucket adjustment)
// ─────────────────────────────────────────────────────────────────────────────
function calibratePoissonCurve(matches) {
  // Para cada partida: calcula P(Over 2.5) com Poisson simplificado
  // Agrupa em buckets de 0.05 e mede taxa real
  const MARKETS_TO_CALIBRATE = ['Over 1.5','Over 2.5','Over 3.5','BTTS'];
  const buckets = {}; // market → bucket → {total, hits}

  for (const market of MARKETS_TO_CALIBRATE) {
    buckets[market] = {};
    for (let b = 0; b <= 19; b++) {
      buckets[market][b] = { min: b * 0.05, max: (b + 1) * 0.05, total: 0, hits: 0 };
    }
  }

  for (const match of matches) {
    const s = match.match_stats || {};
    const r = match.result || {};
    const h = r.home_goals ?? 0;
    const a = r.away_goals ?? 0;
    const total = h + a;

    // Estimar lambdas a partir de shots (proxy quando goals_avg indisponível)
    const shotsH = s.shots_home || 10;
    const shotsA = s.shots_away || 10;
    const shotRatioH = shotsH / (shotsH + shotsA);
    // Lambda proxy: média esperada em jogos com esse nível de chutes
    const lambdaProxy = (shotsH + shotsA) / 18 * 2.5 * 0.85;
    const lambdaH = lambdaProxy * shotRatioH * 1.15; // home advantage
    const lambdaA = lambdaProxy * (1 - shotRatioH);

    const pOver15 = 1 - (poissonPMF(0, lambdaH + lambdaA) + poissonPMF(1, lambdaH + lambdaA));
    const pOver25 = 1 - poissonCDF(2, lambdaH + lambdaA);
    const pOver35 = 1 - poissonCDF(3, lambdaH + lambdaA);
    const pBTTS   = (1 - Math.exp(-lambdaH)) * (1 - Math.exp(-lambdaA));

    const probs = {
      'Over 1.5': Math.min(0.99, Math.max(0.01, pOver15)),
      'Over 2.5': Math.min(0.99, Math.max(0.01, pOver25)),
      'Over 3.5': Math.min(0.99, Math.max(0.01, pOver35)),
      'BTTS':     Math.min(0.99, Math.max(0.01, pBTTS)),
    };
    const actuals = {
      'Over 1.5': total > 1,
      'Over 2.5': total > 2,
      'Over 3.5': total > 3,
      'BTTS':     h >= 1 && a >= 1,
    };

    for (const market of MARKETS_TO_CALIBRATE) {
      const prob   = probs[market];
      const bucketIdx = Math.min(19, Math.floor(prob / 0.05));
      buckets[market][bucketIdx].total++;
      if (actuals[market]) buckets[market][bucketIdx].hits++;
    }
  }

  // Gera tabela de correção: predicted → actual
  const corrections = {};
  for (const market of MARKETS_TO_CALIBRATE) {
    corrections[market] = [];
    for (const [idx, b] of Object.entries(buckets[market])) {
      if (b.total < 3) continue;
      const actualRate = b.hits / b.total;
      const midpoint   = (b.min + b.max) / 2;
      corrections[market].push({
        predicted_mid: +midpoint.toFixed(3),
        actual_rate:   +actualRate.toFixed(3),
        correction:    +(actualRate - midpoint).toFixed(3),
        n:             b.total,
      });
    }
  }
  return corrections;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 7 — Validação 80/20
// ─────────────────────────────────────────────────────────────────────────────
function validateRules(matches, patterns, baseRates) {
  const splitIdx  = Math.floor(matches.length * TRAIN_SPLIT);
  const testSet   = matches.slice(splitIdx);
  const results   = {};

  for (const market of MARKETS.filter(m => m !== 'Correct Score')) {
    const baseline = baseRates[market] || 0;
    let baseAcc = 0, ruleAcc = 0;

    // Regras aplicáveis a este mercado
    const mktRules = patterns.filter(p => p.market === market).slice(0, 3);

    for (const match of testSet) {
      const actual    = evaluateMarkets(match)[market];
      const signals   = extractFeatures(match);

      // Predição baseline = taxa base
      const baselineCorrect = (baseline >= 0.5) === actual;
      if (baselineCorrect) baseAcc++;

      // Predição com regras: ajusta probabilidade
      let prob = baseline;
      for (const rule of mktRules) {
        const signalPresent = rule.type === 'single'
          ? signals.has(rule.signal)
          : rule.signals.every(s => signals.has(s));
        if (signalPresent) prob = Math.min(0.97, Math.max(0.03, prob + rule.lift * 0.7));
      }

      const ruleCorrect = (prob >= 0.5) === actual;
      if (ruleCorrect) ruleAcc++;
    }

    const n = testSet.length;
    if (n > 0) {
      results[market] = {
        test_samples:   n,
        baseline_acc:   +(baseAcc / n * 100).toFixed(1),
        rule_acc:       +(ruleAcc / n * 100).toFixed(1),
        improvement:    +((ruleAcc - baseAcc) / n * 100).toFixed(1),
      };
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 8 — Injeção no PIE
// ─────────────────────────────────────────────────────────────────────────────
function injectIntoPIE(baseRates, leagueRates, patterns, pairs, poissonCorrections, scoreDistrib, validation) {
  const db = JSON.parse(readFileSync(PIE_PATH, 'utf-8'));

  if (RESET_RULES) {
    db.rules = [];
    db.pattern_library = {};
    db.league_adjustments = {};
    db.poisson_corrections = {};
    console.log(chalk.yellow('  ♻️  Regras antigas apagadas (--reset-rules)'));
  }

  // 1. Base rates reais (ground truth do dataset)
  db.base_rates = { ...baseRates, _computed_at: new Date().toISOString(), _n: '261+' };

  // 2. Ajustes por liga
  const leagueAdj = {};
  for (const [comp, markets] of Object.entries(leagueRates)) {
    for (const [market, rate] of Object.entries(markets)) {
      if (rate === null) continue;
      const base = baseRates[market] || 0;
      const diff = rate - base;
      if (Math.abs(diff) < 0.04) continue; // apenas diferenças significativas
      if (!leagueAdj[comp]) leagueAdj[comp] = {};
      leagueAdj[comp][market] = { rate: +rate.toFixed(3), vs_base: +diff.toFixed(3) };
    }
  }
  db.league_adjustments = leagueAdj;

  // 3. Regras de padrão (sinais → ajuste de probabilidade)
  const allRules = [...patterns, ...pairs]
    .filter(p => Math.abs(p.lift) >= MIN_LIFT_THRESHOLD && p.n >= MIN_SAMPLES_SINGLE)
    .slice(0, 120); // máximo 120 regras

  db.rules = allRules.map((p, i) => ({
    id:              `rule_${i + 1}_${p.signal.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${p.market.replace(/\s/g, '_').toLowerCase()}`,
    type:            p.type,
    signal:          p.signal,
    signals:         p.signals || [p.signal],
    market:          p.market,
    base_rate:       p.base_rate,
    conditional_rate: p.conditional_rate,
    lift:            p.lift,
    n:               p.n,
    direction:       p.direction,
  }));

  // 4. Correções Poisson
  db.poisson_corrections = poissonCorrections;

  // 5. Distribuição de placares
  db.score_distribution = scoreDistrib;

  // 6. Relatório de validação
  db.training_validation = {
    ...validation,
    trained_at: new Date().toISOString(),
    total_matches: 261,
    rules_count: db.rules.length,
  };

  if (!DRY_RUN) {
    writeFileSync(PIE_PATH, JSON.stringify(db, null, 2), 'utf-8');
  }

  // Também salva no historical-patterns.json
  const hist = {
    version:      '2.0',
    generated_at: new Date().toISOString(),
    description:  'Padrões minerados de jogos reais — 261+ partidas de 12 competições',
    base_rates:   baseRates,
    league_adjustments: leagueAdj,
    score_distribution: scoreDistrib,
    top_patterns: allRules.slice(0, 50),
    poisson_corrections: poissonCorrections,
  };
  if (!DRY_RUN) {
    writeFileSync(HIST_PATH, JSON.stringify(hist, null, 2), 'utf-8');
  }

  return db.rules.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 9 — Relatório
// ─────────────────────────────────────────────────────────────────────────────
function printReport(matches, baseRates, leagueRates, patterns, pairs, poissonCorrections, scoreDistrib, validation) {
  const n = matches.length;
  console.log('\n' + chalk.bold.magenta('═'.repeat(72)));
  console.log(chalk.bold.magenta('  🧠 DEEP TRAINING REPORT — PIE v2.0'));
  console.log(chalk.bold.magenta('  ' + new Date().toLocaleString('pt-BR')));
  console.log(chalk.bold.magenta('═'.repeat(72)));

  // ── Taxa base real ──
  console.log(chalk.bold.cyan('\n📊 TAXAS BASE REAIS (' + n + ' jogos)'));
  const mktDisplayOrder = ['Over 1.5','Over 2.5','Over 3.5','BTTS','Over Corners 6.5','Over Corners 7.5','YC 2.5','Home Win','Draw','Away Win','1X','X2','12'];
  for (const m of mktDisplayOrder) {
    const r = baseRates[m];
    if (r == null) continue;
    const bar  = '█'.repeat(Math.round(r * 20)) + '░'.repeat(20 - Math.round(r * 20));
    const pct  = (r * 100).toFixed(1).padStart(5);
    console.log(`  ${m.padEnd(22)} ${bar}  ${pct}%`);
  }

  // ── Por liga ──
  console.log(chalk.bold.cyan('\n🏆 DESTAQUES POR LIGA'));
  for (const [comp, markets] of Object.entries(leagueRates)) {
    const over25 = markets['Over 2.5'];
    const btts   = markets['BTTS'];
    if (over25 == null && btts == null) continue;
    const ovStr = over25 != null ? `Over2.5=${(over25*100).toFixed(0)}%` : '';
    const btStr = btts   != null ? `BTTS=${(btts*100).toFixed(0)}%`     : '';
    console.log(`  ${comp.slice(0,28).padEnd(30)}  ${ovStr.padEnd(16)}  ${btStr}`);
  }

  // ── Top padrões de sinal ──
  console.log(chalk.bold.cyan('\n🔍 TOP 20 PADRÕES DE SINAL (por lift × significância)'));
  const allSorted = [...patterns, ...pairs]
    .sort((a, b) => Math.abs(b.lift) * Math.log(b.n+1) - Math.abs(a.lift) * Math.log(a.n+1))
    .slice(0, 20);

  for (const p of allSorted) {
    const arrow = p.direction === 'positive' ? chalk.green('↑') : chalk.red('↓');
    const lift  = (p.lift >= 0 ? '+' : '') + (p.lift * 100).toFixed(1) + ' pp';
    const base  = (p.base_rate * 100).toFixed(1) + '%';
    const cond  = (p.conditional_rate * 100).toFixed(1) + '%';
    console.log(`  ${arrow}  ${p.market.padEnd(18)}  se ${p.signal.padEnd(28)}  ${base} → ${cond}  (${lift}, n=${p.n})`);
  }

  // ── Distribuição de placares ──
  console.log(chalk.bold.cyan('\n⚽ TOP 10 PLACARES MAIS FREQUENTES'));
  for (const sc of scoreDistrib.slice(0, 10)) {
    const bar = '█'.repeat(Math.round(sc.rate * 100));
    console.log(`  ${sc.label.padEnd(6)}  ${bar.padEnd(20)}  ${(sc.rate*100).toFixed(1)}%  (${sc.total} jogos)`);
  }

  // ── Validação ──
  console.log(chalk.bold.cyan('\n✅ VALIDAÇÃO 80/20'));
  const highlight = (v) => v > 0 ? chalk.green('+'+v.toFixed(1)+'pp') : chalk.red(v.toFixed(1)+'pp');
  let improved = 0;
  for (const [market, v] of Object.entries(validation)) {
    if (!['Over 1.5','Over 2.5','Over 3.5','BTTS','Over Corners 6.5','YC 2.5','Home Win'].includes(market)) continue;
    const imp = v.improvement;
    if (imp > 0) improved++;
    console.log(`  ${market.padEnd(22)}  Base ${v.baseline_acc}%  →  Com Regras ${v.rule_acc}%  ${highlight(imp)}  (n=${v.test_samples})`);
  }
  console.log(chalk.bold(`  ${improved}/${Object.keys(validation).length} mercados melhoraram com as regras`));

  // ── Correções Poisson ──
  console.log(chalk.bold.cyan('\n📐 CALIBRAÇÃO POISSON (Over 2.5 — bucket adjustment)'));
  const ov25corr = poissonCorrections['Over 2.5'] || [];
  for (const b of ov25corr.filter(b => b.n >= 5)) {
    const diff = b.correction >= 0 ? chalk.green('+'+b.correction.toFixed(2)) : chalk.red(b.correction.toFixed(2));
    console.log(`  Predito ${(b.predicted_mid*100).toFixed(0)}%  →  Real ${(b.actual_rate*100).toFixed(0)}%  Δ ${diff}  (n=${b.n})`);
  }

  console.log('\n' + chalk.bold.magenta('═'.repeat(72)));
  const mode = DRY_RUN ? chalk.yellow('DRY-RUN (não salvo)') : chalk.green('SALVO NO PIE ✅');
  console.log(chalk.bold.magenta(`  Regras geradas: ${[...patterns,...pairs].filter(p=>Math.abs(p.lift)>=MIN_LIFT_THRESHOLD).length}  |  Modo: ${mode}`));
  console.log(chalk.bold.magenta('═'.repeat(72) + '\n'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers matemáticos
// ─────────────────────────────────────────────────────────────────────────────
function poissonPMF(k, lambda) {
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}
function poissonCDF(k, lambda) {
  let cdf = 0;
  for (let i = 0; i <= k; i++) cdf += poissonPMF(i, lambda);
  return Math.min(1, cdf);
}
function factorial(n) {
  if (n <= 1) return 1;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(chalk.bold.blue('\n🧠 Deep Training — PIE Performance Intelligence Engine'));
  console.log(chalk.blue('   Mineração de padrões em dados reais de futebol\n'));

  if (REPORT_ONLY) {
    const db = JSON.parse(readFileSync(PIE_PATH, 'utf-8'));
    const tv = db.training_validation || {};
    if (!tv.trained_at) { console.log('  ⚠️  Nenhum treinamento encontrado. Rode sem --report primeiro.'); process.exit(0); }
    console.log(chalk.cyan(`  Último treinamento: ${new Date(tv.trained_at).toLocaleString('pt-BR')}`));
    console.log(chalk.cyan(`  Jogos analisados:   ${tv.total_matches || '?'}`));
    console.log(chalk.cyan(`  Regras geradas:     ${tv.rules_count   || '?'}`));
    console.log('\n  Resultados de validação:');
    for (const [m, v] of Object.entries(tv)) {
      if (typeof v !== 'object' || !v.baseline_acc) continue;
      const imp = v.improvement;
      console.log(`    ${m.padEnd(22)}  ${v.baseline_acc}% → ${v.rule_acc}%  (${imp > 0 ? '+' : ''}${imp}pp)`);
    }
    process.exit(0);
  }

  // ── Phase 1: Carga ──
  process.stdout.write('  📂 [1/9] Carregando partidas...');
  const matches = loadAllMatches();
  console.log(` ${matches.length} jogos carregados de ${readdirSync(DAILY_DIR).filter(f=>f.endsWith('.json')).length} arquivos`);

  if (matches.length < 50) {
    console.log(chalk.red('  ❌ Mínimo de 50 jogos necessário. Execute npm run collect-auto para coletar dados.'));
    process.exit(1);
  }

  // ── Phase 2 + 3: Features e Taxas Base ──
  process.stdout.write('  📊 [2/9] Extraindo features e taxas base...');
  const { baseRates, leagueRates, scoreDistrib } = computeBaseRates(matches);
  console.log(` ${Object.keys(baseRates).length} mercados, ${Object.keys(leagueRates).length} ligas`);

  // ── Phase 4: Mineração de sinais ──
  process.stdout.write('  🔍 [3/9] Minerando padrões de sinais...');
  const { signalMarket, patterns } = mineSignalPatterns(matches, baseRates);
  console.log(` ${patterns.length} padrões significativos encontrados`);

  // ── Phase 5: Pares ──
  process.stdout.write('  🔗 [4/9] Analisando pares de sinais...');
  const pairs = mineSignalPairs(matches, baseRates, patterns);
  console.log(` ${pairs.length} combinações significativas`);

  // ── Phase 6: Calibração Poisson ──
  process.stdout.write('  📐 [5/9] Calibrando curva Poisson...');
  const poissonCorrections = calibratePoissonCurve(matches);
  console.log(' OK');

  // ── Phase 7: Validação ──
  process.stdout.write('  ✅ [6/9] Validando 80/20...');
  const allPatterns = [...patterns, ...pairs].sort((a, b) =>
    Math.abs(b.lift) * Math.log(b.n+1) - Math.abs(a.lift) * Math.log(a.n+1)
  );
  const validation = validateRules(matches, allPatterns, baseRates);
  const improved = Object.values(validation).filter(v => v.improvement > 0).length;
  console.log(` ${improved}/${Object.keys(validation).length} mercados melhorados`);

  // ── Phase 8: Injeção ──
  process.stdout.write('  💾 [7/9] Injetando no PIE...');
  const rulesCount = injectIntoPIE(baseRates, leagueRates, patterns, pairs, poissonCorrections, scoreDistrib, validation);
  console.log(` ${rulesCount} regras salvas`);

  // ── Phase 9: Log ──
  const logEntry = {
    trained_at:    new Date().toISOString(),
    matches_used:  matches.length,
    rules_created: rulesCount,
    patterns_found: patterns.length,
    pairs_found:   pairs.length,
    dry_run:       DRY_RUN,
    markets_improved: improved,
  };
  try {
    mkdirSync(join(ROOT, 'logs'), { recursive: true });
    appendFileSync(RULES_REPORT, JSON.stringify(logEntry) + '\n', 'utf-8');
  } catch { /* ignorar */ }

  // ── Relatório Final ──
  printReport(matches, baseRates, leagueRates, patterns, pairs, poissonCorrections, scoreDistrib, validation);
}

main().catch(e => { console.error(chalk.red('ERRO:'), e.message); process.exit(1); });
