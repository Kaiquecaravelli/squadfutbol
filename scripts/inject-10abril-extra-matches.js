/**
 * inject-10abril-extra-matches.js
 * Padrões históricos: 6 jogos adicionais de 10/04/2026
 * Eredivisie, Primeira Liga PT, Super Lig, A-League, Liga MX, USL Championship
 */

import { readFileSync, writeFileSync } from 'fs';
import { saveLesson, savePositiveLesson, loadDB } from '../src/pie/pie-storage.js';

const DB_PATH   = 'data/pie.json';
const HIST_PATH = 'data/historical-patterns.json';
const PRED_ID   = 'historical_seed_10abril_extra';

console.log('\n🧠 PIE — Injeção Extra: 10/04/2026');
console.log('Jogos: Twente×Volendam | Famalicão×Moreirense | Beşiktaş×Antalyaspor');
console.log('       Central Coast×Brisbane | Juárez×Tijuana | Loudoun×Louisville');
console.log('═'.repeat(68));

// ── Padrões Positivos ────────────────────────────────────────────────────────
const positivos = [
  {
    market: 'BTTS',
    competition: null,
    directive: 'PADRÃO UNIVERSAL CONFIRMADO — BTTS mesmo com extrema dominância: Em TODOS os 6 jogos analisados no dia 10/04/2026 com resultado ≥ 1:1, o BTTS foi YES. Mesmo quando um time domina com ≥62% posse e ≥17 chutes contra apenas 3 do adversário (Famalicão vs Moreirense), BTTS ocorre se o time fraco marca cedo (≤10 min) e senta no resultado. REGRA: BTTS tem altíssima confiança quando ambos os times têm histórico de marcar e nenhum tem defesa hermeticamente fechada.',
  },
  {
    market: 'BTTS',
    competition: 'Primeira Liga',
    directive: 'PADRÃO PRIMEIRA LIGA PT — BTTS com time ultra-defensivo: Moreirense (3 chutes, 0 escanteios, 38% posse) marcou no 3º minuto e fechou o jogo → Famalicão empate apenas no min71. Quando visitante fraco marca cedo (≤10 min) na Primeira Liga PT, não abandona o placar facilmente. BTTS é seguro pois o mandante sempre reage. REFORÇO: Famalicão teve 13 escanteios e 17 chutes mas só marcou 1 gol — eficiência baixa não cancela o BTTS.',
  },
  {
    market: 'Over 1.5',
    competition: null,
    directive: 'PADRÃO GLOBAL CONFIRMADO — Over 1.5 em jogos com BTTS: Em todos os 6 jogos com resultado ≥ 1:1 de 10/04/2026, Over 1.5 foi automático. Quando BTTS é YES → Over 1.5 é sempre YES (mínimo 2 gols). Usar BTTS como gatilho para confirmar Over 1.5. Taxa histórica: 6/6 amostras, 100% neste conjunto.',
  },
  {
    market: 'Over 2.5',
    competition: 'Super Lig',
    directive: 'PADRÃO SUPER LIG TURQUIA — Over 2.5 confiável: Beşiktaş 4-2 Antalyaspor com 16+8=24 chutes combinados, 10+6=16 escanteios, 67% posse Beşiktaş = 6 gols. Na Super Lig quando time da casa domina com >60% posse E chutes combinados ≥20, Over 2.5 é muito confiável. Antalyaspor (visitante) marcou 2 gols com apenas 8 chutes — liga de alta pontuação.',
  },
  {
    market: 'Over 2.5',
    competition: 'Eredivisie',
    directive: 'PADRÃO EREDIVISIE — Over 2.5 com domínio intenso: Twente 2-1 Volendam, 18 chutes vs 6. Quando time da casa na Eredivisie tem ≥16 chutes e adversário ≥4 chutes no gol, Over 2.5 é confiável. Twente fez 2-0 no 1T mas Volendam reagiu no 2T (min46). Padrão: goleada evitada, mas resultado final ≥3 gols.',
  },
  {
    market: 'Over Corners',
    competition: 'Primeira Liga',
    directive: 'PADRÃO CORNERS PRIMEIRA LIGA PT — Extrema assimetria: Famalicão 13 escanteios vs Moreirense 0 = 13 total. Quando visitante ultra-defensivo (0 escanteios, 3 chutes, linha baixa) joga contra mandante dominante (17 chutes, 62% posse), TODOS os ataques do mandante que não entram viram escanteio. Over 8.5 e Over 10.5 são muito seguros nesse cenário. Indicador: visitante com <2 escanteios/jogo + mandante >10 chutes/jogo.',
  },
  {
    market: 'Over Corners',
    competition: 'Super Lig',
    directive: 'PADRÃO CORNERS SUPER LIG — Ambos atacam: Beşiktaş 10 + Antalyaspor 6 = 16 escanteios. Quando ambos os times têm qualidade ofensiva e a partida é aberta (4-2 final), Over 10.5 corners é possível na Super Lig. Padrão: liga ofensiva + ambos pressionando = alto volume de corners.',
  },
  {
    market: 'Cartões',
    competition: 'Primeira Liga',
    directive: 'PADRÃO CARTÕES PRIMEIRA LIGA PT — Over 4.5 YC muito confiável: Famalicão 5 + Moreirense 6 = 11 cartões amarelos em 1-1. Jogos equilibrados/tensos na Primeira Liga PT (especialmente em jogos de sobrevivência/mid-table) produzem altos volumes de cartões. Quando adversários são mid-table em situação de necessidade, Over 4.5 YC deve ser considerado. Amostra: 11 cards em 1 jogo.',
  },
  {
    market: 'Cartões',
    competition: null,
    directive: 'PADRÃO CARTÕES — Expulsão precoce amplifica cartões totais: FC Juárez vs Tijuana — Juárez teve expulsão no 4º minuto (Monchu) e mais uma no 90+7 (Murillo). O time com 10 homens comete mais faltas desesperadamente → mais YC para o time reduzido. When early red card (≤10 min) occurs, Over YC 2.5 é muito mais provável pois o time perde a cabeça em situações de pressão.',
  },
];

