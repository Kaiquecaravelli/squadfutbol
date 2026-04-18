/**
 * Quant — Sigma v2.0 APEX
 * Modelos: Poisson + Dixon-Coles + EV Calculator + PIE Rule Engine
 *
 * Scoring ponderado baseado no protocolo v5.4 (Analista Probabilístico):
 * Score = (Forma × 0.35) + (Stats × 0.30) + (H2H × 0.20) + (Contexto × 0.15)
 *
 * PIE Rules: após o cálculo Poisson, as regras do deep-training.js são aplicadas
 * para calibrar as probabilidades com base em padrões históricos reais.
 *
 * v2.0 APEX improvements:
 *  - Lambda defaults reduzidos (evita superestimação em dados ausentes)
 *  - H2H lambda blending (30% peso histórico nos lambdas)
 *  - Multiplicadores de liga (dados reais do PIE)
 *  - Filtro defensivo BTTS (penalidade por fraqueza ofensiva do visitante)
 *  - League calibration pós-Poisson (blend 40% taxa real por liga)
 */

import { applyAllPIECorrections } from '../utils/pie-rules.js';
import { loadDB, getLambdaFatorSync } from '../pie/pie-storage.js';

const HOME_ADVANTAGE = 1.15;

// ── Coeficiente lambda_corners por liga (calibrado com dados reais) ───────────
// Fonte: data/daily-matches/*.json — média real de (corners_total / goals_total) por liga
// Drill C3 executado em 2026-04-16 com 12 arquivos / 400+ partidas
// Atualização Módulo 3 CornersAgent (2026-04-16): MLS adicionado com estimativa PIE
//
// Divergência > 10% do padrão 3.6 → coeficiente específico obrigatório
// Liga            n    avgC   avgG   coef   Δvs3.6   fonte
// Série B        41   10.54   2.07   5.082  +41% ⚠️  daily-matches (12 arquivos)
// Brasileirão    44   10.20   2.27   4.490  +25% ⚠️  daily-matches
// LaLiga         40   11.00   2.55   4.314  +20% ⚠️  daily-matches
// Liga Prof.     55    8.69   2.25   3.855   +7%     daily-matches
// Premier Leag.  21   10.33   2.71   3.807   +6%     daily-matches
// Eredivisie     37   10.62   2.84   3.743   +4%     daily-matches
// Liga Portugal  36   10.94   2.94   3.717   +3%     daily-matches
// MLS             –   ~10.5    ~2.9  ~3.75   +4%  ⚠️ estimativa PIE (sem data local)
//   Justificativa: Over 6.5 = 84% (n=103) · Over 7.5 = 76% (n=103) sugere liga
//   ofensiva com padrão similar à Eredivisie → coef 3.75 conservador
//   Recalibrar quando dados de daily-matches de temporada MLS estiverem disponíveis
// Serie A        41    8.29   2.39   3.469   -4%     daily-matches
// Ligue 1        32    9.38   2.81   3.333   -7%     daily-matches
// Bundesliga     36    9.61   3.39   2.836  -21% ⚠️  daily-matches
const LEAGUE_CORNERS_COEF = [
  // padrões normalizados (lowercase includes) → coef real
  { pattern: 'brasileirão série b',  coef: 5.082 },
  { pattern: 'brasileirao serie b',  coef: 5.082 },
  { pattern: 'brasileirão betano',   coef: 4.490 },
  { pattern: 'brasileirao betano',   coef: 4.490 },
  { pattern: 'laliga',               coef: 4.314 },
  { pattern: 'la liga',              coef: 4.314 },
  { pattern: 'liga profesional',     coef: 3.855 },
  { pattern: 'premier league',       coef: 3.807 },
  { pattern: 'eredivisie',           coef: 3.743 },
  { pattern: 'liga portugal',        coef: 3.717 },
  { pattern: 'mls',                  coef: 3.750 }, // estimativa PIE — recalibrar com daily-matches
  { pattern: 'serie a',              coef: 3.469 },
  { pattern: 'ligue 1',              coef: 3.333 },
  { pattern: 'bundesliga',           coef: 2.836 },
];

/**
 * Retorna o coeficiente corners/goals para a liga especificada.
 * Fallback para 3.6 se a liga não estiver mapeada.
 */
function getCornersCoef(competition) {
  const comp = (competition || '').toLowerCase();
  const entry = LEAGUE_CORNERS_COEF.find(e => comp.includes(e.pattern));
  return entry ? entry.coef : 3.6;
}

