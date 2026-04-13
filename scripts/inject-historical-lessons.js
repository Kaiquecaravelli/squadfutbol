/**
 * inject-historical-lessons.js
 * Injeta padrões históricos coletados manualmente no PIE como lições e calibração.
 * Uso: node scripts/inject-historical-lessons.js
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  loadDB,
  saveLesson,
  savePositiveLesson,
} from '../src/pie/pie-storage.js';
import { writeFileSync } from 'fs';

const __dir = dirname(fileURLToPath(import.meta.url));
const PATTERNS_PATH = join(__dir, '../data/historical-patterns.json');
const DB_PATH       = join(__dir, '../data/pie.json');

// ── Carrega padrões históricos ────────────────────────────────────────────────
const patterns = JSON.parse(readFileSync(PATTERNS_PATH, 'utf-8'));

console.log('\n🧠 PIE — Injeção de Lições Históricas');
console.log('═'.repeat(50));
console.log(`Partidas no arquivo: ${patterns.matches.length}`);
console.log(`Mercados na biblioteca: ${Object.keys(patterns.pattern_library).length}\n`);

// ── 1. Injetar lições positivas por mercado ───────────────────────────────────
const positiveDirectives = [
  {
    market: 'Dupla Chance',
    competition: 'Serie A',
    directive: 'PADRÃO HISTÓRICO CONFIRMADO (2 amostras, 100% acerto): Quando favorito tem diferença de ≥5 posições na tabela + adversário com <0.8 gols/jogo + forma forte recente, Dupla Chance do favorito tem alta taxa de conversão. Exemplos: Lecce (17º) vs Atalanta (7º) → X2 WIN 0-3; Juventus (5º) vs Genoa (13º) → 1X WIN 2-0.',
  },
  {
    market: 'BTTS',
    competition: 'Serie A',
    directive: 'PADRÃO HISTÓRICO CONFIRMADO — BTTS Não (2 amostras, 100% acerto): Equipe com <0.7 gols/jogo + favorito concedendo <1.0/jogo = BTTS Não muito confiável. SINAL CRÍTICO: se equipe fraca não tem nenhuma finalização no gol durante o jogo, BTTS Não está virtualmente garantido (Lecce: 0 chutes no gol em 11 tentativas → 0-3).',
  },
  {
    market: 'Over 2.5',
    competition: 'Serie A',
    directive: 'PADRÃO HISTÓRICO CONFIRMADO (Serie A): Favorito com >1.5 gols/jogo + adversário com xGA >1.3/jogo + >14 chutes/jogo = Over 2.5 confiável. Atalanta (1.73 gols/jogo, xG forte) vs Lecce (xGA 1.48, defesa fraca) = 3 gols. Over 2.5 WIN.',
  },
  {
    market: 'Under 2.5',
    competition: 'Serie A',
    directive: 'PADRÃO HISTÓRICO CONFIRMADO (Serie A): Equipe visitante compacta com ≥3 empates away nos últimos 6 jogos + <1.0 gol/jogo fora = Under 2.5 defensável mesmo quando xG combinado supera 3.5. Genoa (3 empates away, 0.84 gols/jogo fora) vs Juventus = 2-0. Under 2.5 WIN mesmo com xG 3.57.',
  },
  {
    market: 'Over 1.5',
    competition: 'Serie A',
    directive: 'PADRÃO HISTÓRICO: Quando favorito forte joga em casa com >1.5 gols/jogo, Over 1.5 é mercado base de alta segurança. Juventus 2-0 Genoa confirma.',
  },
  {
    market: null, // cross-market
    competition: 'Serie A',
    directive: 'PADRÃO ESCANTEIOS HISTÓRICO — Under 8.5: Jogo muito desequilibrado (posse >15pp favorito) + equipe dominada com <3 corners/jogo → Under 8.5 corners. Atalanta dominou Lecce com 57.8% posse → apenas 7 corners totais. PADRÃO Over 8.5: Chutes combinados ≥25 + visitante linha baixa → Over 8.5. Juventus vs Genoa: 28 chutes, 10 corners totais.',
  },
];

let injectedPositive = 0;
for (const dir of positiveDirectives) {
  savePositiveLesson({
    market:       dir.market,
    competition:  dir.competition,
    directive:    dir.directive,
    predictionId: 'historical_seed_2026_04_06',
  });
  console.log(`✅ Padrão positivo injetado: ${dir.market || 'cross-market'}`);
  injectedPositive++;
}

// ── 2. Injetar lições de calibração (alertas para padrões específicos) ─────────
const calibrationLessons = [
  {
    market: 'BTTS',
    competition: null,
    errorType: 'calibration',
    directive: 'CALIBRAÇÃO HISTÓRICA: Em confrontos com grande desequilíbrio (favorito Top 8 vs adversário Bottom 5 na Serie A), BTTS Não ocorreu em 2/2 amostras. Elevar confiança do mercado BTTS Não em +10pp quando time_fraco_gols < 0.7 E favorito_concedidos < 1.0.',
  },
  {
    market: 'Dupla Chance',
    competition: null,
    errorType: 'calibration',
    directive: 'CALIBRAÇÃO HISTÓRICA Serie A: Dupla Chance do favorito quando gap tabela ≥5 posições resultou em 2/2 vitórias diretas (sem necessidade de empate). Odds de Dupla Chance nesses cenários representam value mesmo com odds baixas.',
  },
  {
    market: 'Over 2.5',
    competition: 'Serie A',
    errorType: 'calibration',
    directive: 'CALIBRAÇÃO HISTÓRICA Serie A — Over vs Under: Distinguir perfil do visitante. Visitante ofensivo com >1.2 gols/jogo fora → Over 2.5 mais provável. Visitante compacto/defensivo com <0.9 gols/jogo fora + histórico de empates → Under 2.5 mais provável. NÃO usar mesma probabilidade para ambos os perfis.',
  },
  {
    market: null,
    competition: 'Serie A',
    errorType: 'calibration',
    directive: 'CALIBRAÇÃO ESCANTEIOS HISTÓRICA Serie A: Não usar linha genérica de corners sem considerar perfil do jogo. Jogo muito desequilibrado (posse gap >15pp) tende para Under. Jogo com alto volume de chutes (≥25 combinados) tende para Over. Ajustar mercado de corners conforme equilíbrio da partida.',
  },
];

let injectedLessons = 0;
for (const lesson of calibrationLessons) {
  saveLesson({
    market:       lesson.market,
    competition:  lesson.competition,
    directive:    lesson.directive,
    errorType:    lesson.errorType,
    predictionId: 'historical_seed_2026_04_06',
  });
  console.log(`📚 Lição de calibração injetada: ${lesson.market || 'cross-market'}`);
  injectedLessons++;
}

// ── 3. Injetar calibração numérica direta ────────────────────────────────────
// Registra os acertos históricos na tabela de calibração para que getCalibrationFactor funcione
const db = loadDB();

const historicalOutcomes = [
  // Jogo 1: Lecce 0-3 Atalanta
  { market: 'Dupla Chance', probabilidade: 78, acertou: true,  competition: 'Serie A' },
  { market: 'BTTS',         probabilidade: 75, acertou: true,  competition: 'Serie A' },
  { market: 'Over 2.5',     probabilidade: 70, acertou: true,  competition: 'Serie A' },
  { market: 'Under 3.5',    probabilidade: 72, acertou: true,  competition: 'Serie A' },
  // Jogo 2: Juventus 2-0 Genoa
  { market: 'Dupla Chance', probabilidade: 75, acertou: true,  competition: 'Serie A' },
  { market: 'BTTS',         probabilidade: 68, acertou: true,  competition: 'Serie A' },
  { market: 'Under 2.5',    probabilidade: 60, acertou: true,  competition: 'Serie A' },
  { market: 'Over 1.5',     probabilidade: 82, acertou: true,  competition: 'Serie A' },
];

function probRange(prob) {
  if (prob >= 95) return '95+';
  if (prob >= 90) return '90-95';
  if (prob >= 85) return '85-90';
  if (prob >= 80) return '80-85';
  if (prob >= 70) return '70-80';
  if (prob >= 60) return '60-70';
  return '<60';
}

for (const o of historicalOutcomes) {
  if (!db.calibration[o.market]) {
    db.calibration[o.market] = { total: 0, hits: 0, byRange: {}, byCompetition: {} };
  }
  const c     = db.calibration[o.market];
  const range = probRange(o.probabilidade);
  const hit   = o.acertou ? 1 : 0;

  c.total++;
  c.hits += hit;

  if (!c.byRange[range]) c.byRange[range] = { total: 0, hits: 0 };
  c.byRange[range].total++;
  c.byRange[range].hits += hit;

  const comp = o.competition;
  if (!c.byCompetition[comp]) c.byCompetition[comp] = { total: 0, hits: 0 };
  c.byCompetition[comp].total++;
  c.byCompetition[comp].hits += hit;

  // Atualiza stats globais
  db.stats.acertos++;
}

db.stats.total += historicalOutcomes.length;
writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');

console.log(`\n📊 Calibração numérica registrada: ${historicalOutcomes.length} outcomes`);

// ── Resumo final ──────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(50));
console.log('✅ INJEÇÃO CONCLUÍDA');
console.log(`   Padrões positivos : ${injectedPositive}`);
console.log(`   Lições calibração : ${injectedLessons}`);
console.log(`   Outcomes históricos: ${historicalOutcomes.length}`);
console.log('\nMercados com calibração agora:');

const dbFinal = loadDB();
for (const [market, calib] of Object.entries(dbFinal.calibration)) {
  const acc = calib.total > 0 ? ((calib.hits / calib.total) * 100).toFixed(1) : '—';
  console.log(`   ${market.padEnd(20)} ${calib.hits}/${calib.total} acertos (${acc}%)`);
}
console.log('═'.repeat(50) + '\n');
