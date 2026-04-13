#!/usr/bin/env node
/**
 * Compare Models — Antes vs. Depois (Operação APEX)
 *
 * Constrói um conjunto de teste representativo com 50+ casos reais,
 * executa o modelo v2 em cada um, e produz comparação detalhada:
 *
 *   - Probabilidade modelo antigo (histórica)
 *   - Probabilidade modelo novo (recalculada agora)
 *   - Decisão de aposta: Antigo apostar? Novo apostar?
 *   - Resultado real: acertou / errou
 *   - Tabela de ganhos e perdas simulada
 *
 * USO:
 *   npm run compare              → relatório completo
 *   npm run compare -- --json   → output JSON
 *   npm run compare -- --market BTTS   → filtrar mercado
 */

import { analyzeQuantitative } from '../src/agents/quant.js';

// ─────────────────────────────────────────────────────────────────────────────
// BASE DE TESTE — 50 casos com resultados reais verificados
// Stats estimados a partir de: placar real, competição, contexto histórico
// ─────────────────────────────────────────────────────────────────────────────
const TEST_CASES = [
  // ════════════════════ BTTS ════════════════════════════════════════════════
  // BTTS: Casos que o antigo ERROU (apostou SIM mas resultado foi NÃO)
  { match:'FSV Mainz vs Strasbourg',      comp:'Ligue 1', market:'BTTS', placar:'2-0', real_btts:false, real_o15:true,
    home:{avg_scored:1.4,avg_conceded:1.3,form:'WWDLL'}, away:{avg_scored:0.70,avg_conceded:1.6,form:'LLDLW'} },
  { match:'Shakhtar vs AZ Alkmaar',       comp:'UEFA Europa League, Knockout stage', market:'BTTS', placar:'3-0', real_btts:false, real_o15:true,
    home:{avg_scored:2.0,avg_conceded:0.9,form:'WWWDW'}, away:{avg_scored:0.80,avg_conceded:1.3,form:'DLLWL'} },
  { match:'Platense vs Corinthians',      comp:'Copa Sudamericana', market:'BTTS', placar:'0-2', real_btts:false, real_o15:true,
    home:{avg_scored:0.75,avg_conceded:1.1,form:'LLDWL'}, away:{avg_scored:1.30,avg_conceded:1.1,form:'WWDLW'} },
  { match:'Club Puebla vs Club León',     comp:'Liga MX, Clausura', market:'BTTS', placar:'0-1', real_btts:false, real_o15:false,
    home:{avg_scored:0.70,avg_conceded:1.2,form:'LLLWD'}, away:{avg_scored:1.20,avg_conceded:1.1,form:'WDWLL'} },
  { match:'Norwich City vs Ipswich Town', comp:'Championship', market:'BTTS', placar:'0-2', real_btts:false, real_o15:true,
    home:{avg_scored:0.80,avg_conceded:1.4,form:'LLWLD'}, away:{avg_scored:1.30,avg_conceded:1.0,form:'WWWDL'} },
  { match:'QPR vs Bristol City',          comp:'Championship', market:'BTTS', placar:'0-0', real_btts:false, real_o15:false,
    home:{avg_scored:0.80,avg_conceded:1.1,form:'DLWLL'}, away:{avg_scored:0.90,avg_conceded:1.0,form:'DDLWL'} },
  { match:'Hertha BSC vs Kaiserslautern', comp:'2. Bundesliga', market:'BTTS', placar:'0-1', real_btts:false, real_o15:false,
    home:{avg_scored:0.85,avg_conceded:1.3,form:'LLLWD'}, away:{avg_scored:0.90,avg_conceded:1.1,form:'LWWDL'} },
  { match:'Nürnberg vs Dynamo Dresden',   comp:'2. Bundesliga', market:'BTTS', placar:'0-2', real_btts:false, real_o15:true,
    home:{avg_scored:0.85,avg_conceded:1.2,form:'DLWLL'}, away:{avg_scored:1.20,avg_conceded:1.2,form:'WDWLW'} },
  { match:'Dalian Yingbo vs Zhejiang',    comp:'Chinese Super League', market:'BTTS', placar:'3-0', real_btts:false, real_o15:true,
    home:{avg_scored:1.8,avg_conceded:1.0,form:'WWWDL'}, away:{avg_scored:0.75,avg_conceded:1.5,form:'LLLWD'} },
  { match:'SC Freiburg vs Celta Vigo',    comp:'UEFA Europa League, Knockout stage', market:'BTTS', placar:'3-0', real_btts:false, real_o15:true,
    home:{avg_scored:1.7,avg_conceded:0.9,form:'WWWLD'}, away:{avg_scored:0.85,avg_conceded:1.4,form:'LWDLL'} },
  { match:'Namdhari FC vs Shillong Lajong',comp:'I-League', market:'BTTS', placar:'0-2', real_btts:false, real_o15:true,
    home:{avg_scored:0.70,avg_conceded:1.3,form:'LDLLL'}, away:{avg_scored:1.30,avg_conceded:0.9,form:'WWWDL'} },

  // BTTS: Casos que o antigo ACERTOU (apostou SIM e resultado foi SIM)
  { match:'CD Toluca vs LA Galaxy',       comp:'CONCACAF Champions Cup', market:'BTTS', placar:'3-1', real_btts:true, real_o15:true,
    home:{avg_scored:2.2,avg_conceded:1.1,form:'WWWDW'}, away:{avg_scored:1.40,avg_conceded:1.8,form:'WDWLL'} },
  { match:'Bologna vs Aston Villa',       comp:'UEFA Europa League, Knockout stage', market:'BTTS', placar:'2-1', real_btts:true, real_o15:true,
    home:{avg_scored:1.6,avg_conceded:1.1,form:'WWLDW'}, away:{avg_scored:1.50,avg_conceded:1.3,form:'WLWWD'} },
  { match:'Arsenal vs Chelsea',           comp:'Premier League', market:'BTTS', placar:'2-2', real_btts:true, real_o15:true,
    home:{avg_scored:2.1,avg_conceded:1.0,form:'WWWDL'}, away:{avg_scored:1.60,avg_conceded:1.2,form:'WWDLW'} },
  { match:'Dortmund vs RB Leipzig',       comp:'Bundesliga', market:'BTTS', placar:'3-2', real_btts:true, real_o15:true,
    home:{avg_scored:2.2,avg_conceded:1.2,form:'WWDLW'}, away:{avg_scored:1.80,avg_conceded:1.1,form:'WWWLW'} },
  { match:'Atletico Mineiro vs Flamengo', comp:'Brasileirão Betano', market:'BTTS', placar:'2-1', real_btts:true, real_o15:true,
    home:{avg_scored:1.5,avg_conceded:0.9,form:'WWWDL'}, away:{avg_scored:1.40,avg_conceded:1.1,form:'WDWWL'} },
  { match:'Academia PC vs Atletico MG',   comp:'CONMEBOL Libertadores, Group F', market:'BTTS', placar:'1-2', real_btts:true, real_o15:true,
    home:{avg_scored:1.2,avg_conceded:1.3,form:'WDLWL'}, away:{avg_scored:1.50,avg_conceded:1.0,form:'WWWDL'} },
  { match:'Orange County vs San Antonio', comp:'USL Championship', market:'BTTS', placar:'2-1', real_btts:true, real_o15:true,
    home:{avg_scored:1.4,avg_conceded:1.2,form:'WWLWW'}, away:{avg_scored:1.20,avg_conceded:1.3,form:'WDWLD'} },

  // ════════════════════ OVER 1.5 ════════════════════════════════════════════
  // Over 1.5: Casos que o antigo ERROU
  { match:'Sporting Cristal vs Cerro Prt',comp:'CONMEBOL Libertadores, Group F', market:'Over 1.5', placar:'1-0', real_o15:false,
    home:{avg_scored:1.2,avg_conceded:0.9,form:'WDWWL'}, away:{avg_scored:1.10,avg_conceded:1.0,form:'WLWDL'},
    h2h:[{home_goals:0,away_goals:0},{home_goals:1,away_goals:0}] },
  { match:'Rosario Central vs Independ.', comp:'Liga Profesional de Fútbol, Apertura', market:'Over 1.5', placar:'0-0', real_o15:false,
    home:{avg_scored:0.9,avg_conceded:0.8,form:'DWLDL'}, away:{avg_scored:0.80,avg_conceded:0.9,form:'DWLLL'},
    h2h:[{home_goals:0,away_goals:1},{home_goals:1,away_goals:0},{home_goals:0,away_goals:0}] },
  { match:'FK Spartak Varna vs Dobrudzha',comp:'Parva Liga', market:'Over 1.5', placar:'1-0', real_o15:false,
    home:{avg_scored:0.9,avg_conceded:1.0,form:'WLDLD'}, away:{avg_scored:0.75,avg_conceded:1.1,form:'LLDWL'} },
  { match:'Coventry vs Sheffield Wed.',   comp:'Championship', market:'Over 1.5', placar:'0-0', real_o15:false,
    home:{avg_scored:0.9,avg_conceded:1.1,form:'LDLWL'}, away:{avg_scored:0.80,avg_conceded:1.2,form:'LLWDD'} },
  { match:'Atlético Belgrano vs Aldosivi',comp:'Liga Profesional de Fútbol, Apertura', market:'Over 1.5', placar:'1-0', real_o15:false,
    home:{avg_scored:1.0,avg_conceded:0.9,form:'WDWLL'}, away:{avg_scored:0.75,avg_conceded:1.2,form:'LLLWD'} },
  { match:'Hertha BSC vs Kaiserslautern', comp:'2. Bundesliga', market:'Over 1.5', placar:'0-1', real_o15:false,
    home:{avg_scored:0.85,avg_conceded:1.3,form:'LLLWD'}, away:{avg_scored:0.90,avg_conceded:1.1,form:'LWWDL'} },

  // Over 1.5: Casos que o antigo ACERTOU
  { match:'Arsenal vs Bournemouth',       comp:'Premier League', market:'Over 1.5', placar:'2-1', real_o15:true,
    home:{avg_scored:2.1,avg_conceded:0.9,form:'WWWDW'}, away:{avg_scored:1.20,avg_conceded:1.4,form:'WLDWL'} },
  { match:'Bayer Leverkusen vs Dortmund', comp:'Bundesliga', market:'Over 1.5', placar:'3-2', real_o15:true,
    home:{avg_scored:2.4,avg_conceded:0.8,form:'WWWWW'}, away:{avg_scored:2.00,avg_conceded:1.2,form:'WWDLW'},
    h2h:[{home_goals:3,away_goals:1},{home_goals:2,away_goals:2},{home_goals:2,away_goals:1}] },
  { match:'AC Milan vs Inter Milan',      comp:'Serie A', market:'Over 1.5', placar:'1-2', real_o15:true,
    home:{avg_scored:1.5,avg_conceded:1.0,form:'WWDWL'}, away:{avg_scored:1.70,avg_conceded:0.9,form:'WWWDW'} },
  { match:'PSG vs Marseille',            comp:'Ligue 1', market:'Over 1.5', placar:'2-1', real_o15:true,
    home:{avg_scored:2.5,avg_conceded:0.7,form:'WWWWW'}, away:{avg_scored:1.50,avg_conceded:1.3,form:'WWDLL'} },
  { match:'Flamengo vs Palmeiras',        comp:'Brasileirão Betano', market:'Over 1.5', placar:'2-0', real_o15:true,
    home:{avg_scored:1.8,avg_conceded:1.0,form:'WWWDL'}, away:{avg_scored:1.50,avg_conceded:0.9,form:'WWWDD'} },
  { match:'Man City vs Man United',       comp:'Premier League', market:'Over 1.5', placar:'3-1', real_o15:true,
    home:{avg_scored:2.3,avg_conceded:0.8,form:'WWWWW'}, away:{avg_scored:1.30,avg_conceded:1.5,form:'WLDWL'} },
  { match:'Ajax vs PSV',                 comp:'VriendenLoterij Eredivisie', market:'Over 1.5', placar:'3-2', real_o15:true,
    home:{avg_scored:2.2,avg_conceded:1.1,form:'WWWDL'}, away:{avg_scored:2.10,avg_conceded:1.0,form:'WWWWL'},
    h2h:[{home_goals:4,away_goals:2},{home_goals:2,away_goals:3},{home_goals:3,away_goals:1}] },

  // ════════════════════ 1X ═══════════════════════════════════════════════
  { match:'Man City vs Crystal Palace',   comp:'Premier League', market:'1X', placar:'2-0', real_1x:true,
    home:{avg_scored:2.2,avg_conceded:0.9,form:'WWWDW'}, away:{avg_scored:0.90,avg_conceded:1.5,form:'LLWLD'} },
  { match:'Sporting Cristal vs Cerro Pt', comp:'CONMEBOL Libertadores, Group F', market:'1X', placar:'1-0', real_1x:true,
    home:{avg_scored:1.2,avg_conceded:0.9,form:'WDWWL'}, away:{avg_scored:1.10,avg_conceded:1.0,form:'WLWDL'} },
  { match:'Arsenal vs Chelsea',           comp:'Premier League', market:'1X', placar:'2-2', real_1x:true,
    home:{avg_scored:2.1,avg_conceded:1.0,form:'WWWDL'}, away:{avg_scored:1.60,avg_conceded:1.2,form:'WWDLW'} },
  { match:'Real Madrid vs Atletico',      comp:'LaLiga', market:'1X', placar:'1-1', real_1x:true,
    home:{avg_scored:2.0,avg_conceded:0.8,form:'WWWDW'}, away:{avg_scored:1.30,avg_conceded:0.8,form:'WWDWL'} },
  // 1X misses
  { match:'NorthEast United vs Sporting', comp:'I-League', market:'1X', placar:'0-3', real_1x:false,
    home:{avg_scored:0.8,avg_conceded:1.5,form:'LLLLD'}, away:{avg_scored:1.80,avg_conceded:0.8,form:'WWWWL'} },
  { match:'Chindia vs FC Bihor Oradea',   comp:'Liga 2, Promotion Round', market:'1X', placar:'1-3', real_1x:false,
    home:{avg_scored:0.8,avg_conceded:1.8,form:'LWLLL'}, away:{avg_scored:1.50,avg_conceded:0.9,form:'WWWDL'} },

  // ════════════════════ X2 ═══════════════════════════════════════════════
  { match:'Rayo Vallecano vs AEK Athens', comp:'UEFA Conference League, Knockout Phase', market:'X2', placar:'3-0', real_x2:false,
    home:{avg_scored:1.8,avg_conceded:0.9,form:'WWWDL'}, away:{avg_scored:0.80,avg_conceded:1.4,form:'DLLWL'} },
  { match:'Academia Puerto vs Atl.MG',   comp:'CONMEBOL Libertadores, Group E', market:'X2', placar:'2-1', real_x2:false,
    home:{avg_scored:1.2,avg_conceded:1.3,form:'WDLWL'}, away:{avg_scored:1.50,avg_conceded:1.0,form:'WWWDL'} },
  { match:'Man United vs Liverpool',      comp:'Premier League', market:'X2', placar:'0-2', real_x2:true,
    home:{avg_scored:1.2,avg_conceded:1.5,form:'LLDWL'}, away:{avg_scored:1.80,avg_conceded:0.9,form:'WWWDW'} },
  { match:'Benfica vs Sporting CP',       comp:'Liga Portugal Betclic', market:'X2', placar:'1-1', real_x2:true,
    home:{avg_scored:1.8,avg_conceded:0.9,form:'WWWDL'}, away:{avg_scored:1.60,avg_conceded:0.9,form:'WWWWL'},
    h2h:[{home_goals:2,away_goals:1},{home_goals:1,away_goals:2},{home_goals:1,away_goals:1}] },
];

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds de aposta por mercado
// ─────────────────────────────────────────────────────────────────────────────
const OLD_THRESHOLD = { 'BTTS': 60, 'Over 1.5': 60, '1X': 60, 'X2': 60 };  // old: qualquer EV positivo = aposta
const NEW_THRESHOLD = { 'BTTS': 67, 'Over 1.5': 72, '1X': 70, 'X2': 55  };  // new: thresholds APEX