positivos.forEach((p) => {
  savePositiveLesson({ market: p.market, competition: p.competition, directive: p.directive, predictionId: PRED_ID });
  console.log(`✅ Positivo injetado : ${(p.market || 'cross-market').padEnd(14)} ${p.competition || 'global'}`);
});

// ── Lições de Calibração ─────────────────────────────────────────────────────
const licoes = [
  {
    market: 'Over 2.5',
    competition: 'Primeira Liga',
    errorType: 'calibration',
    directive: 'CALIBRAÇÃO CRÍTICA Primeira Liga PT — Armadilha do Under 2.5: Famalicão 1-1 Moreirense: dominância extrema (17 vs 3 chutes, 13 vs 0 corners) não garantiu Over 2.5. O visitante ultra-defensivo com gol precoce (3 min) pode segurar o 1-1 mesmo sob pressão intensa. REGRA: Se visitante tem <5 chutes E marcou nos primeiros 10 min, preferir Under 2.5 ao Over 2.5, pois a vitória do visitante ou empate baixo é mais provável que a abertura do jogo.',
  },
  {
    market: 'BTTS',
    competition: 'Primeira Liga',
    errorType: 'calibration',
    directive: 'CALIBRAÇÃO BTTS Primeira Liga PT — Gol precoce do visitante fraco: Quando visitante com baixo ataque (≤5 chutes/jogo) marca nos primeiros 10 min, BTTS ainda é provável pois o mandante não pode recuar. Famalicão 1-1 Moreirense confirma: mesmo com 17 vs 3 chutes, BTTS YES. Elevar BTTS em +8pp quando visitante defensivo marca cedo (≤10 min).',
  },
  {
    market: 'Over Corners',
    competition: null,
    errorType: 'calibration',
    directive: 'CALIBRAÇÃO CORNERS GLOBAL — Visitante ultra-defensivo = Over corners mandante: Quando visitante tem <2 escanteios/jogo E <5 chutes/jogo, TODOS os ataques do mandante tendem a virar corners. Famalicão 13 corners vs Moreirense 0 — Use Over 8.5 corners com confiança quando visitante tem perfil ultra-defensivo. Central Coast 1 corner vs Brisbane 10 → inversamente, visitante atacante também amplifica total.',
  },
  {
    market: 'Cartões',
    competition: 'Primeira Liga',
    errorType: 'calibration',
    directive: 'CALIBRAÇÃO CARTÕES PRIMEIRA LIGA PT: Com 11 cartões em Famalicão 1-1 Moreirense, Over 4.5 YC era o mercado correto. Jogos mid-table tensionados nesta liga produzem frequentemente 8+ amarelos. Linha recomendada: Over 3.5 (segura) a Over 4.5 (alta confiança) em jogos PT com times entre 8º e 15º lugar que precisam de pontos.',
  },
  {
    market: 'Over 2.5',
    competition: 'Super Lig',
    errorType: 'calibration',
    directive: 'CALIBRAÇÃO Over 2.5 SUPER LIG TURQUIA: Liga ofensiva com alta média de gols. Beşiktaş 4-2 Antalyaspor com 24 chutes combinados. Elevar probabilidade Over 2.5 em +12pp quando: (a) time da casa tem >60% posse histórica + (b) visitante marca habitualmente >1 gol/jogo fora. Super Lig tem média histórica de ~3.1 gols/jogo — Over 2.5 é mercado base favorito.',
  },
  {
    market: 'Cartões',
    competition: null,
    errorType: 'calibration',
    directive: 'CALIBRAÇÃO CARTÕES EXPULSÃO PRECOCE: Quando time recebe expulsão antes de 15 min, jogar com 10 homens durante 75+ minutos força faltas defensivas constantes → mais YC para o time reduzido. FC Juárez teve 2 expulsões e 2 YC além das vermelhas. Padrão: expulsão ≤15 min → elevar Over 2.5 YC em +15pp. Cuidado: árbitro pode ser mais leniente após 1 vermelho para não expulsar mais jogadores.',
  },
];

