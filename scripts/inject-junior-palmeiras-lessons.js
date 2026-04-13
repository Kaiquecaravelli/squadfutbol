/**
 * inject-junior-palmeiras-lessons.js
 * Padrões históricos: Junior Barranquilla 1-1 Palmeiras — Copa Libertadores 08/04/2026
 */

import { readFileSync, writeFileSync } from 'fs';
import { saveLesson, savePositiveLesson, loadDB } from '../src/pie/pie-storage.js';

const DB_PATH   = 'data/pie.json';
const HIST_PATH = 'data/historical-patterns.json';
const PRED_ID   = 'historical_seed_libertadores_2026_04_08_junior_palmeiras';

console.log('\n🧠 PIE — Injeção: Junior 1-1 Palmeiras (Libertadores)');
console.log('═'.repeat(55));

// ── Padrões Positivos ────────────────────────────────────────────────────────
const positivos = [
  {
    market: 'Dupla Chance',
    competition: 'Copa Libertadores',
    directive: 'PADRÃO HISTÓRICO CONFIRMADO — X2 visitante elite fora: Quando visitante é líder da liga doméstica (Palmeiras 1º Brasileirão, 8V em 10 jogos) E mandante é fraco domesticamente (Junior form 47/100) E visitante domina os números (22 chutes, 56% posse, 11 corners), X2 é CONFIANÇA MUITO ALTA. Mesmo perdendo 0-1 por pênalti precoce, Palmeiras igualou — X2 WIN 1-1.',
  },
  {
    market: 'Over 1.5',
    competition: 'Copa Libertadores',
    directive: 'PADRÃO HISTÓRICO CONFIRMADO — Over 1.5 com elite atacante: Palmeiras tem 2,1 gols/jogo no Brasileirão e média histórica de 1,95 gols/jogo na Libertadores. Com 22 chutes no jogo, Over 1.5 era quase automático. REFORÇO: pênalti precoce do mandante (minuto 10) garantiu 1 gol já nos primeiros minutos — visitante de elite sempre responde. Junior 1-1 Palmeiras — Over 1.5 WIN.',
  },
  {
    market: null,
    competition: 'Copa Libertadores',
    directive: 'PADRÃO CROSS-MARKET NOVO — Pênalti Precoce + Visitante Elite = X2 + Over 1.5: Quando mandante mais fraco marca por pênalti nos primeiros 15 minutos contra visitante de elite, o padrão é: visitante reage com volume (22 chutes) mas gerencia com cautela → empata na 2ª metade mas não completa a virada → resultado quase certo é EMPATE (X2) + 2 gols (Over 1.5). Aplicável sempre que mandante ≤ top10 liga + visitante = top3 liga forte + pênalti antes de 15 minutos.',
  },
  {
    market: 'Over Corners',
    competition: 'Copa Libertadores',
    directive: 'PADRÃO HISTÓRICO — Over Corners com Palmeiras dominante: Palmeiras marcou 11 corners sozinho (total 13) ao dominar com 22 chutes e estilo de jogo lateral com alas. Quando Palmeiras joga com domínio completo fora (>15 chutes, >55% posse), Over 8,5 corners é muito confiável. Padrão identificado em Junior 1-1 Palmeiras (08/04/2026).',
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
    directive: 'CALIBRAÇÃO X2 Libertadores — Visitante líder de liga forte: Palmeiras (57,25% aproveitamento histórico na Libertadores, líder do Brasileirão) jogando fora vs time colombiano/peruano/equatoriano de nível médio = X2 com probabilidade elevada. Elevar X2 em +10pp quando visitante está top3 de liga brasileira/argentina E mandante form < 55/100.',
  },
  {
    market: 'Over 1.5',
    competition: 'Copa Libertadores',
    errorType: 'calibration',
    directive: 'CALIBRAÇÃO Over 1.5 — Palmeiras na Libertadores: Com média histórica de 1,95 gols/partida na Libertadores (melhor da história) e 2,1 gols/jogo no Brasileirão 2026, qualquer jogo de Palmeiras na Libertadores tem Over 1.5 como mercado base de altíssima confiança. Probabilidade mínima: 80%. Elevar para 88%+ quando adversário tem defesa fraca (>1,2 gols sofridos/jogo).',
  },
  {
    market: null,
    competition: 'Copa Libertadores',
    errorType: 'calibration',
    directive: 'CALIBRAÇÃO PÊNALTI PRECOCE Copa Libertadores: Quando mandante marca por pênalti antes de 15 minutos contra visitante elite, NÃO reduzir confiança de X2 ou Over 1.5. O visitante de qualidade sempre responde na 2ª metade — o pênalti precoce favorece o empate (X2) e confirma Over 1.5. Dados: Junior 1-0 Palmeiras no 10, igualou 1-1 no 56.',
  },
  {
    market: 'Over Corners',
    competition: 'Copa Libertadores',
    errorType: 'calibration',
    directive: 'CALIBRAÇÃO Over Corners Palmeiras fora: Palmeiras gerou 11 corners com 22 chutes. Padrão: equipe com >15 chutes/jogo que ataca pelas laterais = Over 8,5 corners muito confiável. Quando adversário defende com bloco baixo, cada cruzamento que não entra vira corner — amplifica o total. Considerar Over 8,5 como mercado secundário padrão em jogos de Palmeiras com domínio territorial.',
  },
];

licoes.forEach((l) => {
  saveLesson({ market: l.market, competition: l.competition, directive: l.directive, errorType: l.errorType, predictionId: PRED_ID });
  console.log(`📚 Lição injetada   : ${l.market || 'cross-market'}`);
});

// ── Calibração Numérica ──────────────────────────────────────────────────────
const db = loadDB();