// ── Multiplicadores de lambda por liga (derivados de dados reais PIE v2) ──────
// Calibrados para refletir padrão histórico de gols por liga vs. média global
const LEAGUE_LAMBDA_MULTIPLIERS = {
  'Serie A':               { home: 0.90, away: 0.87 },   // media gols: 2.4 → fator 0.90
  'Bundesliga':            { home: 1.12, away: 1.08 },   // media gols: 3.2 → fator 1.10
  'Premier League':        { home: 1.05, away: 1.03 },   // media gols: 2.85 → fator 1.04
  'Ligue 1':               { home: 1.04, away: 1.01 },   // media gols: 2.7 → fator 1.02
  'LaLiga':                { home: 0.93, away: 0.90 },   // media gols: 2.5 → fator 0.91
  'Brasileirão Betano':    { home: 0.92, away: 0.90 },   // media gols: 2.4 → fator 0.91
  'Brasileirão Série B':   { home: 0.88, away: 0.86 },
  'Liga Profesional de Fútbol, Apertura': { home: 0.90, away: 0.87 },
  'Liga Portugal Betclic': { home: 0.95, away: 0.92 },
  'UEFA Champions League, Knockout stage': { home: 0.95, away: 0.90 },  // mais cauteloso
  'UEFA Europa League, Knockout stage':    { home: 0.97, away: 0.92 },
  // Torneios defensivos (BTTS 15% → Under forte — reduz lambda para aumentar pUnder)
  'Copa Sudamericana':                     { home: 0.88, away: 0.85 }, // ~2.1 gols/jogo histórico
  'Conference League':                     { home: 0.85, away: 0.83 }, // baixa pontuação confirmada
  'Copa Libertadores':                     { home: 0.92, away: 0.88 }, // fase grupos defensiva
};

// ── G3: Fator de altitude para CONMEBOL (2026-04-16) ─────────────────────────
// Cidades acima de 1.400m reduzem expectativa de gols por cansaço físico do visitante.
// Fonte: estudos de rendimento físico em altitude + histórico de resultados CONMEBOL.
// Impacto aplicado a AMBOS os lambdas: jogo em altitude afeta times mandante e visitante.
const ALTITUDE_FACTOR = {
  'la paz':   0.88,  // 3.640m — Bolívia: maior impacto do calendário sul-americano
  'potosí':   0.88,  // 3.900m — Bolívia
  'potosi':   0.88,
  'cusco':    0.89,  // 3.400m — Perú
  'quito':    0.92,  // 2.850m — Equador
  'bogotá':   0.93,  // 2.625m — Colômbia
  'bogota':   0.93,
  'medellín': 0.97,  // 1.495m — impacto leve
  'medellin': 0.97,
};

/**
 * Retorna o fator de ajuste de lambda por altitude.
 * Fallback 1.0 (sem ajuste) quando cidade não encontrada.
 * @param {string} city — cidade do jogo (matchData.cidade | city | venue_city)
 */
function getAltitudeFactor(city) {
  if (!city) return 1.0;
  const c = city.toLowerCase().trim();
  for (const [k, v] of Object.entries(ALTITUDE_FACTOR)) {
    if (c.includes(k)) return v;
  }
  return 1.0;
}