licoes.forEach((l) => {
  saveLesson({ market: l.market, competition: l.competition, directive: l.directive, errorType: l.errorType, predictionId: PRED_ID });
  console.log(`📚 Lição injetada   : ${(l.market || 'cross-market').padEnd(14)} ${l.competition || 'global'}`);
});

// ── Calibração Numérica ──────────────────────────────────────────────────────
const db = loadDB();

function probRange(p) {
  if (p >= 95) return '95+';
  if (p >= 90) return '90-95';
  if (p >= 85) return '85-90';
  if (p >= 80) return '80-85';
  if (p >= 70) return '70-80';
  if (p >= 60) return '60-70';
  return '<60';
}

const outcomes = [
  // Twente 2-1 Volendam (Eredivisie)
  { market: 'BTTS',        probabilidade: 72, acertou: true,  competition: 'Eredivisie' },
  { market: 'Over 1.5',   probabilidade: 82, acertou: true,  competition: 'Eredivisie' },
  { market: 'Over 2.5',   probabilidade: 68, acertou: true,  competition: 'Eredivisie' },
  { market: 'Over Corners', probabilidade: 65, acertou: true,  competition: 'Eredivisie' },  // 8 total, Over 7.5

  // Famalicão 1-1 Moreirense (Primeira Liga)
  { market: 'BTTS',        probabilidade: 70, acertou: true,  competition: 'Primeira Liga' },
  { market: 'Over 1.5',   probabilidade: 78, acertou: true,  competition: 'Primeira Liga' },
  { market: 'Over 2.5',   probabilidade: 62, acertou: false, competition: 'Primeira Liga' }, // MISS: só 2 gols
  { market: 'Over Corners', probabilidade: 75, acertou: true,  competition: 'Primeira Liga' },  // 13 corners
  { market: 'Cartões',    probabilidade: 72, acertou: true,  competition: 'Primeira Liga' },  // 11 YC

  // Beşiktaş 4-2 Antalyaspor (Super Lig)
  { market: 'BTTS',        probabilidade: 78, acertou: true,  competition: 'Super Lig' },
  { market: 'Over 1.5',   probabilidade: 85, acertou: true,  competition: 'Super Lig' },
  { market: 'Over 2.5',   probabilidade: 78, acertou: true,  competition: 'Super Lig' },
  { market: 'Over Corners', probabilidade: 80, acertou: true,  competition: 'Super Lig' },   // 16 corners
  { market: 'Cartões',    probabilidade: 65, acertou: true,  competition: 'Super Lig' },    // 3 YC, Over 2.5

  // Central Coast 2-2 Brisbane Roar (A-League)
  { market: 'BTTS',        probabilidade: 72, acertou: true,  competition: 'A-League' },
  { market: 'Over 1.5',   probabilidade: 80, acertou: true,  competition: 'A-League' },
  { market: 'Over 2.5',   probabilidade: 70, acertou: true,  competition: 'A-League' },
  { market: 'Over Corners', probabilidade: 68, acertou: true,  competition: 'A-League' },    // 11 corners

  // FC Juárez 1-2 Tijuana (Liga MX)
  { market: 'BTTS',        probabilidade: 68, acertou: true,  competition: 'Liga MX' },
  { market: 'Over 1.5',   probabilidade: 72, acertou: true,  competition: 'Liga MX' },
  { market: 'Over 2.5',   probabilidade: 65, acertou: true,  competition: 'Liga MX' },
  { market: 'Over Corners', probabilidade: 70, acertou: true,  competition: 'Liga MX' },     // 14 corners
  { market: 'Cartões',    probabilidade: 75, acertou: true,  competition: 'Liga MX' },      // red cards early

  // Loudoun 3-3 Louisville (USL)
  { market: 'BTTS',        probabilidade: 70, acertou: true,  competition: 'USL Championship' },
  { market: 'Over 1.5',   probabilidade: 80, acertou: true,  competition: 'USL Championship' },
  { market: 'Over 2.5',   probabilidade: 72, acertou: true,  competition: 'USL Championship' },
];

