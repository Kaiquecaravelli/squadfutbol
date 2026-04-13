/**
 * inject-cusco-flamengo-lessons.js
 * Padrões históricos: Cusco FC 0-2 Flamengo — Copa Libertadores 08/04/2026
 */

import { readFileSync, writeFileSync } from 'fs';
import { saveLesson, savePositiveLesson, loadDB } from '../src/pie/pie-storage.js';

const DB_PATH   = 'data/pie.json';
const HIST_PATH = 'data/historical-patterns.json';
const PRED_ID   = 'historical_seed_libertadores_2026_04_08_cusco_flamengo';

console.log('\n🧠 PIE — Injeção: Cusco FC 0-2 Flamengo (Libertadores)');
console.log('═'.repeat(55));

// ── Padrões Positivos ────────────────────────────────────────────────────────
const positivos = [
  {
    market: 'Resultado Final',
    competition: 'Copa Libertadores',
    directive: 'PADRÃO HISTÓRICO CONFIRMADO — Resultado 2 (visitante elite): Quando visitante é Campeão defensor da Libertadores (Pot 1) E mandante é fraco domesticamente (≥10º na liga local, >50% derrotas), vitória do visitante tem confiança muito alta. Altitude extrema (>3.000m) NÃO anula a diferença de qualidade quando o gap é muito grande. Flamengo (campeão 2025, elite) venceu Cusco (13º Peru) por 0-2 a 3.350m.',
  },
  {
    market: 'Over 1.5',
    competition: 'Copa Libertadores',
    directive: 'PADRÃO HISTÓRICO CONFIRMADO — Over 1.5 com elite em altitude: Visitante de elite com >14 chutes/jogo + rodada 1 da fase de grupos = Over 1.5 confiável mesmo em altitude extrema. PADRÃO DE ALTITUDE: gols tendem a ocorrer na 2ª metade (Flamengo marcou 59 e 90+2). Over 1.5 seguro; Over 2.5 requer mais cautela em altitude >3000m.',
  },
  {
    market: 'Over Corners',
    competition: 'Copa Libertadores',
    directive: 'PADRÃO HISTÓRICO CONFIRMADO — Over 6.5 corners: Flamengo tem média de ~9.82 corners/jogo fora. Com 27 chutes combinados no jogo (8+19) + alas dominantes (Ayrton Lucas) + mandante defensivo = 12 corners totais. Over 6.5 muito confiável quando visitante tem corners_fora_media > 8 E chutes_combinados_esperados > 22.',
  },
  {
    market: null,
    competition: 'Copa Libertadores',
    directive: 'PADRÃO CROSS-MARKET Libertadores — Altitude + Elite: Em jogos em altitude extrema (>3.000m), times de elite visitantes: (1) Gerenciam o 1º tempo e aceleram quando o time local cansa no 2º. (2) Gols concentram-se na 2ª metade. (3) Não perdem para times fracos locais (13º ou abaixo na liga). Favorece simultaneamente: Resultado 2 + Over 1.5 + Over Corners.',
  },
];

positivos.forEach((p) => {
  savePositiveLesson({ market: p.market, competition: p.competition, directive: p.directive, predictionId: PRED_ID });
  console.log(`✅ Positivo injetado : ${p.market || 'cross-market'}`);
});

// ── Lições de Calibração ─────────────────────────────────────────────────────
const licoes = [
  {
    market: 'Resultado Final',
    competition: 'Copa Libertadores',
    errorType: 'calibration',
    directive: 'CALIBRAÇÃO Copa Libertadores — Altitude não neutraliza qualidade: Quando visitante é Pot 1/Campeão defensor e mandante está na ≥10ª posição na liga local, elevar probabilidade de Resultado 2 em +12pp mesmo em altitude extrema (>3.000m). O gap de qualidade supera o fator altitude nesse cenário.',
  },
  {
    market: 'Over Corners',
    competition: 'Copa Libertadores',
    errorType: 'calibration',
    directive: 'CALIBRAÇÃO Over Corners Libertadores: Quando visitante tem corners_fora_media >= 8/jogo, considerar linha Over 6.5 como FAVORITA independente do mandante. Flamengo sozinho contribuiu com 7 corners em Cusco — a média do visitante por si só já supera a linha de 6.5. Usar corners_media_visitante_fora como indicador primário.',
  },
  {
    market: 'Over 1.5',
    competition: 'Copa Libertadores',
    errorType: 'calibration',
    directive: 'CALIBRAÇÃO Altitude Copa Libertadores: Em jogos em altitude >3.000m (Cusco, La Paz, Quito), preferir Over 1.5 ao invés de Over 2.5 como mercado de gols padrão quando visitante é elite. O ritmo mais lento reduz o volume de gols mas não zera — 1 ou 2 gols de qualidade são suficientes para Over 1.5. Não usar Over 2.5 automaticamente em altitude sem dados específicos.',
  },
  {
    market: null,
    competition: 'Copa Libertadores',
    errorType: 'calibration',
    directive: 'CALIBRAÇÃO Timing de gols em altitude (Copa Libertadores): Em jogos em altitude >3.000m, gols de visitantes elite tendem a ocorrer na 2ª metade (o time local cansa com o oxigênio reduzido). Mercados de 1ª metade (HT result, Over 0.5 1ª metade) devem receber probabilidade reduzida. Mercados de 2ª metade ou resultado final são mais seguros.',
  },
];