export function analyzeQuantitative(matchData) {
  console.log(`📊 [Quant] Calculando probabilidades...`);

  const { home, away, odds, h2h } = matchData;
  const competition = matchData.competition || '';

  // ── Melhoria 1: Defaults conservadores para dados ausentes ─────────────────
  // Antigo: 1.3 e 1.1 → criava lambda default de 1.64 (muito alto)
  // Novo: 1.0 e 1.0 → lambda default de 1.15 (realista para times desconhecidos)
  const homeGoalsScored   = home.goals_scored_avg   || 1.0;
  const homeConceded      = home.goals_conceded_avg  || 1.0;
  const awayGoalsScored   = away.goals_scored_avg   || 0.9;
  const awayConceded      = away.goals_conceded_avg  || 1.0;

  // ── Campo neutro: remove HOME_ADVANTAGE em finais e jogos explicitamente marcados ──
  // matchData.campo_neutro = true → explicitamente neutro (SofaScore ou funnel)
  // heurística: "final" na competição → provavelmente estádio neutro
  const isNeutralVenue = matchData.campo_neutro === true ||
    /\b(final|3rd place|tercer lugar|finale)\b/i.test(competition);
  if (isNeutralVenue) {
    console.log(`  ⚖️  [Campo Neutro] HOME_ADVANTAGE removido — ${competition}`);
  }
  let lambdaHome = homeGoalsScored * awayConceded * (isNeutralVenue ? 1.0 : HOME_ADVANTAGE);
  let lambdaAway = awayGoalsScored * homeConceded;

  // ── Melhoria 2: H2H lambda blending (30% peso histórico) ───────────────────
  // Se H2H disponível, blend 70% Poisson + 30% histórico direto
  if (h2h?.length >= 3) {
    const recent = h2h.slice(0, 5);
    const h2hHome = recent.reduce((s, m) => s + (m.home_goals ?? 0), 0) / recent.length;
    const h2hAway = recent.reduce((s, m) => s + (m.away_goals ?? 0), 0) / recent.length;
    if (h2hHome > 0 || h2hAway > 0) {
      lambdaHome = lambdaHome * 0.70 + h2hHome * 0.30;
      lambdaAway = lambdaAway * 0.70 + h2hAway * 0.30;
      console.log(`  📐 [H2H Blend] λH: ${round(lambdaHome)} λA: ${round(lambdaAway)} (H2H n=${recent.length})`);
    }
  }

  // ── Melhoria 3: Multiplicador por liga ────────────────────────────────────
  const leagueMult = LEAGUE_LAMBDA_MULTIPLIERS[competition];
  if (leagueMult) {
    lambdaHome *= leagueMult.home;
    lambdaAway *= leagueMult.away;
    console.log(`  🌍 [Liga ${competition}] λH×${leagueMult.home} λA×${leagueMult.away}`);
  }

  // Cap de lambdas: valores acima de 4.0 são estatisticamente irrealistas
  // (nenhum time médio marca mais de 4 gols/jogo esperados em condições normais)
  lambdaHome = Math.min(lambdaHome, 4.0);
  lambdaAway = Math.min(lambdaAway, 3.5);

  // Floor de lambda: times com dados insuficientes (SofaScore retorna stats próximas de 0)
  // produzem lambda → 0, o que resulta em pOver15 = 0% e pUnder15 = 100% — valores degenerados.
  // Mínimo realista: mesmo o time mais fraco marca ~0.3 gols esperados por jogo.
  // Efeito: pOver15 fica em ~15-20% (razoável para times muito fracos) em vez de 0%.
  // Bug fix (2026-04-16): raiz do "Kill Zone — prob 0%" para Conference League.
  if (lambdaHome < 0.35) {
    console.log(`  ⚠️  [Lambda Floor] ${competition}: λH ${lambdaHome.toFixed(3)} → 0.350 (floor aplicado)`);
    lambdaHome = 0.35;
  }
  if (lambdaAway < 0.28) {
    console.log(`  ⚠️  [Lambda Floor] ${competition}: λA ${lambdaAway.toFixed(3)} → 0.280 (floor aplicado)`);
    lambdaAway = 0.28;
  }

  // ── Feed Loop: fator lambda aprendido per-liga (2026-04-18) ─────────────────
  // getLambdaFatorSync retorna 1.0 (neutro) se a liga ainda não foi calibrada.
  // Ajustado automaticamente pelo feed-loop.js com base em confrontos acumulados.
  // Range: [0.75, 1.25] — nunca ultrapassa esses limites.
  const lambdaFatorPIE = getLambdaFatorSync(competition);
  if (lambdaFatorPIE !== 1.0) {
    lambdaHome = Math.max(lambdaHome * lambdaFatorPIE, 0.35);
    lambdaAway = Math.max(lambdaAway * lambdaFatorPIE, 0.28);
    console.log(`  🧠 [PIE λ-fator] ${competition}: ×${lambdaFatorPIE.toFixed(3)} → λH=${lambdaHome.toFixed(3)} λA=${lambdaAway.toFixed(3)}`);
  }

  // ── G3: Ajuste de altitude CONMEBOL (2026-04-16) ─────────────────────────────
  // Jogos em cidades acima de 1.400m reduzem expectativa de gols de ambos os times.
  // O campo matchData.cidade (ou city/venue_city) é preenchido pelo SofaScore scraper.
  // Aplicado APÓS o floor para não interferir com o mínimo estatístico.
  const cidadeJogo = matchData.cidade || matchData.city || matchData.venue_city || '';
  const altitudeFator = getAltitudeFactor(cidadeJogo);
  if (altitudeFator < 1.0) {
    lambdaHome = Math.max(lambdaHome * altitudeFator, 0.35);
    lambdaAway = Math.max(lambdaAway * altitudeFator, 0.28);
    console.log(`  🏔️  [G3 Altitude] ${cidadeJogo}: λ×${altitudeFator} → λH=${lambdaHome.toFixed(3)} λA=${lambdaAway.toFixed(3)}`);
  }

  // ── G2: Artilheiro ausente — ajuste de lambda automático (2026-04-16) ─────────
  // matchData.artilheiro_ausente: { casa: boolean, fora: boolean, nome_casa?, nome_fora? }
  // Preenchido pelo coletor/funnel quando escalação confirmada via SofaScore.
  // Impacto: -8% no lambda do time que perdeu o artilheiro principal.
  if (matchData.artilheiro_ausente?.casa) {
    const nome = matchData.artilheiro_ausente.nome_casa || 'artilheiro';
    lambdaHome = Math.max(lambdaHome * 0.92, 0.35);
    console.log(`  ⚠️  [G2] Artilheiro ausente (casa): ${nome} → λH×0.92 = ${lambdaHome.toFixed(3)}`);
  }
  if (matchData.artilheiro_ausente?.fora) {
    const nome = matchData.artilheiro_ausente.nome_fora || 'artilheiro';
    lambdaAway = Math.max(lambdaAway * 0.94, 0.28);
    console.log(`  ⚠️  [G2] Artilheiro ausente (fora): ${nome} → λA×0.94 = ${lambdaAway.toFixed(3)}`);
  }

  const scoreMatrix     = buildScoreMatrix(lambdaHome, lambdaAway, 7);
  const correctedMatrix = dixonColesCorrection(scoreMatrix, lambdaHome, lambdaAway);

  // ── Probabilidades 1X2 ──────────────────────────────────
  let pHome = 0, pDraw = 0, pAway = 0;
  for (let i = 0; i < correctedMatrix.length; i++) {
    for (let j = 0; j < correctedMatrix[i].length; j++) {
      const p = correctedMatrix[i][j];
      if (i > j) pHome += p;
      else if (i === j) pDraw += p;
      else pAway += p;
    }
  }

  // ── Over/Under & BTTS — todos os limiares ─────────────────
  let pOver15 = 0, pOver25 = 0, pOver35 = 0, pOver45 = 0, pBTTS = 0;
  for (let i = 0; i < correctedMatrix.length; i++) {
    for (let j = 0; j < correctedMatrix[i].length; j++) {
      const total = i + j;
      if (total > 1) pOver15 += correctedMatrix[i][j];
      if (total > 2) pOver25 += correctedMatrix[i][j];
      if (total > 3) pOver35 += correctedMatrix[i][j];
      if (total > 4) pOver45 += correctedMatrix[i][j];
      if (i >= 1 && j >= 1) pBTTS += correctedMatrix[i][j];
    }
  }

  // ── Melhoria 4: Filtro defensivo BTTS ────────────────────────────────────
  // O modelo Poisson puro não penaliza times com ataque fraco.
  // Na prática, se um time marca <0.8 gols/jogo, BTTS raramente acontece.
  const minScorer = Math.min(awayGoalsScored, homeGoalsScored);
  if (minScorer < 0.60) {
    pBTTS *= 0.50;   // ataque muito fraco: -50%
    console.log(`  🛡️  [BTTS Filter] min_scorer=${minScorer.toFixed(2)} → pBTTS×0.50`);
  } else if (minScorer < 0.80) {
    pBTTS *= 0.72;   // ataque fraco: -28%
    console.log(`  🛡️  [BTTS Filter] min_scorer=${minScorer.toFixed(2)} → pBTTS×0.72`);
  } else if (minScorer < 1.00) {
    pBTTS *= 0.88;   // ataque abaixo da média: -12%
  }

  // Dominância extrema também reduz BTTS (time fraco dificilmente marca)
  if (lambdaHome > lambdaAway * 2.8 || lambdaAway > lambdaHome * 2.5) {
    pBTTS *= 0.72;
    console.log(`  🛡️  [BTTS Filter] dominância extrema → pBTTS×0.72`);
  }

  // ── B4: BTTS modelo independente (2026-04-16) ─────────────────────────────────
  // P(BTTS) = P(casa marca ≥ 1) × P(fora marca ≥ 1) — independência dos eventos.
  // Mais preciso que lambda genérico: usa os lambdas finais calibrados de cada time.
  // Blend 55% matriz Dixon-Coles (captura correlação 0-0/1-1) + 45% modelo independente.
  const pCasaMarca = 1 - Math.exp(-lambdaHome);
  const pForaMarca = 1 - Math.exp(-lambdaAway);
  const pBTTSIndependente = pCasaMarca * pForaMarca;
  pBTTS = pBTTS * 0.55 + pBTTSIndependente * 0.45;

  // ── Escanteios e Cartões (via lambdas auxiliares) ──────────
  const totalGoalsExp = lambdaHome + lambdaAway;

  // Drill C3 — coeficiente corners/goals calibrado por liga (2026-04-16)
  // Substitui o valor fixo 3.6 que subestimava Brasileirão (+25%) e superestimava Bundesliga (-21%)
  const cornersPerGoal = getCornersCoef(competition);
  if (cornersPerGoal !== 3.6) {
    console.log(`  🎯 [Corners Coef] ${competition}: ${cornersPerGoal.toFixed(3)} (padrão 3.6)`);
  }
  const lambdaCorners   = totalGoalsExp * cornersPerGoal;
  const pOverCorners85 = round(1 - poissonCDF(8, lambdaCorners));
  const pOverCorners75 = round(1 - poissonCDF(7, lambdaCorners));
  const pOverCorners65 = round(1 - poissonCDF(6, lambdaCorners));

  // Cartões: correlaciona com intensidade (delta técnico + pressão de jogo)
  // Ajuste: intensityFactor mais conservador — cartões correlacionam mais com rivalidade
  // do que com diferença de lambdas (que é info pré-jogo limitada)
  const lambdaDelta     = Math.abs(lambdaHome - lambdaAway);
  const intensityFactor = 0.85 + (lambdaDelta * 0.10);  // era 0.9 + 0.15 — reduzido
  const lambdaYC = totalGoalsExp * 1.1 * intensityFactor;  // era 1.2 — reduzido
  const pOverYC25 = round(1 - poissonCDF(2, lambdaYC));
  const pOverYC35 = round(1 - poissonCDF(3, lambdaYC));
  const pOverYC45 = round(1 - poissonCDF(4, lambdaYC));

  // ── Filtros de qualidade para mercados de baixa precisão histórica ──────────
  // Over 3.5: só é confiável quando ambos os times têm ataque alto (real PIE: 40%)
  // — penaliza probabilidade quando lambdaTotal < 2.5
  const over35Dampen = totalGoalsExp < 2.5 ? 0.60 : totalGoalsExp < 3.0 ? 0.78 : 1.0;

  // Over Corners 8.5: só confiável com lambdaCorners muito alto (real PIE: 62%)
  const corners85Dampen = lambdaCorners < 9.5 ? 0.65 : lambdaCorners < 11.0 ? 0.82 : 1.0;

  // YC 3.5: alta incerteza — mais conservador (real PIE: 54%)
  const yc35Dampen = lambdaYC < 3.8 ? 0.60 : lambdaYC < 4.5 ? 0.78 : 1.0;

  // X2 (Dupla Chance visitante): só apostar quando visitante é genuinamente forte
  const x2Dampen = (pDraw + pAway) < 0.70 ? 0.70 : 1.0;

  // Dupla chance (combinações 1X2)
  const p1X  = round(pHome + pDraw);
  const pX2  = round(pDraw + pAway);
  const p12  = round(pHome + pAway);

  // Aplica dampens de calibração para mercados historicamente imprecisos
  const pOver35Calibrated   = round(pOver35  * over35Dampen);
  const pOverCorners85Cal   = round(pOverCorners85 * corners85Dampen);
  const pOverYC35Calibrated = round(pOverYC35 * yc35Dampen);
  const pX2Calibrated       = round(pX2 * x2Dampen);

  const probabilities = {
    home_win:         round(pHome),
    draw:             round(pDraw),
    away_win:         round(pAway),
    chance_1x:        p1X,
    chance_x2:        pX2Calibrated,
    chance_12:        p12,
    over_1_5:         round(pOver15),
    over_2_5:         round(pOver25),
    over_3_5:         pOver35Calibrated,
    over_4_5:         round(pOver45),
    under_1_5:        round(1 - pOver15),
    under_2_5:        round(1 - pOver25),
    under_3_5:        round(1 - pOver35),
    btts:             round(pBTTS),
    over_corners_6_5:  pOverCorners65,
    over_corners_7_5:  pOverCorners75,
    over_corners_8_5:  pOverCorners85Cal,
    under_corners_6_5: round(1 - pOverCorners65),  // C1: Corners Under (2026-04-16)
    under_corners_7_5: round(1 - pOverCorners75),  // C1: Corners Under (2026-04-16)
    over_yc_2_5:      pOverYC25,
    over_yc_3_5:      pOverYC35Calibrated,
    over_yc_4_5:      pOverYC45,
    ah_home_minus_05: round(pHome),
  };

  const safeOdd = (p) => p > 0 ? round(1 / p) : null;
  const fairOdds = {
    home_win:  safeOdd(pHome),
    draw:      safeOdd(pDraw),
    away_win:  safeOdd(pAway),
    over_1_5:  safeOdd(pOver15),
    over_2_5:  safeOdd(pOver25),
    over_3_5:  safeOdd(pOver35),
    btts:      safeOdd(pBTTS),
    chance_1x: safeOdd(p1X),
    chance_x2: safeOdd(pX2),
    over_corners_8_5: safeOdd(pOverCorners85),
    over_yc_2_5:      safeOdd(pOverYC25),
  };

  // ── Scoring ponderado v5.4 ──────────────────────────────
  const scores = calcProbabilisticScores(matchData);

  // ── Value Bets ──────────────────────────────────────────
  const valueBets = calculateValueBets(probabilities, odds);

  // ── Confiabilidade do modelo ────────────────────────────
  const dataFields = [home.goals_scored_avg, home.goals_conceded_avg, home.form,
                      away.goals_scored_avg, away.goals_conceded_avg, away.form,
                      matchData.h2h?.length];
  const filled = dataFields.filter(Boolean).length;
  const modelConfidence = round(0.4 + (filled / dataFields.length) * 0.55);

  // ── Melhoria 5: Calibração pós-Poisson por liga (40% blend) ─────────────────
  // Usa as taxas reais por liga do PIE para corrigir overshooting do Poisson
  // Ex: LaLiga Over 1.5 real = 65.4%, Poisson previu 74% → corrige para 70.4%
  const leagueCalibrated = { ...probabilities };
  try {
    const db = loadDB();
    const leagueAdj = db.league_adjustments?.[competition];
    if (leagueAdj) {
      const MARKET_TO_KEY = {
        'Over 1.5': 'over_1_5', 'Over 2.5': 'over_2_5', 'Over 3.5': 'over_3_5',
        'Over 4.5': 'over_4_5', 'BTTS': 'btts',
        'Over Corners 6.5': 'over_corners_6_5', 'Over Corners 7.5': 'over_corners_7_5',
        'Over Corners 8.5': 'over_corners_8_5',
        'YC 2.5': 'over_yc_2_5', 'YC 3.5': 'over_yc_3_5', 'YC 4.5': 'over_yc_4_5',
        'Home Win': 'home_win', 'Draw': 'draw', 'Away Win': 'away_win',
        '1X': 'chance_1x', 'X2': 'chance_x2', '12': 'chance_12',
      };
      let calCount = 0;
      for (const [market, data] of Object.entries(leagueAdj)) {
        const key = MARKET_TO_KEY[market];
        if (!key || leagueCalibrated[key] == null || !data.rate) continue;
        // Blend: 60% modelo + 40% taxa real por liga
        leagueCalibrated[key] = Math.min(0.97, Math.max(0.03,
          +(leagueCalibrated[key] * 0.60 + data.rate * 0.40).toFixed(3)
        ));
        calCount++;
      }
      if (calCount > 0) console.log(`  📊 [Liga Cal] ${calCount} mercados calibrados pela liga "${competition}"`);
    }
  } catch { /* calibração por liga indisponível — continua com Poisson */ }

  // ── PIE Rules: calibração com padrões históricos treinados ─────────────────
  let adjustedProbs = leagueCalibrated;
  let pieRulesResult = null;
  try {
    pieRulesResult = applyAllPIECorrections({ probabilities: leagueCalibrated, lambda_home: lambdaHome, lambda_away: lambdaAway }, matchData);
    if (pieRulesResult.rules_applied > 0) {
      adjustedProbs = pieRulesResult.probabilities;
      console.log(`  🔧 [PIE Rules] ${pieRulesResult.rules_applied} regras aplicadas`);
      if (pieRulesResult.adjustment_log?.length) {
        pieRulesResult.adjustment_log.slice(0, 3).forEach(l => console.log(l));
      }
    }
  } catch { /* PIE rules indisponíveis — usa Poisson puro */ }

  // Recalcula value bets com probabilidades ajustadas (se houve ajuste)
  const finalProbs   = adjustedProbs;
  const finalVBets   = pieRulesResult?.rules_applied > 0 ? calculateValueBets(finalProbs, odds) : valueBets;

  return {
    match: matchData.match,
    lambda_home: round(lambdaHome),
    lambda_away: round(lambdaAway),
    probabilities: finalProbs,
    probabilities_raw: pieRulesResult?.rules_applied > 0 ? probabilities : undefined,
    fair_odds: fairOdds,
    value_bets: finalVBets,
    probabilistic_scores: scores,    // Scoring v5.4
    model_confidence: modelConfidence,
    sample_size: matchData.h2h?.length || 0,
    uncertainty: deriveUncertainty(scores, modelConfidence),
    pie_rules_applied: pieRulesResult?.rules_applied || 0,
    pie_signals: pieRulesResult?.pre_match_signals || [],
  };
}

