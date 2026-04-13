/**
 * inject-libertadores-lessons.js
 * Injeta padrões históricos do jogo Coquimbo vs Nacional (Libertadores 08/04/2026) no PIE.
 */

import { readFileSync, writeFileSync } from 'fs';
import { saveLesson, savePositiveLesson, loadDB } from '../src/pie/pie-storage.js';

const DB_PATH = 'data/pie.json';
const PRED_ID = 'historical_seed_libertadores_2026_04_08';

console.log('\n🧠 PIE — Injeção: Coquimbo vs Nacional (Libertadores)');
console.log('═'.repeat(52));

// ── Padrões Positivos ────────────────────────────────────────────────────────
const positivos = [
  {
    market: 'Dupla Chance',
    competition: 'Copa Libertadores',
    directive: 'PADRÃO HISTÓRICO CONFIRMADO — X1 Copa Libertadores: Mandante campeão doméstico recente retornando a copa continental após longa ausência (≥10 anos) + gols em casa >1.5/jogo + visitante viajante internacional = X1 Dupla Chance ALTA CONFIANÇA. Coquimbo Unido (campeão Chile 2025, 34 anos sem Libertadores) vs Nacional URU (visitante) = 1-1. X1 WIN.',
  },
  {
    market: 'Over 1.5',
    competition: 'Copa Libertadores',
    directive: 'PADRÃO HISTÓRICO CONFIRMADO — Over 1.5 Rodada 1 Libertadores: Primeiro jogo da fase de grupos + mandante ofensivo em casa (>1.3 gols/jogo) + visitante de elite = Over 1.5 confiável. Coquimbo (1.9 gols/jogo em casa) vs Nacional URU = 2 gols. Se visitante marca antes de 22min, mandante abre o jogo e Over 1.5 se torna quase garantido.',
  },
  {
    market: null,
    competition: 'Copa Libertadores',
    directive: 'PADRÃO CROSS-MARKET Libertadores — Debutante Histórico: Equipe retornando a copa continental após ausência ≥10 anos joga em casa na Rodada 1 com motivação extraordinária. Nunca abandona o marcador mesmo perdendo. Favorece X1 + Over 1.5 simultaneamente. Gols tardios (minuto 85+) são comuns nesse perfil — Coquimbo igualou no 90+4.',
  },
];

positivos.forEach((p) => {
  savePositiveLesson({ market: p.market, competition: p.competition, directive: p.directive, predictionId: PRED_ID });
  console.log(`✅ Positivo injetado : ${p.market || 'cross-market'}`);
});

// ── Lições de Calibração ─────────────────────────────────────────────────────
const licoes = [
  {
    market: 'Dupla Chance',
    competition: 'Copa Libertadores',
    errorType: 'calibration',
    directive: 'CALIBRAÇÃO Libertadores — X1: Em rodadas iniciais (≤2) com mandante campeão doméstico recente, X1 confirmado. Elevar probabilidade X1 em +8pp quando mandante_campeao_domestico == true E visitante_internacional == true E rodada_grupo <= 2.',
  },
  {
    market: 'Over 1.5',
    competition: 'Copa Libertadores',
    errorType: 'calibration',
    directive: 'CALIBRAÇÃO Over 1.5 Libertadores Rodada 1: Fase de grupos com ambos os times motivados produz Over 1.5. REFORÇO: Se visitante marca nos primeiros 25 minutos, mandante é forçado a jogar aberto — ajustar probabilidade Over 1.5 para 85%+ neste cenário.',
  },
  {
    market: null,
    competition: 'Copa Libertadores',
    errorType: 'calibration',
    directive: 'CALIBRAÇÃO ESPECIAL Libertadores — Gol Tardio: Times mandantes com alta motivação histórica (debutantes, retornantes, campeões recentes) frequentemente equalizam em minutos finais. Não reduzir confiança de Over/X1 apenas porque o visitante marcou primeiro — o mandante continua perigoso até o apito final.',
  },
];

licoes.forEach((l) => {
  saveLesson({ market: l.market, competition: l.competition, directive: l.directive, errorType: l.errorType, predictionId: PRED_ID });
  console.log(`📚 Lição injetada   : ${l.market || 'cross-market'}`);
});

// ── Calibração Numérica ──────────────────────────────────────────────────────
const db = loadDB();

const outcomes = [
  { market: 'Over 1.5',     probabilidade: 78, acertou: true, competition: 'Copa Libertadores' },
  { market: 'Dupla Chance', probabilidade: 72, acertou: true, competition: 'Copa Libertadores' },
];

function probRange(p) {
  if (p >= 95) return '95+';
  if (p >= 90) return '90-95';
  if (p >= 85) return '85-90';
  if (p >= 80) return '80-85';
  if (p >= 70) return '70-80';
  if (p >= 60) return '60-70';
  return '<60';
}