licoes.forEach((l) => {
  saveLesson({ market: l.market, competition: l.competition, directive: l.directive, errorType: l.errorType, predictionId: PRED_ID });
  console.log(`📚 Lição injetada   : ${l.market || 'cross-market'}`);
});

// ── Calibração Numérica ──────────────────────────────────────────────────────
const db = loadDB();

const outcomes = [
  { market: 'Resultado Final', probabilidade: 75, acertou: true, competition: 'Copa Libertadores' },
  { market: 'Over 1.5',        probabilidade: 80, acertou: true, competition: 'Copa Libertadores' },
  { market: 'Over Corners',    probabilidade: 78, acertou: true, competition: 'Copa Libertadores' },
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

// ── Salvar em historical-patterns.json ──────────────────────────────────────
const hist = JSON.parse(readFileSync(HIST_PATH, 'utf-8'));

const novoJogo = {
  match_id: 'hist_libertadores_2026_04_08_cusco_flamengo',
  match: 'Cusco FC vs Flamengo',
  competition: 'Copa Libertadores',
  group: 'Grupo A',
  round: 'Rodada 1',
  match_date: '2026-04-08T21:30:00.000Z',
  venue: 'Estádio Inca Garcilaso de la Vega, Cusco, Peru',
  altitude_meters: 3350,
  altitude_factor: true,
  result: {
    home_goals: 0,
    away_goals: 2,
    placar: '0-2',
    winner: 'away',
  },
  goals_timeline: [
    { minute: 59,    team: 'away', scorer: 'Bruno Henrique',       assist: 'Ayrton Lucas (cruzamento)', type: 'header' },
    { minute: '90+2', team: 'away', scorer: 'Giorgian De Arrascaeta', assist: 'rebote do goleiro',       type: 'header' },
  ],
  notable_events: [
    { minute: null, event: 'Gol de Marlon Ruidías (Cusco) anulado por impedimento milimétrico via VAR' },
    { minute: null, event: 'Pênalti para Cusco revertido via VAR (pisão de Gonzalo Plata)' },
  ],
  pre_match: {
    home: {
      team: 'Cusco FC',
      position_domestic: 13,
      competition_domestic: 'Liga 1 Peru',
      pts: 7,
      matches: 7,
      record: { wins: 2, draws: 1, losses: 4 },
      altitude_home_advantage: true,
      altitude_meters: 3350,
    },
    away: {
      team: 'Flamengo',
      libertadores_champion_2025: true,
      pot_libertadores: 1,
      brasileirao_position: 4,
      brasileirao_record: { wins: 5, draws: 2, losses: 2, matches: 9 },
      corners_away_avg: 9.82,
      key_players: ['Bruno Henrique', 'Giorgian De Arrascaeta', 'Ayrton Lucas', 'Gonzalo Plata', 'Lucas Paquetá'],
    },
  },
  match_stats: {
    shots_home: 8,
    shots_away: 19,
    shots_on_goal_home: 2,
    shots_on_goal_away: 6,
    possession_home: 50.5,
    possession_away: 49.5,
    corners_home: 5,
    corners_away: 7,
    corners_total: 12,
    saves_home: 5,
    saves_away: 1,
    yellow_cards_home: 2,
    yellow_cards_away: 0,
  },
  market_outcomes: [
    { market: 'Over 1.5',     bet: 'Over 1.5 Gols', result: 'WIN', acertou: true, total_goals: 2 },
    { market: 'Resultado 2',  bet: 'Vitória Flamengo', result: 'WIN', acertou: true },
    { market: 'Over 6.5 Corners', bet: 'Over 6.5 Escanteios', result: 'WIN', acertou: true, total_corners: 12 },
  ],
  pattern_signals: [
    'away_libertadores_defending_champion',
    'away_pot1_libertadores',
    'home_domestic_weak_position_gte_10',
    'home_low_win_rate',
    'altitude_extreme_gt_3000m',
    'altitude_goals_second_half_bias',
    'away_high_shots_volume',
    'away_corners_away_avg_gt_8',
    'combined_shots_gt_25',
    'away_dominant_wingers',
    'var_controversy_both_sides',
    'goals_concentrated_second_half',
  ],
};

if (!hist.matches.find((m) => m.match_id === novoJogo.match_id)) {
  hist.matches.push(novoJogo);
  writeFileSync(HIST_PATH, JSON.stringify(hist, null, 2), 'utf-8');
  console.log('\n💾 Jogo salvo em historical-patterns.json');
} else {
  console.log('\n⚠️  Jogo já existe — pulado.');
}

// ── Resumo ────────────────────────────────────────────────────────────────────
console.log('\n📊 Calibração completa do PIE:');
const dbFinal = loadDB();
for (const [market, calib] of Object.entries(dbFinal.calibration)) {
  const acc = ((calib.hits / calib.total) * 100).toFixed(1);
  const comps = Object.entries(calib.byCompetition)
    .map(([c, v]) => `${c.replace('Copa Libertadores','Lib').replace('Serie A','SA')} ${v.hits}/${v.total}`)
    .join(' | ');
  console.log(`  ${market.padEnd(22)} ${calib.hits}/${calib.total} (${acc}%)  ${comps}`);
}
console.log('\n' + '═'.repeat(55));
console.log('✅ INJEÇÃO COMPLETA — Cusco 0-2 Flamengo\n');