// ── Scoring Ponderado v5.4 ───────────────────────────────────────────────────
function calcProbabilisticScores(matchData) {
  const { home, away, h2h } = matchData;

  // DIMENSÃO 1 — Forma Recente (peso 35%)
  const homeForma = scoreForma(home.form);
  const awayForma = scoreForma(away.form);

  // DIMENSÃO 2 — Performance Estatística (peso 30%)
  const homeStats = scoreStats(home);
  const awayStats = scoreStats(away);

  // DIMENSÃO 3 — H2H (peso 20%)
  const { homeH2H, awayH2H } = scoreH2H(h2h, home.team, away.team);

  // DIMENSÃO 4 — Contexto (peso 15%)
  const homeCtx = scoreContexto(matchData, 'home');
  const awayCtx = scoreContexto(matchData, 'away');

  // Score final ponderado
  const homeScore = round((homeForma * 0.35) + (homeStats * 0.30) + (homeH2H * 0.20) + (homeCtx * 0.15));
  const awayScore = round((awayForma * 0.35) + (awayStats * 0.30) + (awayH2H * 0.20) + (awayCtx * 0.15));
  const delta     = round(Math.abs(homeScore - awayScore));

  // Regra de equilíbrio técnico: se delta < 0.50 → recalcular com pesos H2H
  let homeRecalc = null, awayRecalc = null;
  if (delta < 0.50) {
    homeRecalc = round((homeForma * 0.30) + (homeStats * 0.25) + (homeH2H * 0.35) + (homeCtx * 0.10));
    awayRecalc = round((awayForma * 0.30) + (awayStats * 0.25) + (awayH2H * 0.35) + (awayCtx * 0.10));
  }

  const favoritismo = delta < 0.50 ? 'EQUILÍBRIO TÉCNICO'
    : delta < 1.20 ? 'leve'
    : delta < 2.00 ? 'moderado'
    : 'forte';

  const leader = homeScore > awayScore ? 'home' : awayScore > homeScore ? 'away' : 'draw';

  return {
    home: {
      forma:   round(homeForma),
      stats:   round(homeStats),
      h2h:     round(homeH2H),
      contexto: round(homeCtx),
      score:   homeScore,
      score_recalc: homeRecalc,
    },
    away: {
      forma:   round(awayForma),
      stats:   round(awayStats),
      h2h:     round(awayH2H),
      contexto: round(awayCtx),
      score:   awayScore,
      score_recalc: awayRecalc,
    },
    delta,
    favoritismo,
    leader,
    equilibrio_tecnico: delta < 0.50,
  };
}

