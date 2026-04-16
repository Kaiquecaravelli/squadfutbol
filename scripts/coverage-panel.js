/**
 * coverage-panel.js — Painel de Cobertura por Liga e Mercado
 *
 * Módulo 7 da Missão de Expansão de Cobertura (2026-04-16).
 *
 * Exibe um mapa completo de APROVADO/BLOQUEADO para cada combinação
 * liga × mercado, incluindo:
 *   - Tier de Over 1.5 (Tier 1/2/3/Morta/Desconhecida)
 *   - Status de Under 1.5 e Under 2.5 (Tier 1 Under / Padrão / Bloqueada)
 *   - Status de Corners 6.5 (Whitelist / UCL KO / Bloqueada)
 *   - Status de BTTS (Morta / UCL KO)
 *   - Fase UCL detectada (KO vs Liga)
 *
 * Uso:
 *   node scripts/coverage-panel.js
 *   node scripts/coverage-panel.js --json
 *   node scripts/coverage-panel.js --market=Corners
 *   node scripts/coverage-panel.js --market=Under
 */

import 'dotenv/config';

// ── Imports dos snipers ──────────────────────────────────────────────────────
import {
  goalsKillSwitch,
  goalsMinProbability,
  EMERGING_LEAGUES_WATCHLIST,
} from '../src/utils/goals-sniper.js';

import {
  cornersIsDeadLeague,
  cornersKillSwitch,
  CORNERS_MIN_CONFIDENCE,
} from '../src/utils/corners-sniper.js';

import {
  bttsIsDeadLeague,
} from '../src/utils/btts-sniper.js';

import {
  getKillZoneFloor,
  KILL_ZONE_THRESHOLD,
} from '../src/utils/kill-zone.js';

// ── Configuração do painel ────────────────────────────────────────────────────

const OUTPUT_JSON  = process.argv.includes('--json');
const FILTER_MKT   = (process.argv.find(a => a.startsWith('--market=')) || '').replace('--market=', '').toLowerCase();

// Lista de ligas para análise — inclui ligas conhecidas + watchlist
const LEAGUES = [
  // Tier 1 Over 1.5
  { name: 'VriendenLoterij Eredivisie', short: 'Eredivisie' },
  { name: 'Bundesliga',                 short: 'Bundesliga' },
  { name: 'UEFA Champions League',      short: 'UCL' },
  // Tier 2 Over 1.5
  { name: 'LaLiga',                     short: 'LaLiga' },
  { name: 'Premier League',             short: 'Premier League' },
  { name: 'Brasileirão Betano',         short: 'Brasileirão' },
  { name: 'CONCACAF Champions Cup',     short: 'CONCACAF CC' },
  // Tier 3 Over 1.5
  { name: 'Liga Portugal Betclic',      short: 'Liga Portugal' },
  { name: 'Serie A',                    short: 'Serie A' },
  // Corners extras
  { name: 'Ligue 1',                    short: 'Ligue 1' },
  { name: 'MLS',                        short: 'MLS' },
  { name: 'Liga Profesional',           short: 'Liga Profesional' },
  { name: 'Brasileirão Série B',        short: 'Série B' },
  // Ligas mortas Over 1.5
  { name: 'Championship',               short: 'Championship' },
  { name: '2. Bundesliga',              short: '2.Bundesliga' },
  { name: 'UEFA Europa League',         short: 'Europa League' },
  { name: 'UEFA Conference League',     short: 'Conference League' },
  // Ligas emergentes
  { name: 'Eliteserien',               short: 'Eliteserien' },
  { name: 'Allsvenskan',               short: 'Allsvenskan' },
  { name: 'Süper Lig',                 short: 'Süper Lig' },
];

const MARKETS_GOALS   = ['Over 1.5', 'Over 2.5', 'Over 3.5', 'Under 1.5', 'Under 2.5'];
const MARKETS_CORNERS = ['Over Corners 6.5', 'Over Corners 7.5', 'Over Corners 8.5'];
const MARKETS_BTTS    = ['BTTS'];

// ── Helpers ──────────────────────────────────────────────────────────────────

function fakeResult(market, prob) {
  return {
    mercado:       market,
    market:        market,
    probabilidade: prob,
    confianca:     85,
    recomendacao:  'Sim',
  };
}

function fakeMatch(competition) {
  return { competition, league: competition };
}

/**
 * Testa um mercado para uma liga retornando status de aprovação.
 * Usa a probabilidade MÍNIMA do tier como teste (pior caso aprovado).
 */
function testMarket(competition, market) {
  const minProb  = goalsMinProbability(market, competition);
  const result   = fakeResult(market, minProb);
  const match    = fakeMatch(competition);
  const ksResult = goalsKillSwitch(result, match);

  if (ksResult) {
    return { status: 'BLOCK', reason: ksResult.split('—')[0].trim() };
  }
  return {
    status: 'OK',
    threshold: minProb,
    floor: getKillZoneFloor(market, competition),
  };
}

function testCorners(competition, market) {
  const match  = fakeMatch(competition);
  const isDead = cornersIsDeadLeague(competition);
  if (isDead) return { status: 'BLOCK', reason: 'Liga morta Corners' };

  const result = fakeResult(market, 85);
  const ks     = cornersKillSwitch(result, match);
  if (ks) return { status: 'BLOCK', reason: ks.split('—')[0].trim() };
  return { status: 'OK', threshold: CORNERS_MIN_CONFIDENCE };
}