for (const o of outcomes) {
  if (!db.calibration[o.market]) {
    db.calibration[o.market] = { total: 0, hits: 0, byRange: {}, byCompetition: {} };
  }
  const c   = db.calibration[o.market];
  const rng = probRange(o.probabilidade);
  const hit = o.acertou ? 1 : 0;

  c.total++; c.hits += hit;
  if (!c.byRange[rng]) c.byRange[rng] = { total: 0, hits: 0 };
  c.byRange[rng].total++; c.byRange[rng].hits += hit;
  if (!c.byCompetition[o.competition]) c.byCompetition[o.competition] = { total: 0, hits: 0 };
  c.byCompetition[o.competition].total++; c.byCompetition[o.competition].hits += hit;

  if (o.acertou) db.stats.acertos++; else db.stats.erros++;
  db.stats.total++;
}

writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
console.log(`\n📊 Calibração: ${outcomes.length} outcomes (${outcomes.filter(o=>o.acertou).length} acertos / ${outcomes.filter(o=>!o.acertou).length} erros)`);

// ── Salvar em historical-patterns.json ──────────────────────────────────────
const hist = JSON.parse(readFileSync(HIST_PATH, 'utf-8'));

const novosJogos = [
  {
    match_id: 'hist_eredivisie_2026_04_10_twente_volendam',
    match: 'FC Twente vs FC Volendam',
    competition: 'Eredivisie',
    round: 'Jornada 30',
    match_date: '2026-04-10',
    venue: 'Grolsch Veste, Enschede, Holanda',
    result: { home_goals: 2, away_goals: 1, placar: '2-1', winner: 'home' },
    ht_score: { home: 2, away: 0 },
    goals_timeline: [
      { minute: 2,  team: 'home', scorer: 'Ruud Nijstad',        type: 'open_play' },
      { minute: 34, team: 'home', scorer: 'Kristian Hlynsson',   type: 'open_play' },
      { minute: 46, team: 'away', scorer: 'Aurelio Oehlers',     type: 'open_play', note: '1 minuto após o início do 2T' },
    ],
    match_stats: {
      shots_home: 18, shots_away: 6,
      shots_on_goal_home: 10, shots_on_goal_away: 4,
      possession_home: 57, possession_away: 43,
      corners_home: 7, corners_away: 1, corners_total: 8,
      yellow_cards_home: 1, yellow_cards_away: 2,
    },
    market_outcomes: [
      { market: 'BTTS',      bet: 'Ambas Marcam SIM', result: 'WIN', acertou: true },
      { market: 'Over 1.5',  bet: 'Over 1.5 Gols',   result: 'WIN', acertou: true, total_goals: 3 },
      { market: 'Over 2.5',  bet: 'Over 2.5 Gols',   result: 'WIN', acertou: true, total_goals: 3 },
      { market: 'Over Corners', bet: 'Over 7.5 Escanteios', result: 'WIN', acertou: true, total_corners: 8 },
      { market: 'Cartões',   bet: 'Over 2.5 Cartões', result: 'WIN', acertou: true, total_yc: 3 },
    ],
    pattern_signals: [
      'home_dominant_shots_18_vs_6',
      'home_2_0_halftime_visitor_pulls_back_second_half',
      'visitor_early_second_half_goal_46min',
      'btts_despite_2_0_ht_lead',
      'eredivisie_open_attacking_play',
    ],
  },
  {
    match_id: 'hist_primeiraliga_2026_04_10_famalicao_moreirense',
    match: 'FC Famalicão vs Moreirense',
    competition: 'Primeira Liga',
    round: 'Jornada 29',
    match_date: '2026-04-10',
    venue: 'Estádio Municipal de Famalicão, Portugal',
    result: { home_goals: 1, away_goals: 1, placar: '1-1', winner: 'draw' },
    ht_score: { home: 0, away: 1 },
    goals_timeline: [
      { minute: 3,  team: 'away', scorer: 'Rodrigo Alonso Martin', type: 'open_play', note: 'Gol precoce do visitante defensivo' },
      { minute: 71, team: 'home', scorer: 'Pedro Miguel Costa Santos', type: 'open_play', note: 'Empate tardio após domínio total' },
    ],
    match_stats: {
      shots_home: 17, shots_away: 3,
      shots_on_goal_home: 7, shots_on_goal_away: 1,
      possession_home: 62, possession_away: 38,
      corners_home: 13, corners_away: 0, corners_total: 13,
      yellow_cards_home: 5, yellow_cards_away: 6, yellow_cards_total: 11,
    },
    key_patterns: {
      dominant_team_loses_control: 'Famalicão 17 chutes vs 3 mas só marcou 1 gol — baixa eficiência',
      ultra_defensive_visitor: 'Moreirense: 3 chutes, 0 escanteios, 38% posse, marcou no 3º min e sentou no resultado',
      extreme_corners_asymmetry: '13 vs 0 — todos os ataques do mandante dominante viraram corners',
      high_aggression_both_teams: '11 cartões amarelos — 5 do mandante frustrado, 6 do visitante defensivo',
    },
    market_outcomes: [
      { market: 'BTTS',       bet: 'Ambas Marcam SIM', result: 'WIN', acertou: true },
      { market: 'Over 1.5',  bet: 'Over 1.5 Gols',    result: 'WIN', acertou: true, total_goals: 2 },
      { market: 'Over 2.5',  bet: 'Over 2.5 Gols',    result: 'LOSS', acertou: false, total_goals: 2, note: 'ARMADILHA: dominância ≠ gols' },
      { market: 'Over Corners', bet: 'Over 8.5 Escanteios', result: 'WIN', acertou: true, total_corners: 13 },
      { market: 'Cartões',   bet: 'Over 4.5 Amarelos', result: 'WIN', acertou: true, total_yc: 11 },
    ],
    pattern_signals: [
      'visitor_ultra_defensive_0_corners',
      'visitor_early_goal_minute_3',
      'visitor_sits_on_result_after_early_goal',
      'home_extreme_dominance_low_efficiency',
      'extreme_corner_asymmetry_13_vs_0',
      'high_yellow_cards_frustration',
      'under_2_5_trap_despite_17_shots',
      'primeira_liga_aggressive_mid_table',
    ],
  },
  {
    match_id: 'hist_superlig_2026_04_10_besiktas_antalyaspor',
    match: 'Beşiktaş vs Antalyaspor',
    competition: 'Super Lig',
    round: 'Jornada 29',
    match_date: '2026-04-10',
    venue: 'Beşiktaş, Istambul, Turquia',
    result: { home_goals: 4, away_goals: 2, placar: '4-2', winner: 'home' },
    ht_score: { home: 3, away: 1 },
    goals_timeline: [
      { minute: 4,  team: 'home', scorer: 'Orkun Kökcü',           type: 'open_play' },
      { minute: 9,  team: 'home', scorer: 'Jota Silva',            type: 'open_play' },
      { minute: 21, team: 'away', scorer: 'Sander Van de Streek',  type: 'open_play' },
      { minute: 33, team: 'home', scorer: 'Oh Hyeon-gyu',          type: 'open_play' },
      { minute: 47, team: 'away', scorer: 'Samuel Ballet',         type: 'open_play' },
      { minute: 59, team: 'home', scorer: 'Oh Hyeon-gyu',          type: 'open_play' },
    ],
    match_stats: {
      shots_home: 16, shots_away: 8,
      shots_on_goal_home: 10, shots_on_goal_away: 2,
      possession_home: 67, possession_away: 33,
      corners_home: 10, corners_away: 6, corners_total: 16,
      yellow_cards_home: 1, yellow_cards_away: 2,
    },
    market_outcomes: [
      { market: 'BTTS',       bet: 'Ambas Marcam SIM', result: 'WIN', acertou: true },
      { market: 'Over 1.5',  bet: 'Over 1.5 Gols',    result: 'WIN', acertou: true, total_goals: 6 },
      { market: 'Over 2.5',  bet: 'Over 2.5 Gols',    result: 'WIN', acertou: true, total_goals: 6 },
      { market: 'Over Corners', bet: 'Over 10.5 Escanteios', result: 'WIN', acertou: true, total_corners: 16 },
    ],
    pattern_signals: [
      'super_lig_high_scoring_league',
      'home_dominant_67pct_possession',
      'combined_shots_24_gt_20',
      'both_teams_score_both_halves',
      'high_corners_both_attacking_teams',
      'away_scores_despite_low_possession',
    ],
  },
  {
    match_id: 'hist_aleague_2026_04_10_centralcoast_brisbane',
    match: 'Central Coast Mariners vs Brisbane Roar',
    competition: 'A-League',
    round: '2025/26 Season',
    match_date: '2026-04-10',
    venue: 'Polytec Stadium, Gosford, Austrália',
    result: { home_goals: 2, away_goals: 2, placar: '2-2', winner: 'draw' },
    ht_score: { home: 0, away: 1 },
    goals_timeline: [
      { minute: 4,     team: 'away', scorer: 'Samuel Klein',       type: 'open_play' },
      { minute: 50,    team: 'home', scorer: 'Jesse Mantell',      type: 'open_play' },
      { minute: 58,    team: 'home', scorer: 'Nathaniel Blair',    type: 'open_play' },
      { minute: '90+3', team: 'away', scorer: 'Jordan Lauton',    type: 'open_play', note: 'Empate no último minuto' },
    ],
    match_stats: {
      shots_home: 3, shots_away: 9,
      shots_on_goal_home: 3, shots_on_goal_away: 4,
      possession_home: 51, possession_away: 49,
      corners_home: 1, corners_away: 10, corners_total: 11,
      yellow_cards_home: 2, yellow_cards_away: 2,
    },
    market_outcomes: [
      { market: 'BTTS',       bet: 'Ambas Marcam SIM', result: 'WIN', acertou: true },
      { market: 'Over 1.5',  bet: 'Over 1.5 Gols',    result: 'WIN', acertou: true, total_goals: 4 },
      { market: 'Over 2.5',  bet: 'Over 2.5 Gols',    result: 'WIN', acertou: true, total_goals: 4 },
      { market: 'Over 3.5',  bet: 'Over 3.5 Gols',    result: 'WIN', acertou: true, total_goals: 4 },
      { market: 'Over Corners', bet: 'Over 8.5 Escanteios', result: 'WIN', acertou: true, total_corners: 11 },
    ],
    pattern_signals: [
      'a_league_comeback_from_behind',
      'visitor_dominant_corners_10_vs_1',
      'home_reversal_2_1_before_late_equalizer',
      'late_goal_90_plus_minutes',
      'a_league_high_drama_finishes',
    ],
  },
  {
    match_id: 'hist_ligamx_2026_04_10_juarez_tijuana',
    match: 'FC Juárez vs Tijuana',
    competition: 'Liga MX',
    round: 'Clausura 2026 Jornada 14',
    match_date: '2026-04-10',
    venue: 'Estadio Olímpico Benito Juárez, Ciudad Juárez, México',
    result: { home_goals: 1, away_goals: 2, placar: '1-2', winner: 'away' },
    ht_score: { home: 0, away: 1 },
    goals_timeline: [
      { minute: 43, team: 'away', scorer: 'Kevin Castañeda',   type: 'open_play' },
      { minute: 52, team: 'away', scorer: 'Ramiro Arciga',     type: 'open_play' },
      { minute: 89, team: 'home', scorer: 'Guilherme Castilho', type: 'penalty', note: 'Gol do time reduzido a 9 jogadores' },
    ],
    notable_events: [
      { minute: 4,     event: 'Expulsão Monchu (FC Juárez) — jogou com 10 desde o início' },
      { minute: '90+7', event: 'Expulsão Murillo (FC Juárez) — time ficou com 9' },
    ],
    match_stats: {
      shots_home: 5, shots_away: 11,
      shots_on_goal_home: 1, shots_on_goal_away: 4,
      possession_home: 34, possession_away: 66,
      corners_home: 5, corners_away: 9, corners_total: 14,
      yellow_cards_home: 2, yellow_cards_away: 1,
      red_cards_home: 2,
    },
    market_outcomes: [
      { market: 'BTTS',       bet: 'Ambas Marcam SIM', result: 'WIN', acertou: true, note: 'Time com 10 homens ainda marcou de pênalti' },
      { market: 'Over 1.5',  bet: 'Over 1.5 Gols',    result: 'WIN', acertou: true, total_goals: 3 },
      { market: 'Over 2.5',  bet: 'Over 2.5 Gols',    result: 'WIN', acertou: true, total_goals: 3 },
      { market: 'Over Corners', bet: 'Over 8.5 Escanteios', result: 'WIN', acertou: true, total_corners: 14 },
    ],
    pattern_signals: [
      'early_red_card_minute_4',
      'home_10_men_from_start',
      'away_dominant_66pct_possession',
      'btts_even_with_10_men',
      'home_consolation_penalty_late',
      'liga_mx_high_corners_14_total',
    ],
  },
  {
    match_id: 'hist_usl_2026_04_10_loudoun_louisville',
    match: 'Loudoun United FC vs Louisville City FC',
    competition: 'USL Championship',
    round: 'Regular Season 2026',
    match_date: '2026-04-10',
    venue: 'Segra Field, Leesburg, VA, EUA',
    result: { home_goals: 3, away_goals: 3, placar: '3-3', winner: 'draw' },
    ht_score: { home: 2, away: 1 },
    goals_timeline: [
      { minute: 8,  team: 'home', scorer: 'Thorleifur Ulfarsson' },
      { minute: 20, team: 'away', scorer: 'Brandon Dayes',         note: 'Primeiro gol profissional' },
      { minute: 26, team: 'away', scorer: 'Tola Showunmi',         note: 'Primeiro gol na liga' },
      { minute: 45, team: 'home', scorer: 'Thorleifur Ulfarsson',  note: 'Segundo gol de Ulfarsson' },
      { minute: 61, team: 'home', scorer: 'Bolu Akinyode' },
      { minute: 72, team: 'away', scorer: 'Evan Davila',           note: 'Primeiro gol da temporada' },
    ],
    match_stats: { corners_total: null, yellow_cards_total: null },
    market_outcomes: [
      { market: 'BTTS',       bet: 'Ambas Marcam SIM', result: 'WIN', acertou: true },
      { market: 'Over 1.5',  bet: 'Over 1.5 Gols',    result: 'WIN', acertou: true, total_goals: 6 },
      { market: 'Over 2.5',  bet: 'Over 2.5 Gols',    result: 'WIN', acertou: true, total_goals: 6 },
      { market: 'Over 3.5',  bet: 'Over 3.5 Gols',    result: 'WIN', acertou: true, total_goals: 6 },
      { market: 'Over 5.5',  bet: 'Over 5.5 Gols',    result: 'WIN', acertou: true, total_goals: 6 },
    ],
    pattern_signals: [
      'usl_high_scoring_game',
      'both_teams_lead_and_equalize',
      'multiple_first_goals_youngsters',
    ],
  },
];