function scoreForma(formStr) {
  if (!formStr || formStr === 'N/A') return 5.0;
  const chars = formStr.slice(-8).split('');
  let pts = 0;
  chars.forEach((c, i) => {
    const weight = 1 + (i / chars.length) * 0.5; // jogos mais recentes têm mais peso
    if (c === 'W') pts += 3 * weight;
    else if (c === 'D') pts += 1 * weight;
  });
  const maxPts = chars.length * 3 * 1.5;
  return round(1 + (pts / maxPts) * 9); // normaliza para 1–10
}

function scoreStats(team) {
  const scored   = team.goals_scored_avg   || 0;
  const conceded = team.goals_conceded_avg || 99;
  const xg       = team.xg_avg            || scored; // fallback para goals se sem xG

  // Ataque (0–5): usar média entre gols e xG para maior precisão
  const atkRaw   = (scored + xg) / 2;
  const atkScore = Math.min(5, (atkRaw / 2.5) * 5);
  // Defesa (0–5): menos gols sofridos = melhor
  const defScore = Math.min(5, Math.max(0, 5 - (conceded / 1.5) * 2.5));

  return Math.min(10, round(1 + atkScore + defScore)); // capado corretamente em 10
}

function scoreH2H(h2hMatches, homeTeam, awayTeam) {
  if (!h2hMatches?.length) return { homeH2H: 5.0, awayH2H: 5.0 }; // neutro

  // Apenas últimos 5 confrontos relevantes (max 24 meses preferencial)
  const relevant = h2hMatches.slice(0, 5);
  let homeWins = 0, awayWins = 0, draws = 0;

  for (const m of relevant) {
    const winner = m.winner || deriveWinner(m, homeTeam, awayTeam);
    const normalize = (n) => (n || '').toLowerCase().replace(/\s+/g, '');
    if (normalize(winner) === normalize(homeTeam)) homeWins++;
    else if (normalize(winner) === normalize(awayTeam)) awayWins++;
    else draws++;
  }

  const total = relevant.length || 1;
  const homeH2H = round(1 + (homeWins / total) * 9);
  const awayH2H = round(1 + (awayWins / total) * 9);
  return { homeH2H, awayH2H };
}

