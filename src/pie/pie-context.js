/**
 * PIE Context — Camada de Ingestão e Mineração
 * Geração de tags de contexto e cálculo de Expected Value (+EV).
 */

// ── Tags de contexto para indexação ──────────────────────────────────────────
export function buildTags(matchData, market) {
  const tags = [];
  const comp = (matchData.competition || '').toLowerCase();

  // Liga
  if      (comp.includes('premier') || comp.includes('england'))    tags.push('#PremierLeague');
  else if (comp.includes('brasileir') || comp.includes('brazil'))   tags.push('#Brasileirao');
  else if (comp.includes('champions'))                               tags.push('#Champions');
  else if (comp.includes('la liga') || comp.includes('spain'))      tags.push('#LaLiga');
  else if (comp.includes('serie a') && comp.includes('ital'))       tags.push('#SerieA');
  else if (comp.includes('bundesliga'))                              tags.push('#Bundesliga');
  else if (comp.includes('ligue'))                                   tags.push('#Ligue1');
  else if (comp.includes('libertadores'))                            tags.push('#Libertadores');
  else                                                               tags.push('#OutraLiga');

  // Mercado
  const mu = (market || '').toUpperCase();
  if      (mu.includes('BTTS') || mu.includes('AMBAS'))   tags.push('#Mercado_BTTS');
  else if (mu.includes('OVER'))                            tags.push('#Mercado_Over');
  else if (mu.includes('UNDER'))                           tags.push('#Mercado_Under');
  else if (mu.includes('GOL') || mu.includes('TOTAL'))    tags.push('#Mercado_Gols');
  else if (mu.includes('ESCANTEIO'))                       tags.push('#Mercado_Cantos');
  else if (mu.includes('CARTÃO') || mu.includes('CARTAO')) tags.push('#Mercado_Cartoes');
  else if (mu.includes('DUPLA'))                           tags.push('#Mercado_DuplaChance');
  else if (mu.includes('PLACAR'))                          tags.push('#Mercado_PlacarExato');

  return tags;
}

// ── Cálculo de Expected Value ─────────────────────────────────────────────────
export function calcEV(probabilidade, oddsMin) {
  if (!oddsMin || !probabilidade) return null;
  const ev = (probabilidade / 100) * oddsMin - 1;
  return (ev * 100).toFixed(1); // em %
}

// ── Critério de Kelly — stake ótimo em % da banca ────────────────────────────
// Usa half-Kelly para reduzir variância (prática recomendada em apostas)
// Retorna percentual da banca (0–5% máximo por aposta)
export function calcKellyStake(probabilidade, odds, fracao = 0.5) {
  if (!probabilidade || !odds || odds <= 1) return null;
  const p = Number(probabilidade) / 100;
  const q = 1 - p;
  const b = Number(odds) - 1; // lucro líquido por unidade apostada

  const kelly = (b * p - q) / b;
  if (kelly <= 0) return null; // aposta sem edge

  const halfKelly = kelly * fracao;
  // Limita a 5% da banca por aposta (gestão de risco)
  const capped = Math.min(halfKelly, 0.05);
  return (capped * 100).toFixed(2); // em %
}

// ── Classificação da qualidade do dado ───────────────────────────────────────
export function classifyDataQuality(matchData) {
  const sources = matchData._meta?.sources_used?.length || 0;
  const completeness = matchData._meta?.data_completeness || 0;

  if (sources >= 3 && completeness >= 70) return 'confiavel';
  if (sources >= 2 || completeness >= 40) return 'volátil';
  return 'histórico';
}

// ── Resumo das variáveis coletadas ───────────────────────────────────────────
export function summarizeVariables(matchData) {
  const vars = [];
  if (matchData.home?.xg_avg || matchData.away?.xg_avg)       vars.push('xG');
  if (matchData.home?.form   || matchData.away?.form)          vars.push('forma_recente');
  if (matchData.h2h?.length)                                   vars.push('historico_h2h');
  if (matchData.odds && Object.keys(matchData.odds).length)    vars.push('odds_mercado');
  if (matchData.home?.btts_pct || matchData.away?.btts_pct)   vars.push('btts_historico');
  if (matchData.home?.clean_sheet_pct)                         vars.push('clean_sheet');
  return vars;
}