for (const o of outcomes) {
  if (!db.calibration[o.market]) {
    db.calibration[o.market] = { total: 0, hits: 0, byRange: {}, byCompetition: {} };
  }
  const c = db.calibration[o.market];
  const range = probRange(o.probabilidade);
  const hit = o.acertou ? 1 : 0;

  c.total++; c.hits += hit;
  if (!c.byRange[range]) c.byRange[range] = { total: 0, hits: 0 };
  c.byRange[range].total++; c.byRange[range].hits += hit;
  if (!c.byCompetition[o.competition]) c.byCompetition[o.competition] = { total: 0, hits: 0 };
  c.byCompetition[o.competition].total++; c.byCompetition[o.competition].hits += hit;

  db.stats.acertos++; db.stats.total++;
}

writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');

// ── Adicionar ao historical-patterns.json ───────────────────────────────────
const HIST_PATH = 'data/historical-patterns.json';
const hist = JSON.parse(readFileSync(HIST_PATH, 'utf-8'));

const novoJogo = {
  match_id: 'hist_libertadores_2026_04_08_coquimbo_nacional',
  match: 'Coquimbo Unido vs Nacional (URU)',
  competition: 'Copa Libertadores',
  group: 'Grupo B',
  round: 'Rodada 1',
  match_date: '2026-04-08T19:00:00.000Z',
  venue: 'Estádio Francisco Sánchez Rumoroso, Coquimbo, Chile',
  referee: 'Raphael Claus (BRA)',
  result: {
    home_goals: 1,
    away_goals: 1,
    placar: '1-1',
    winner: 'draw',
  },
  goals_timeline: [
    { minute: 22,    team: 'away', scorer: 'Sebastián Coates',  assist: 'Nicolás Lodeiro', type: 'header_cross' },
    { minute: '90+4', team: 'home', scorer: 'Manuel Fernández', assist: 'Lucas Pratto (rebound)', type: 'rebound' },
  ],
  notable_events: [
    { minute: 64, event: 'Gol de Alejandro Azócar anulado por impedimento (Coquimbo)' },
  ],
  pre_match: {
    home: {
      team: 'Coquimbo Unido',
      domestic_champion_2025: true,
      years_absent_libertadores: 34,
      position_chile: 5,
      pts_chile: 12,
      matches_chile: 8,
      record_chile: { wins: 4, draws: 0, losses: 4 },
      goals_scored_avg: 1.38,
      goals_scored_home_avg: 1.90,
      unbeaten_streak: 4,
      wins_last5: 3,
    },
    away: {
      team: 'Nacional (URU)',
      domestic_champion_uruguay: true,
      pot_libertadores: 1,
      key_players: ['Sebastián Coates', 'Nicolás Lodeiro'],
      away_international: true,
    },
  },
  market_outcomes: [
    {
      market: 'Over 1.5',
      bet: 'Over 1.5 Gols',
      result: 'WIN',
      acertou: true,
      total_goals: 2,
    },
    {
      market: 'Dupla Chance X1',
      bet: 'Coquimbo ou Empate',
      result: 'WIN',
      acertou: true,
      note: 'Terminou 1-1 — Empate contemplado no X1',
    },
  ],
  pattern_signals: [
    'home_domestic_champion_recent',
    'home_historic_return_copa_continental',
    'home_goals_home_avg_gt_15',
    'away_international_travel',
    'libertadores_round_1_group_stage',
    'both_teams_motivated_first_match',
    'away_early_goal_forces_open_game',
    'home_late_equalizer_high_motivation',
    'home_unbeaten_streak_4',
  ],
};

if (!hist.matches.find((m) => m.match_id === novoJogo.match_id)) {
  hist.matches.push(novoJogo);
  writeFileSync(HIST_PATH, JSON.stringify(hist, null, 2), 'utf-8');
  console.log('\n💾 Jogo salvo em historical-patterns.json');
} else {
  console.log('\n⚠️  Jogo já existia em historical-patterns.json — pulado.');
}

// ── Resumo final ─────────────────────────────────────────────────────────────
console.log('\n📊 Calibração por competição:');
const dbFinal = loadDB();
for (const [market, calib] of Object.entries(dbFinal.calibration)) {
  const acc = ((calib.hits / calib.total) * 100).toFixed(1);
  const lib = calib.byCompetition['Copa Libertadores'];
  const sa  = calib.byCompetition['Serie A'];
  const libStr = lib ? ` | Libertadores ${lib.hits}/${lib.total}` : '';
  const saStr  = sa  ? ` | Serie A ${sa.hits}/${sa.total}` : '';
  console.log(`  ${market.padEnd(20)} ${calib.hits}/${calib.total} (${acc}%)${saStr}${libStr}`);
}
console.log('\n' + '═'.repeat(52));
console.log('✅ INJEÇÃO COMPLETA — Coquimbo vs Nacional\n');