function deriveWinner(match, homeTeam, awayTeam) {
  const hg = match.home_goals ?? 0;
  const ag = match.away_goals ?? 0;
  if (hg > ag) return match.home || homeTeam;
  if (ag > hg) return match.away || awayTeam;
  return 'Draw';
}

function scoreContexto(matchData, side) {
  let score = 5.0;

  // Vantagem de mando
  if (side === 'home') score += 1.5;

  // Clima adverso
  if (matchData.weather?.wind_kmh > 40) score -= 0.5;
  if (matchData.weather?.condition?.includes('rain')) score -= 0.3;

  // Notícias (se disponível no matchData)
  const newsImpact = matchData[`${side}_news_impact`] || 0;
  score += newsImpact * 0.1;

  return round(Math.min(10, Math.max(0, score)));
}

function deriveUncertainty(scores, confidence) {
  if (confidence < 0.5 || scores.equilibrio_tecnico) return 'Alto';
  if (scores.delta > 2.0 && confidence > 0.75) return 'Baixo';
  return 'Médio';
}

// ── Value Bets ────────────────────────────────────────────────────────────────
function calculateValueBets(probs, odds, matchData = null) {
  if (!odds || !Object.keys(odds).length) return [];

  const minEV = parseFloat(process.env.MIN_EV_THRESHOLD || '0.05');

  // Thresholds mínimos de probabilidade por mercado (filtro de qualidade APEX)
  const MIN_PROB_FOR_BET = {
    'BTTS':      0.67,  // BTTS requer 67%+ após correções (antes: qualquer EV positivo)
    'Over 1.5':  0.72,  // mercado só tem valor acima de 72%
    'Over 2.5':  0.58,
    'Over 3.5':  0.48,
    'Home Win':  0.48,
    'Away Win':  0.40,
    'Empate':    0.28,
    '1X':        0.70,
    'X2':        0.55,
  };

  const markets = [
    // Mercados principais 1X2
    { key: 'home_win',  label: 'Home Win',  prob: probs.home_win  },
    { key: 'draw',      label: 'Empate',    prob: probs.draw      },
    { key: 'away_win',  label: 'Away Win',  prob: probs.away_win  },
    // Dupla chance
    { key: 'chance_1x', label: '1X',        prob: probs.chance_1x },
    { key: 'chance_x2', label: 'X2',        prob: probs.chance_x2 },
    { key: 'chance_12', label: '12',        prob: probs.chance_12 },
    // Over/Under gols — todos os limiares
    { key: 'over_1_5',  label: 'Over 1.5',  prob: probs.over_1_5  },
    { key: 'over_2_5',  label: 'Over 2.5',  prob: probs.over_2_5  },
    { key: 'over_3_5',  label: 'Over 3.5',  prob: probs.over_3_5  },
    { key: 'over_4_5',  label: 'Over 4.5',  prob: probs.over_4_5  },
    { key: 'under_1_5', label: 'Under 1.5', prob: probs.under_1_5 }, // Module 3: habilitado para ligas defensivas
    { key: 'under_2_5', label: 'Under 2.5', prob: probs.under_2_5 },
    { key: 'under_3_5', label: 'Under 3.5', prob: probs.under_3_5 },
    // BTTS
    { key: 'btts',      label: 'BTTS',      prob: probs.btts      },
    // Escanteios — limiares PIE calibrados
    { key: 'over_corners_6_5', label: 'Over Corners 6.5', prob: probs.over_corners_6_5 },
    { key: 'over_corners_7_5', label: 'Over Corners 7.5', prob: probs.over_corners_7_5 },
    { key: 'over_corners_8_5', label: 'Over Corners 8.5', prob: probs.over_corners_8_5 },
    // Cartões amarelos
    { key: 'over_yc_2_5', label: 'Over YC 2.5', prob: probs.over_yc_2_5 },
    { key: 'over_yc_3_5', label: 'Over YC 3.5', prob: probs.over_yc_3_5 },
  ];

  const valueBets = [];
  for (const market of markets) {
    for (const [house, houseOdds] of Object.entries(odds)) {
      const oddsVal = houseOdds?.[market.key];
      if (!oddsVal) continue;

      const impliedProb = 1 / oddsVal;
      const ev = (market.prob * oddsVal) - 1;

      // Filtro de probabilidade mínima por mercado (APEX quality gate)
      const minProb = MIN_PROB_FOR_BET[market.label] || 0;
      if (market.prob < minProb) continue;

      if (ev >= minEV) {
        valueBets.push({
          market: market.label,
          house,
          true_prob: market.prob,
          odds: oddsVal,
          implied_prob: round(impliedProb),
          ev: round(ev),
          ev_pct: `${(ev * 100).toFixed(1)}%`,
          rating: ev >= 0.10 ? 'STRONG_VALUE' : 'VALUE',
        });
      }
    }
  }

  return valueBets.sort((a, b) => b.ev - a.ev);
}