const outcomes = [
  { market: 'Dupla Chance', probabilidade: 76, acertou: true, competition: 'Copa Libertadores' },
  { market: 'Over 1.5',     probabilidade: 82, acertou: true, competition: 'Copa Libertadores' },
  { market: 'Over Corners', probabilidade: 74, acertou: true, competition: 'Copa Libertadores' },
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
console.log('\n📊 Calibração numérica registrada: ' + outcomes.length + ' outcomes');

// ── Salvar em historical-patterns.json ──────────────────────────────────────
const hist = JSON.parse(readFileSync(HIST_PATH, 'utf-8'));

const novoJogo = {
  match_id: 'hist_libertadores_2026_04_08_junior_palmeiras',
  match: 'Junior Barranquilla vs Palmeiras',
  competition: 'Copa Libertadores',
  group: 'Grupo F',
  round: 'Rodada 1',
  match_date: '2026-04-08T21:30:00.000Z',
  venue: 'Estádio Olímpico Jaime Morón León, Cartagena, Colombia',
  note: 'Junior jogou em Cartagena, fora de seu estádio habitual (Barranquilla)',
  result: {
    home_goals: 1,
    away_goals: 1,
    placar: '1-1',
    winner: 'draw',
  },
  goals_timeline: [
    { minute: 10,  team: 'home', scorer: 'Teófilo Gutiérrez', type: 'penalty', assist: 'falta de Mauricio (Palmeiras)', note: 'Colombiano mais velho a marcar na Libertadores (+40 anos)' },
    { minute: 56,  team: 'away', scorer: 'Ramón Sosa',        type: 'open_play', assist: 'Felipe López' },
  ],
  pre_match: {
    home: {
      team: 'Junior Barranquilla',
      form_rating: 47,
      liga_colombia_recent: { wins: 0, draws: 1, losses: 2, matches: 4 },
      libertadores_unbeaten_streak_groups: 11,
      key_player: 'Teófilo Gutiérrez (+40 anos)',
    },
    away: {
      team: 'Palmeiras',
      brasileirao_position: 1,
      brasileirao_record: { wins: 8, draws: 1, losses: 1, matches: 10 },
      goals_scored_per_game: 2.1,
      libertadores_historical_win_rate_pct: 57.25,
      libertadores_goals_per_game_historical: 1.95,
      key_players: ['Ramón Sosa', 'Mauricio', 'Felipe López'],
    },
  },
  match_stats: {
    shots_home: 9,
    shots_away: 22,
    shots_on_goal_home: 3,
    shots_on_goal_away: 5,
    possession_home: 43.3,
    possession_away: 56.7,
    corners_home: 2,
    corners_away: 11,
    corners_total: 13,
    saves_home: 4,
    saves_away: 2,
    yellow_cards_home: 3,
    yellow_cards_away: 1,
  },
  market_outcomes: [
    { market: 'Over 1.5',     bet: 'Over 1.5 Gols',           result: 'WIN', acertou: true,  total_goals: 2 },
    { market: 'Dupla Chance', bet: 'X2 - Empate ou Palmeiras', result: 'WIN', acertou: true,  note: '1-1 = Empate contemplado no X2' },
    { market: 'Over Corners', bet: 'Over 8.5 Escanteios',      result: 'WIN', acertou: true,  total_corners: 13, note: 'Palmeiras sozinho marcou 11 corners' },
  ],
  pattern_signals: [
    'away_league_leader_domestic',
    'away_best_attack_league',
    'away_historical_libertadores_dominance',
    'home_weak_domestic_form',
    'home_libertadores_unbeaten_group_streak',
    'early_penalty_home_before_15min',
    'visitor_dominated_shots_22_vs_9',
    'visitor_dominated_corners_11_vs_2',
    'away_equalised_second_half',
    'home_played_outside_usual_stadium',
    'penalty_early_led_to_draw_not_loss',
    'visitor_high_volume_lateral_play',
  ],
};

if (!hist.matches.find((m) => m.match_id === novoJogo.match_id)) {
  hist.matches.push(novoJogo);
  writeFileSync(HIST_PATH, JSON.stringify(hist, null, 2), 'utf-8');
  console.log('💾 Jogo salvo em historical-patterns.json');
} else {
  console.log('⚠️  Jogo já existe — pulado.');
}

// ── Resumo final ─────────────────────────────────────────────────────────────
console.log('\n📊 Estado completo da calibração PIE:');
console.log('─'.repeat(70));

const dbFinal = loadDB();
for (const [market, calib] of Object.entries(dbFinal.calibration)) {
  const acc = ((calib.hits / calib.total) * 100).toFixed(1);
  const comps = Object.entries(calib.byCompetition)
    .map(([comp, v]) => {
      const label = comp.includes('Libertadores') ? 'Lib'
        : comp.includes('Serie A') || comp.includes('Premier') ? comp.split(' ')[0]
        : comp.slice(0, 6);
      return `${label} ${v.hits}/${v.total}`;
    })
    .join(' | ');
  console.log(`  ${market.padEnd(22)} ${String(calib.hits + '/' + calib.total).padEnd(6)} ${acc}%   ${comps}`);
}

const totalPatterns  = dbFinal.positivePatterns.filter(p => p.active).length;
const totalLessons   = dbFinal.lessons.filter(l => l.active).length;
const totalOutcomes  = dbFinal.stats.acertos + dbFinal.stats.erros;

console.log('\n' + '─'.repeat(70));
console.log(`  Padrões positivos ativos : ${totalPatterns}`);
console.log(`  Lições ativas            : ${totalLessons}`);
console.log(`  Outcomes históricos total: ${totalOutcomes} (${dbFinal.stats.acertos} acertos)`);
console.log('═'.repeat(55));
console.log('✅ INJEÇÃO COMPLETA — Junior 1-1 Palmeiras\n');
