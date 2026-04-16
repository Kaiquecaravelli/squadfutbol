/**
 * Agregador de Dados Multi-Fonte
 *
 * Hierarquia de prioridade (conforme protocolo v5.4):
 *   Futebol Brasileiro/Sul-americano:
 *     Academia > SofaScore > FlashScore > 365scores
 *   Futebol Internacional:
 *     Academia > SofaScore > FlashScore > 365scores
 *
 * Fontes por tipo de dado:
 *   ODDS DE MERCADO      → Superbet (superbet.bet.br/apostas/futebol/hoje) — EXCLUSIVO
 *   ESCALAÇÃO            → 365scores (get365Lineup)
 *   ESTATÍSTICAS/FORMA   → SofaScore + FlashScore + 365scores
 *   NOTÍCIAS/ANÁLISES    → 365scores (get365News) + Academia
 *   PROBABILIDADES SITE  → 365scores (get365Predictions)
 *   xG / STATS LIVE      → SofaScore
 *
 * Responsável por:
 *   1. Coletar dados de todas as fontes em paralelo
 *   2. Mesclar com regras de prioridade
 *   3. Detectar e registrar conflitos
 *   4. Retornar matchData enriquecido e padronizado
 */

import chalk from 'chalk';
import { getMatchDetails as getFlashscoreDetails } from './flashscore.js';
import { getSofascoreMatchDetails, getSofascoreMatches } from './sofascore.js';
import { get365MatchDetails, get365Predictions, get365Lineup, get365News } from './scores365.js';
import { getTeamStatsAcademia, getBTTSStats, getOverUnderStats } from './academia.js';
import { getSuperbetOdds } from './superbet.js';

const SOURCE_PRIORITY = ['academia', 'sofascore', 'flashscore', '365scores', 'superbet'];

// ── Coletar e agregar dados completos de uma partida ─────────────────────────
export async function aggregateMatchData(match) {
  const label = `${match.home_team || match.match} vs ${match.away_team || ''}`.trim();
  console.log(chalk.bold.cyan(`\n  🔗 [Agregador] ${label}`));

  const start = Date.now();

  // Coleta paralela de todas as fontes
  // ODDS: exclusivamente Superbet (superbet.bet.br/apostas/futebol/hoje)
  // ESCALAÇÃO/STATS/NOTÍCIAS/PROBABILIDADES: 365scores
  const [flashData, sofaData, data365, lineup365, news365, acadHomeData, acadAwayData, superbetData] = await Promise.allSettled([
    match.url ? getFlashscoreDetails(match.url) : Promise.resolve(null),
    match.sofascore_id
      ? getSofascoreMatchDetails(match.sofascore_id, match.home_id, match.away_id)
      : Promise.resolve(null),
    match.url_365 ? get365MatchDetails(match.url_365) : Promise.resolve(null),
    match.url_365 ? get365Lineup(match.url_365).catch(() => null) : Promise.resolve(null),
    match.url_365 ? get365News(match.url_365).catch(() => null)   : Promise.resolve(null),
    getTeamStatsAcademia(match.home_team).catch(() => null),
    getTeamStatsAcademia(match.away_team).catch(() => null),
    getSuperbetOdds(match.home_team, match.away_team, match.match_date).catch(() => null),
  ]);

  const sources = {
    flashscore:    flashData.status === 'fulfilled' ? flashData.value : null,
    sofascore:     sofaData.status  === 'fulfilled' ? sofaData.value  : null,
    '365scores':   data365.status   === 'fulfilled' ? data365.value   : null,
    '365lineup':   lineup365.status === 'fulfilled' ? lineup365.value : null,
    '365news':     news365.status   === 'fulfilled' ? news365.value   : null,
    academia_home: acadHomeData.status === 'fulfilled' ? acadHomeData.value : null,
    academia_away: acadAwayData.status === 'fulfilled' ? acadAwayData.value : null,
    superbet: superbetData.status === 'fulfilled' && superbetData.value && Object.keys(superbetData.value).length
      ? superbetData.value
      : null,
  };

  const activeSources = Object.entries(sources).filter(([, v]) => v !== null).map(([k]) => k);
  const oddsSource = sources.superbet ? chalk.green('odds:superbet✅') : chalk.gray('odds:sem fonte');
  console.log(chalk.gray(`    Fontes ativas: ${activeSources.join(', ')} — ${oddsSource} (${Date.now() - start}ms)`));

  // Mesclar dados com prioridade
  const merged = mergeMatchData(match, sources);

  // Relatório de conflitos
  const conflicts = detectConflicts(sources);
  if (conflicts.length) {
    console.log(chalk.yellow(`    ⚠️  Conflitos detectados: ${conflicts.length}`));
    conflicts.forEach((c) => console.log(chalk.gray(`       ${c}`)));
  }

  merged._meta = {
    sources_used: activeSources,
    conflicts,
    data_completeness: calcCompleteness(merged),
    collection_ms: Date.now() - start,
  };

  return merged;
}