// ── Modelos Matemáticos ───────────────────────────────────────────────────────
function buildScoreMatrix(lh, la, maxGoals) {
  const matrix = [];
  for (let i = 0; i < maxGoals; i++) {
    matrix[i] = [];
    for (let j = 0; j < maxGoals; j++) {
      matrix[i][j] = poissonPMF(i, lh) * poissonPMF(j, la);
    }
  }
  return matrix;
}

function dixonColesCorrection(matrix, lh, la) {
  // rho dinâmico: jogos de baixo scoring têm correlação negativa mais forte
  // Quando lambdas são pequenas (< 1.0), mais jogos terminam 0-0 ou 1-0 do que Poisson puro prevê
  const lambdaSum = lh + la;
  const rho = lambdaSum < 2.0 ? -0.18 : lambdaSum < 3.0 ? -0.13 : -0.09;

  const copy = matrix.map((row) => [...row]);
  const corr = (i, j) => {
    if (i === 0 && j === 0) return 1 - lh * la * rho;
    if (i === 0 && j === 1) return 1 + lh * rho;
    if (i === 1 && j === 0) return 1 + la * rho;
    if (i === 1 && j === 1) return 1 - rho;
    return 1;
  };
  for (let i = 0; i <= 1; i++) {
    for (let j = 0; j <= 1; j++) copy[i][j] *= corr(i, j);
  }
  return copy;
}

