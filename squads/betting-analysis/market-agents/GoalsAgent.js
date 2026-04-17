import { BaseMarketAgent } from './BaseMarketAgent.js';

// Priors de λ por liga — usados quando times não têm stats no SofaScore
// Fonte: média histórica de gols/jogo por liga × multiplicador casa/fora
const LAMBDA_PRIORS = {
  'conference league':      { home: 1.60, away: 0.80 }, // padrão real: favorito domina, Over 1.5=100% PIE
  'liga conference':        { home: 1.60, away: 0.80 },
  'copa sudamericana':      { home: 1.05, away: 0.95 },
  'copa libertadores':      { home: 1.10, away: 1.00 },
  'liga profesional':       { home: 1.15, away: 1.05 },
  'bundesliga':             { home: 1.45, away: 1.30 },
  'eredivisie':             { home: 1.45, away: 1.30 },
  'champions league':       { home: 1.40, away: 1.25 },
  'laliga':                 { home: 1.35, away: 1.20 },
  'la liga':                { home: 1.35, away: 1.20 },
  'premier league':         { home: 1.35, away: 1.20 },
  'serie a':                { home: 1.35, away: 1.20 },
  'brasileirão':            { home: 1.30, away: 1.15 },
  'ligue 1':                { home: 1.30, away: 1.15 },
};
const LAMBDA_PRIOR_DEFAULT = { home: 1.25, away: 1.15 };

function _getLambdaPrior(competition = '') {
  const comp = competition.toLowerCase();
  for (const [key, val] of Object.entries(LAMBDA_PRIORS)) {
    if (comp.includes(key)) return val;
  }
  return LAMBDA_PRIOR_DEFAULT;
}

/**
 * GoalsAgent — Over/Under Gols
 * Fonte primária: Academia das Apostas (probabilidade histórica de mercado)
 * Validação: SofaScore (xG técnico, janelas temporais)
 *
 * v2.1 (2026-04-16): análise bidirecional — injeta lambda estimado, priors de liga
 * e sinal under_1_5_candidato para que o LLM analise Under quando Over está bloqueado.
 * Sem este módulo, ligas defensivas (Conference League) geravam prob 0% silenciosamente.
 */
export class GoalsAgent extends BaseMarketAgent {
  constructor() {
    super({
      name:              'Gols',
      market:            'Total de Gols',
      promptFile:        'goals.txt',
      primaryDataSource: 'academia',
    });
  }

  /**
   * Injeta taxas Over 1.5 por janela, divergência de tendência,
   * estimativa de λ e sinal Under 1.5 quando λ_total < 1.8.
   *
   * O λ_total_estimado e under_1_5_candidato são consumidos pelo goals.txt (v2.1)
   * para acionar a análise bidirecional quando Over está em Kill Zone.
   */
  _buildAgentExtras(matchData) {
    const h    = matchData.home || {};
    const a    = matchData.away || {};
    const comp = matchData.competition || '';
    const extras = {};

    // ── Taxas Over 1.5 por janela temporal ───────────────────────────────────
    if (h.over15_pct_5j != null) extras.over15_5j_casa = h.over15_pct_5j;
    if (h.over15_pct_8j != null) extras.over15_8j_casa = h.over15_pct_8j;
    if (a.over15_pct_5j != null) extras.over15_5j_fora = a.over15_pct_5j;
    if (a.over15_pct_8j != null) extras.over15_8j_fora = a.over15_pct_8j;

    // Divergência entre janelas — sinal de tendência em mudança
    // > 25pp = padrão estrutural e recente divergem → reduzir confiança -5pp
    if (h.over15_pct_5j != null && h.over15_pct_8j != null) {
      const div = Math.abs(h.over15_pct_5j - h.over15_pct_8j);
      if (div > 0) extras.divergencia_over15_casa = div;
    }
    if (a.over15_pct_5j != null && a.over15_pct_8j != null) {
      const div = Math.abs(a.over15_pct_5j - a.over15_pct_8j);
      if (div > 0) extras.divergencia_over15_fora = div;
    }

    // ── Estimativa de λ e sinal Under 1.5 ────────────────────────────────────
    // Detecta quando ambos os times têm stats ausentes (times desconhecidos no SofaScore)
    const hGoals = h.goals_scored_avg || 0;
    const hXg    = h.xg_avg || 0;
    const aGoals = a.goals_scored_avg || 0;
    const aXg    = a.xg_avg || 0;
    const statsAusentes = (hGoals === 0 && hXg === 0) && (aGoals === 0 && aXg === 0);

    let lambdaHome, lambdaAway;
    if (statsAusentes) {
      // Sem stats reais → usar priors de liga para evitar prob 0%
      const prior = _getLambdaPrior(comp);
      lambdaHome = prior.home;
      lambdaAway = prior.away;
      extras.stats_ausentes   = true;
      extras.lambda_prior_usado = true;
    } else {
      // Calcula λ a partir das stats disponíveis (média dos campos não-zero)
      const hVals = [hGoals, hXg].filter((v) => v > 0);
      const aVals = [aGoals, aXg].filter((v) => v > 0);
      lambdaHome = hVals.length ? hVals.reduce((s, v) => s + v, 0) / hVals.length : _getLambdaPrior(comp).home;
      lambdaAway = aVals.length ? aVals.reduce((s, v) => s + v, 0) / aVals.length : _getLambdaPrior(comp).away;
    }

    const lambdaTotal = Math.round((lambdaHome + lambdaAway) * 100) / 100;
    extras.lambda_total_estimado = lambdaTotal;

    // Sinal Under 1.5: quando λ_total < 1.8 o mercado Under 1.5 pode ser viável
    if (lambdaTotal < 1.8) {
      extras.under_1_5_candidato = true;
      // Estimativa Poisson: P(Under 1.5) = P(0 gols) + P(1 gol)
      const p0 = Math.exp(-lambdaTotal);
      const p1 = lambdaTotal * Math.exp(-lambdaTotal);
      extras.under_1_5_prob_estimada = Math.round((p0 + p1) * 100);
    }

    return Object.keys(extras).length ? extras : null;
  }
}