function testBTTS(competition) {
  if (bttsIsDeadLeague(competition)) {
    return { status: 'BLOCK', reason: 'Liga morta BTTS' };
  }
  return { status: 'OK' };
}

function ucLPhase() {
  const month = new Date().getMonth() + 1;
  if (month >= 2 && month <= 5) return 'KNOCKOUT (Fev–Mai)';
  if (month >= 9) return 'Liga Phase (Set–Jan)';
  return 'Pré-temporada';
}

// ── Render ────────────────────────────────────────────────────────────────────

function statusSymbol(s) {
  if (s === 'OK')    return '✅';
  if (s === 'BLOCK') return '🔴';
  return '⚪';
}

function buildReport() {
  const rows = [];

  for (const league of LEAGUES) {
    const row = {
      league:  league.short,
      fullName: league.name,
      markets: {},
      btts:    testBTTS(league.name),
    };

    for (const mkt of MARKETS_GOALS) {
      if (FILTER_MKT && !mkt.toLowerCase().includes(FILTER_MKT)) continue;
      row.markets[mkt] = testMarket(league.name, mkt);
    }

    for (const mkt of MARKETS_CORNERS) {
      if (FILTER_MKT && !mkt.toLowerCase().includes(FILTER_MKT)) continue;
      row.markets[mkt] = testCorners(league.name, mkt);
    }

    if (!FILTER_MKT || 'btts'.includes(FILTER_MKT)) {
      row.markets['BTTS'] = row.btts;
    }

    rows.push(row);
  }

  return rows;
}

function printTable(rows) {
  const allMarkets = [
    ...(!FILTER_MKT || 'over 1.5'.includes(FILTER_MKT) ? ['Over 1.5']  : []),
    ...(!FILTER_MKT || 'over 2.5'.includes(FILTER_MKT) ? ['Over 2.5']  : []),
    ...(!FILTER_MKT || 'under 1.5'.includes(FILTER_MKT) ? ['Under 1.5'] : []),
    ...(!FILTER_MKT || 'under 2.5'.includes(FILTER_MKT) ? ['Under 2.5'] : []),
    ...(!FILTER_MKT || 'corners'.includes(FILTER_MKT)   ? ['Cor. 6.5', 'Cor. 7.5', 'Cor. 8.5'] : []),
    ...(!FILTER_MKT || 'btts'.includes(FILTER_MKT)      ? ['BTTS']      : []),
  ];

  const mktFull = {
    'Over 1.5': 'Over 1.5', 'Over 2.5': 'Over 2.5',
    'Under 1.5': 'Under 1.5', 'Under 2.5': 'Under 2.5',
    'Cor. 6.5': 'Over Corners 6.5', 'Cor. 7.5': 'Over Corners 7.5',
    'Cor. 8.5': 'Over Corners 8.5', 'BTTS': 'BTTS',
  };

  const colW = 11;
  const leagW = 18;

  const header = 'Liga'.padEnd(leagW) + allMarkets.map(m => m.padEnd(colW)).join('');
  console.log('\n' + header);
  console.log('─'.repeat(header.length));

  for (const row of rows) {
    const cells = allMarkets.map(m => {
      const data = row.markets[mktFull[m]];
      if (!data) return '──'.padEnd(colW);
      const sym  = statusSymbol(data.status);
      const info = data.status === 'OK' && data.threshold
        ? `(${data.threshold}%)`
        : '';
      return `${sym} ${info}`.padEnd(colW);
    });
    console.log(row.league.padEnd(leagW) + cells.join(''));
  }
}

function printWatchlist() {
  console.log('\n── Emerging Leagues Watchlist (Shadow Mode) ──');
  for (const l of EMERGING_LEAGUES_WATCHLIST) {
    const prio = l.priority === 'high' ? '🔥' : l.priority === 'medium' ? '⚡' : '💤';
    const note = l.note ? ` — ${l.note}` : '';
    console.log(`  ${prio} ${l.competition.padEnd(30)} → ${l.targetMarkets.join(' · ')}${note}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const report  = buildReport();
const today   = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const uclPhase = ucLPhase();

if (OUTPUT_JSON) {
  console.log(JSON.stringify({ date: today, ucl_phase: uclPhase, coverage: report }, null, 2));
  process.exit(0);
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`  PAINEL DE COBERTURA — ${today}`);
console.log(`  UCL Fase Detectada: ${uclPhase}`);
console.log(`  Kill Zone padrão:   ${KILL_ZONE_THRESHOLD}% (Módulo 4: calibração por liga ativa)`);
console.log(`${'═'.repeat(60)}`);

printTable(report);

// Resumo
const allCells = report.flatMap(r => Object.values(r.markets));
const totalOk  = allCells.filter(c => c.status === 'OK').length;
const totalBlk = allCells.filter(c => c.status === 'BLOCK').length;
const coverPct = Math.round(totalOk / (totalOk + totalBlk) * 100);

console.log(`\n  Total aprovado: ${totalOk}/${totalOk + totalBlk} (${coverPct}% cobertura)`);
console.log(`  Legenda: ✅ Aprovado · 🔴 Bloqueado · threshold = prob mínima`);

printWatchlist();

console.log(`\n  Opções: --json · --market=Corners · --market=Under`);
console.log(`  Diagnóstico PIE: npm run pie-diag\n`);