// ── Log-Poisson com cache (2026-04-16) ───────────────────────────────────────
// Evita overflow numérico em lambdas altas (k! cresce muito rápido).
// Cache de 500 entradas previne recálculo repetido das mesmas combinações lambda/k.

const _poissonCache = new Map();

// CDF Poisson: P(X <= k) = soma de P(X=0)..P(X=k) — com memoização
function poissonCDF(k, lambda) {
  const key = `${k}_${lambda.toFixed(3)}`;
  if (_poissonCache.has(key)) return _poissonCache.get(key);
  let cdf = 0;
  for (let i = 0; i <= k; i++) cdf += poissonPMF(i, lambda);
  const result = Math.min(1, cdf);
  if (_poissonCache.size >= 500) _poissonCache.clear();
  _poissonCache.set(key, result);
  return result;
}

// PMF Poisson em log-espaço: e^(k·ln(λ) − λ − ln(k!))
// Estável para qualquer lambda (sem overflow de factorial para k grandes)
function poissonPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(k * Math.log(lambda) - lambda - logFactorial(k));
}

// ln(k!) — Stirling para k > 20 (erro < 0.01%), iterativo para k ≤ 20
function logFactorial(n) {
  if (n <= 1) return 0;
  if (n > 20) return n * Math.log(n) - n + 0.5 * Math.log(2 * Math.PI * n);
  let r = 0;
  for (let i = 2; i <= n; i++) r += Math.log(i);
  return r;
}

function round(n) { return Math.round(n * 1000) / 1000; }