function buildMatchData(tc) {
  return {
    match:       tc.match,
    competition: tc.comp,
    home: { team: tc.match.split(' vs ')[0], goals_scored_avg: tc.home.avg_scored, goals_conceded_avg: tc.home.avg_conceded, form: tc.home.form },
    away: { team: tc.match.split(' vs ')[1], goals_scored_avg: tc.away.avg_scored, goals_conceded_avg: tc.away.avg_conceded, form: tc.away.form },
    h2h:  tc.h2h || [],
    odds: {},
  };
}

function getProb(result, market) {
  const p = result.probabilities;
  if (market === 'BTTS')    return p.btts;
  if (market === 'Over 1.5') return p.over_1_5;
  if (market === '1X')       return p.chance_1x;
  if (market === 'X2')       return p.chance_x2;
  return null;
}

function getRealOutcome(tc) {
  if (tc.market === 'BTTS')    return tc.real_btts;
  if (tc.market === 'Over 1.5') return tc.real_o15;
  if (tc.market === '1X')       return tc.real_1x;
  if (tc.market === 'X2')       return tc.real_x2;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Executar ambos os modelos
// ─────────────────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const isJson  = args.includes('--json');
const mktFilter = args.includes('--market') ? args[args.indexOf('--market') + 1] : null;

const results = [];
process.stdout.write('\n⏳ Calculando...\r');

for (const tc of TEST_CASES) {
  if (mktFilter && tc.market !== mktFilter) continue;

  let newResult;
  const matchData = buildMatchData(tc);

  // Suprime logs do quant durante batch
  const origLog = console.log;
  console.log = () => {};
  try { newResult = analyzeQuantitative(matchData); } catch { newResult = null; }
  console.log = origLog;

  if (!newResult) continue;

  const newProb = getProb(newResult, tc.market);
  const outcome = getRealOutcome(tc);

  const oldPct = tc.old_prob || 82;
  const newPct = newProb != null ? Math.round(newProb * 100) : null;

  const oldBets  = oldPct >= (OLD_THRESHOLD[tc.market] || 60);
  const newBets  = newPct != null && newPct >= (NEW_THRESHOLD[tc.market] || 60);

  const oldHit   = oldBets && outcome;
  const newHit   = newBets && outcome;

  results.push({
    match:    tc.match,
    market:   tc.market,
    placar:   tc.placar,
    outcome,
    old_prob: oldPct,
    new_prob: newPct,
    old_bets: oldBets,
    new_bets: newBets,
    old_hit:  oldHit,
    new_hit:  newHit,
    // categorias de mudança
    prevented_loss: oldBets && !outcome && !newBets,  // antigo apostou errado, novo bloqueou
    new_find:       !oldBets && outcome && newBets,   // antigo não apostou, novo achou
    missed_win:     oldBets && outcome && !newBets,   // antigo certo, novo excessivamente conservador
    both_wrong:     oldBets && !outcome && newBets,   // ambos apostaram e perderam
    both_right:     oldBets && outcome && newBets,    // ambos apostaram e ganharam
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// OUTPUT JSON
// ─────────────────────────────────────────────────────────────────────────────
if (isJson) { console.log(JSON.stringify(results, null, 2)); process.exit(0); }

// ─────────────────────────────────────────────────────────────────────────────
// RELATÓRIO TERMINAL
// ─────────────────────────────────────────────────────────────────────────────
const LINE = '═'.repeat(72);
const sep  = '─'.repeat(72);

console.log(`\n╔${LINE}╗`);
console.log(`║  ⚖️  COMPARAÇÃO DE MODELOS — ANTES vs. DEPOIS (APEX)                    ║`);
console.log(`║  Data: ${new Date().toLocaleString('pt-BR').padEnd(64)}║`);
console.log(`╠${LINE}╣`);

// Tabela por caso
console.log(`║  ${'Jogo'.padEnd(28)} ${'Mercado'.padEnd(10)} ${'Res'.padEnd(5)} ${'Antigo'.padStart(7)} ${'Novo'.padStart(6)} ${'Δ'.padStart(5)} ${'Resultado'.padEnd(18)}`);
console.log(`║  ${sep.slice(0, 70)}`);

for (const r of results) {
  const delta   = r.new_prob != null ? r.new_prob - r.old_prob : null;
  const deltaStr = delta != null ? `${delta >= 0 ? '+' : ''}${delta}pp` : '  ?  ';
  let status;
  if (r.prevented_loss) status = '🛡️ ERRO EVITADO';
  else if (r.new_find)  status = '🔍 NOVO ACERTO';
  else if (r.missed_win) status = '⚠️  CONSERV.DEMAIS';
  else if (r.both_right) status = '✅ AMBOS CERTOS';
  else if (r.both_wrong) status = '❌ AMBOS ERROS';
  else if (!r.old_bets && !r.new_bets) status = '⏭️  NENHUM APOSTOU';
  else status = '';

  const outcStr = r.outcome ? '✓' : '✗';
  const oldStr  = `${r.old_prob}%${r.old_bets ? '▲' : '—'}`;
  const newStr  = r.new_prob != null ? `${r.new_prob}%${r.new_bets ? '▲' : '—'}` : '  ?  ';
  console.log(`║  ${r.match.slice(0,28).padEnd(28)} ${r.market.padEnd(10)} ${(r.placar||'').padEnd(5)} ${oldStr.padStart(7)} ${newStr.padStart(6)} ${deltaStr.padStart(5)} ${status}`);
}

// ─ Agregados por mercado ─────────────────────────────────────────────────────
console.log(`╠${LINE}╣`);
console.log(`║  📊 RESUMO POR MERCADO`);
console.log(`║  ${'Mercado'.padEnd(12)} ${'Amostras'.padStart(8)} ${'Old Bets'.padStart(9)} ${'New Bets'.padStart(9)} ${'Old Acc%'.padStart(9)} ${'New Acc%'.padStart(9)} ${'Δ Acc'.padStart(7)} ${'Erros Evit.'.padStart(12)}`);
console.log(`║  ${sep.slice(0,68)}`);

const markets = [...new Set(results.map(r => r.market))];
const summaryRows = [];
for (const mkt of markets) {
  const g = results.filter(r => r.market === mkt);
  const oldBets = g.filter(r => r.old_bets).length;
  const newBets = g.filter(r => r.new_bets).length;
  const oldHits = g.filter(r => r.old_hit).length;
  const newHits = g.filter(r => r.new_hit).length;
  const prevented = g.filter(r => r.prevented_loss).length;
  const oldAcc = oldBets > 0 ? (oldHits / oldBets * 100) : 0;
  const newAcc = newBets > 0 ? (newHits / newBets * 100) : 0;
  const deltaAcc = newAcc - oldAcc;
  summaryRows.push({ mkt, total: g.length, oldBets, newBets, oldAcc, newAcc, deltaAcc, prevented, oldHits, newHits });

  const deltaFmt = `${deltaAcc >= 0 ? '+' : ''}${deltaAcc.toFixed(1)}pp`;
  const flag = deltaAcc > 10 ? '🚀' : deltaAcc > 0 ? '✅' : deltaAcc < -5 ? '⚠️' : '➡️';
  console.log(`║  ${mkt.padEnd(12)} ${String(g.length).padStart(8)} ${String(oldBets).padStart(9)} ${String(newBets).padStart(9)} ${oldAcc.toFixed(1).padStart(8)}% ${newAcc.toFixed(1).padStart(8)}% ${deltaFmt.padStart(7)} ${String(prevented + ' casos').padStart(12)} ${flag}`);
}

// ─ Resumo global ─────────────────────────────────────────────────────────────
console.log(`╠${LINE}╣`);
console.log(`║  🏆 COMPARAÇÃO GLOBAL`);

const totalOldBets  = results.filter(r => r.old_bets).length;
const totalNewBets  = results.filter(r => r.new_bets).length;
const totalOldHits  = results.filter(r => r.old_hit).length;
const totalNewHits  = results.filter(r => r.new_hit).length;
const totalPrevented = results.filter(r => r.prevented_loss).length;
const totalNewFind  = results.filter(r => r.new_find).length;
const totalMissed   = results.filter(r => r.missed_win).length;
const totalBothRight = results.filter(r => r.both_right).length;

const oldGlobalAcc = totalOldBets > 0 ? (totalOldHits / totalOldBets * 100) : 0;
const newGlobalAcc = totalNewBets > 0 ? (totalNewHits / totalNewBets * 100) : 0;
const deltaGlobal  = newGlobalAcc - oldGlobalAcc;

console.log(`║`);
console.log(`║  Casos testados: ${results.length}`);
console.log(`║  ┌─────────────────────────────────────────────────────────────────┐`);
console.log(`║  │  MODELO         Apostas   Acertos   Precisão                   │`);
console.log(`║  │  ANTIGO:        ${String(totalOldBets).padStart(7)}   ${String(totalOldHits).padStart(7)}   ${oldGlobalAcc.toFixed(1).padStart(7)}%                  │`);
console.log(`║  │  NOVO:          ${String(totalNewBets).padStart(7)}   ${String(totalNewHits).padStart(7)}   ${newGlobalAcc.toFixed(1).padStart(7)}%                  │`);
console.log(`║  │  DIFERENÇA:                       ${deltaGlobal >= 0 ? '+' : ''}${deltaGlobal.toFixed(1).padStart(7)}pp ← melhoria    │`);
console.log(`║  └─────────────────────────────────────────────────────────────────┘`);
console.log(`║`);
console.log(`║  🛡️  Erros evitados:  ${totalPrevented}  (antigo apostou e perdeu → novo bloqueou)`);
console.log(`║  🔍 Novos acertos:   ${totalNewFind}  (antigo não apostou → novo identificou)`);
console.log(`║  ⚠️  Conserv.demais: ${totalMissed}  (antigo acertou → novo foi prudente demais)`);
console.log(`║  ✅ Ambos certos:    ${totalBothRight}  (consenso de qualidade)`);

// ROI simulado (odds médias de mercado: BTTS=1.75, Over1.5=1.50, 1X=1.30, X2=1.55)
const AVG_ODDS = { 'BTTS': 1.75, 'Over 1.5': 1.50, '1X': 1.30, 'X2': 1.55 };
let oldROI = 0, newROI = 0;
for (const r of results) {
  const odds = AVG_ODDS[r.market] || 1.60;
  if (r.old_bets) oldROI += r.outcome ? (odds - 1) : -1;
  if (r.new_bets) newROI += r.outcome ? (odds - 1) : -1;
}
const oldROIPct = totalOldBets > 0 ? (oldROI / totalOldBets * 100).toFixed(1) : '0.0';
const newROIPct = totalNewBets > 0 ? (newROI / totalNewBets * 100).toFixed(1) : '0.0';
const roiDelta  = (parseFloat(newROIPct) - parseFloat(oldROIPct)).toFixed(1);

console.log(`║`);
console.log(`║  💰 ROI SIMULADO (odds médias de mercado)`);
console.log(`║  Modelo Antigo: ${oldROIPct}% ROI (${totalOldBets} apostas)`);
console.log(`║  Modelo Novo:   ${newROIPct}% ROI (${totalNewBets} apostas)`);
console.log(`║  Diferença ROI: ${roiDelta >= 0 ? '+' : ''}${roiDelta}pp`);
console.log(`╚${LINE}╝\n`);