// ── Coletar partidas de todas as fontes e fazer cross-match ──────────────────
export async function aggregateUpcomingMatches(date, hoursAhead = 8) {
  console.log(chalk.bold.cyan(`\n🔗 [Agregador] Cruzando fontes de partidas...`));

  const { getUpcomingMatches } = await import('./flashscore.js');

  const [flashMatches, sofaMatches] = await Promise.allSettled([
    getUpcomingMatches(hoursAhead),
    getSofascoreMatches(date),
  ]);

  const flash = flashMatches.status === 'fulfilled' ? flashMatches.value : [];
  const sofa  = sofaMatches.status  === 'fulfilled' ? sofaMatches.value  : [];

  // Cross-match: enriquecer partidas do FlashScore com IDs do SofaScore
  const enriched = flash.map((fm) => {
    const sofaMatch = sofa.find((sm) =>
      fuzzyMatch(sm.home_team, fm.home_team) && fuzzyMatch(sm.away_team, fm.away_team)
    );

    return {
      ...fm,
      sofascore_id: sofaMatch?.sofascore_id || null,
      home_id:      sofaMatch?.home_id      || null,
      away_id:      sofaMatch?.away_id      || null,
      competition:  fm.competition || sofaMatch?.competition,
    };
  });

  // Partidas no SofaScore que não estão no FlashScore
  const flashNorm = flash.map((m) => normTeam(m.home_team));
  const sofaOnly  = sofa.filter((sm) => !flashNorm.includes(normTeam(sm.home_team)));

  const all = [...enriched, ...sofaOnly];
  console.log(chalk.gray(`  Flash: ${flash.length} | SofaScore: ${sofa.length} | Total único: ${all.length}`));

  return all;
}

// ── Mesclar dados com regras de prioridade ────────────────────────────────────
function mergeMatchData(baseMatch, sources) {
  const { flashscore, sofascore, academia_home, academia_away, superbet } = sources;
  const lineup365 = sources['365lineup'];
  const news365   = sources['365news'];

  // Base vinda do FlashScore (ou SofaScore se Flash vazio)
  const base = flashscore || {};

  // Forma e stats: SofaScore tem dados mais ricos (xG, ratings)
  const homeForm = mergeTeamStats(
    base.home,
    sofascore?.home,
    academia_home,
    baseMatch.home_team || base.home?.team
  );
  const awayForm = mergeTeamStats(
    base.away,
    sofascore?.away,
    academia_away,
    baseMatch.away_team || base.away?.team
  );

  // H2H: SofaScore > FlashScore
  const h2h = sofascore?.h2h?.length
    ? sofascore.h2h
    : base.h2h || [];

  // Odds: EXCLUSIVAMENTE Superbet (superbet.bet.br/apostas/futebol/hoje)
  // 365scores NÃO é mais fonte de odds — apenas de estatísticas/escalação/notícias
  const odds = superbet && Object.keys(superbet).length
    ? superbet
    : (base.odds && Object.keys(base.odds).length ? base.odds : {});

  // Escalação: 365scores (lineup)
  const lineup = lineup365 || null;

  // Notícias/análise pré-jogo: 365scores
  const pregameNews = news365 || null;

  // Probabilidades do site 365scores (não odds de aposta)
  const siteProbabilities = sources['365scores']?.probabilities || null;

  return {
    match_id:    baseMatch.match_id    || baseMatch.sofascore_id,
    match:       base.match            || `${baseMatch.home_team} vs ${baseMatch.away_team}`,
    date:        base.date             || baseMatch.match_date || baseMatch.date,
    match_time:  baseMatch.match_time  || base.match_time,
    competition: base.competition      || baseMatch.competition,
    venue:       base.venue,
    url:         baseMatch.url,
    home: homeForm,
    away: awayForm,
    h2h,
    odds,
    lineup,           // escalações (365scores)
    pregame_news:     pregameNews,      // notícias pré-jogo (365scores)
    site_probs:       siteProbabilities, // probabilidades do site 365scores
    weather: base.weather || null,
  };
}