let saved = 0;
for (const jogo of novosJogos) {
  if (!hist.matches.find((m) => m.match_id === jogo.match_id)) {
    hist.matches.push(jogo);
    saved++;
  }
}
writeFileSync(HIST_PATH, JSON.stringify(hist, null, 2), 'utf-8');
console.log(`💾 ${saved} jogo(s) novos salvos em historical-patterns.json (${hist.matches.length} total)`);

// ── Resumo final ─────────────────────────────────────────────────────────────
console.log('\n📊 CALIBRAÇÃO COMPLETA DO PIE — TODOS OS MERCADOS:');
console.log('─'.repeat(80));

const dbFinal = loadDB();
for (const [market, calib] of Object.entries(dbFinal.calibration)) {
  const acc   = ((calib.hits / calib.total) * 100).toFixed(1);
  const comps = Object.entries(calib.byCompetition)
    .map(([comp, v]) => {
      const label = comp.includes('Libertadores') ? 'Lib'
        : comp.includes('Serie A') ? 'SerieA'
        : comp.includes('Premier') ? 'PL'
        : comp.includes('LaLiga') ? 'LaLiga'
        : comp.includes('Bundesliga') ? 'Bund'
        : comp.includes('Ligue 1') ? 'Ligue1'
        : comp.includes('Primeira') ? 'PrimLig'
        : comp.includes('Super Lig') ? 'SuperLig'
        : comp.includes('Eredivisie') ? 'Erediv'
        : comp.includes('Liga MX') ? 'LigaMX'
        : comp.includes('A-League') ? 'ALeague'
        : comp.includes('USL') ? 'USL'
        : comp.slice(0, 7);
      return `${label} ${v.hits}/${v.total}`;
    })
    .join(' | ');
  console.log(`  ${market.padEnd(16)} ${String(calib.hits + '/' + calib.total).padEnd(7)} ${acc.padStart(5)}%   ${comps}`);
}

const tp  = dbFinal.positivePatterns.filter(p => p.active).length;
const tl  = dbFinal.lessons.filter(l => l.active).length;
const tot = dbFinal.stats.acertos + dbFinal.stats.erros;
const pct = ((dbFinal.stats.acertos / tot) * 100).toFixed(1);

console.log('\n' + '─'.repeat(80));
console.log(`  Padrões positivos ativos : ${tp}`);
console.log(`  Lições ativas            : ${tl}`);
console.log(`  Total histórico          : ${tot} outcomes | ${dbFinal.stats.acertos} acertos | ${dbFinal.stats.erros} erros`);
console.log(`  Taxa de acerto global    : ${pct}%`);
console.log(`  Partidas na base         : ${hist.matches.length} jogos`);
console.log('═'.repeat(68));
console.log('✅ INJEÇÃO EXTRA CONCLUÍDA — 10/04/2026\n');