function mergeTeamStats(flash, sofa, academia, teamName) {
  // Fontes disponíveis para cada campo
  const pick = (field, fallback = null) =>
    sofa?.[field]       ??
    academia?.[field]   ??
    flash?.[field]      ??
    fallback;

  return {
    team: teamName || flash?.team || sofa?.team || 'N/A',

    // Forma: SofaScore tem dados mais completos (8 jogos + xG)
    form: sofa?.form || flash?.form || 'N/A',

    // Médias: Academia tem histórico mais longo, SofaScore tem recente
    goals_scored_avg:   weightedAvg(
      sofa?.goals_scored_avg,   0.6,
      academia?.goals_scored_avg, 0.4,
      flash?.goals_scored_avg
    ),
    goals_conceded_avg: weightedAvg(
      sofa?.goals_conceded_avg,   0.6,
      academia?.goals_conceded_avg, 0.4,
      flash?.goals_conceded_avg
    ),

    // xG: só SofaScore fornece
    xg_avg: pick('xg_avg', 0),

    // Métricas extras
    ratings_avg:    sofa?.ratings_avg   || null,
    clean_sheets:   pick('clean_sheets', 0),

    // Métricas da Academia (tendências históricas)
    btts_pct:       academia?.btts_pct       || null,
    over_25_pct:    academia?.over_25_pct    || null,
    clean_sheet_pct: academia?.clean_sheet_pct || null,

    // Jogos recentes (lista completa)
    last_matches: sofa?.last_matches || flash?.last_matches || [],

    // Pregame form (SofaScore)
    pregame_form: sofa?.pregame_form || null,
  };
}

function weightedAvg(primary, primaryW, secondary, secondaryW, fallback) {
  if (primary && secondary) {
    return Math.round((primary * primaryW + secondary * secondaryW) * 10) / 10;
  }
  return primary ?? secondary ?? fallback ?? 1.3;
}

// ── Detecção de conflitos ─────────────────────────────────────────────────────
function detectConflicts(sources) {
  const conflicts = [];
  const { flashscore, sofascore } = sources;

  if (!flashscore || !sofascore) return conflicts;

  const fields = ['goals_scored_avg', 'goals_conceded_avg'];
  for (const side of ['home', 'away']) {
    for (const field of fields) {
      const v1 = flashscore?.[side]?.[field];
      const v2 = sofascore?.[side]?.[field];
      if (v1 && v2 && Math.abs(v1 - v2) > 0.5) {
        conflicts.push(`CONFLITO ${side}.${field}: Flash=${v1} | Sofa=${v2} (prioridade: SofaScore)`);
      }
    }
  }

  return conflicts;
}

function calcCompleteness(data) {
  const fields = [
    data.home?.form, data.home?.goals_scored_avg, data.home?.goals_conceded_avg,
    data.away?.form, data.away?.goals_scored_avg, data.away?.goals_conceded_avg,
    data.h2h?.length, data.odds, data.match_time,
  ];
  const filled = fields.filter((f) => f !== null && f !== undefined && f !== 'N/A').length;
  return Math.round((filled / fields.length) * 100);
}

// ── Helpers de fuzzy match ────────────────────────────────────────────────────
function fuzzyMatch(a, b) {
  const na = normTeam(a);
  const nb = normTeam(b);

  // Igual exato
  if (na === nb) return true;

  // Prefixo mínimo de 6 caracteres para evitar falsos positivos em nomes curtos
  const minLen = 6;
  if (na.length >= minLen && nb.length >= minLen) {
    const sliceA = na.slice(0, Math.min(8, na.length));
    const sliceB = nb.slice(0, Math.min(8, nb.length));
    if (na.includes(sliceB) || nb.includes(sliceA)) return true;
  }

  // Coincidência de palavras: pelo menos 1 palavra significativa em comum (len >= 4)
  const wordsA = a.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/\W+/).filter((w) => w.length >= 4);
  const wordsB = b.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/\W+/).filter((w) => w.length >= 4);
  return wordsA.some((w) => wordsB.includes(w));
}

function normTeam(name) {
  return (name || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}
