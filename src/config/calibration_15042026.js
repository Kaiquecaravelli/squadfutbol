/**
 * calibration_15042026.js — Calibração derivada da Auditoria de 15/04/2026
 *
 * Fonte de verdade: 7 sinais GREEN verificados empiricamente.
 * Toda mudança de peso tem jogo de referência documentado.
 * Próxima revisão: após acumular +7 sinais GREEN auditados.
 *
 * Jogos de referência:
 *   [A1] Sport Boys vs Melgar        1-3   GREEN · Resultado visitante superior
 *   [A2] Cruz Azul vs LAFC           1-1   GREEN · BTTS/Over 1.5 · duelo equilibrado
 *   [A3] Sacramento vs Minnesota     0-0   GREEN · Under 1.5 · jogo controlado
 *   [B1] Bayern vs Real Madrid       4-3   GREEN ×3 · Over 2.5 / YC / Resultado
 *   [B2] Olimpia vs Barracas         0-0   GREEN · Corners · press sem conversão
 *   [B3] Racing vs Botafogo          2-3   GREEN ×2 · YC / Resultado visitante
 *   [B4] São Paulo vs O'Higgins      2-0   GREEN · Dupla Chance 1X
 */

// ── Pesos das 8 Dimensões — recalibrados 15/04/2026 ─────────────────────────
//
// Método: contagem de dimensão líder por jogo (n=7 GREENs)
//   D4 Contexto Motivacional: 4/7 jogos → sobe para 0.18 (+0.06)
//   D6 Press Index:           2/7 jogos → sobe para 0.12 (+0.02)
//   D2 Forma Recente:         2/7 jogos → sobe para 0.16 (+0.01)
//   D3 H2H:                   2/7 jogos → sobe para 0.13 (+0.01)
//   D7 Momentum:              1/7 jogos → desce para 0.10 (-0.03)
//   D8 Value Mercado:         1/7 jogos → desce para 0.07 (-0.05)
//   D1 Histórico:             3/7 jogos → desce para 0.16 (-0.02)
//   D5 Árbitro:               1/7 jogos → mantido em 0.08
//
// Soma verificada: 0.16+0.16+0.13+0.18+0.08+0.12+0.10+0.07 = 1.00 ✅
export const PESOS = {
  D1_historico_estrutural:  0.16, // -0.02 · [B4, A1, B2] · ainda estrutural mas D4 supera
  D2_forma_recente:         0.16, // +0.01 · [A1, B3] · forma recente crítica para visitante
  D3_h2h:                   0.13, // +0.01 · [A2, B1] · H2H histórico decisivo em UCL/CONCACAF
  D4_contexto_motivacional: 0.18, // +0.06 · [A3, B1, B3, B4] · preditor #1 — 4/7 GREENs
  D5_arbitro:               0.08, //  0.00 · [B3] · relevante mas amostra pequena ainda
  D6_press_index:           0.12, // +0.02 · [B2, B1] · confirma Corners e Over independente placar
  D7_momentum_streak:       0.10, // -0.03 · [A3 implíc.] · menos determinante nessa amostra
  D8_value_mercado:         0.07, // -0.05 · [B1] · técnica supera value nessa amostra
};

// ── Gates por mercado e contexto ─────────────────────────────────────────────
export const GATES = {
  BTTS: {
    padrao:                0.82, // Tier 2 Neutro padrão
    tier1_eredivisie_la:   0.80, // Tier 1 (Eredivisie, LaLiga)
    eliminatorio_eq:       0.80, // ambos precisam marcar — [A2] confirma equilibrado
    sul_am_ofensivo:       0.82, // Sul-Am com BTTS histórico
  },
  OVER15: {
    padrao:                0.78,
    conference_league:     0.80, // PIE real 100% (7/7 KO) — ver correção Conference League
  },
  OVER25: {
    padrao:                0.80,
    ucl_ko_gigantes:       0.78, // [B1] Bayern 4-3 Real — confirma alta prob com 78%
    sul_am_ambos_atacam:   0.80,
  },
  UNDER15: { absoluto: 0.80, permite_escalada: false }, // [A3] 0-0 confirma gate correto
  UNDER25: { absoluto: 0.80, permite_escalada: false },
  CORNERS65: {
    padrao:                0.80,
    press_alto_sem_gols:   0.78, // [B2] 0-0 com xG alto — press sem conversão
  },
  CORNERS75: { padrao: 0.80 },
  CORNERS85: { padrao: 0.80 },
  YC: {
    padrao:                0.78,
    ucl_ko_intensidade:    0.76, // [B1] semifinal/quartas UCL ambos precisam vencer
    sul_am_fisico_tec:     0.78, // [B3] ARG físico em casa vs BRA técnico
  },
  DUPLA_CHANCE_1X: {
    padrao:                0.82, // [B4] mandante favorito vs liga menor
    conmebol_bra_mandante: 0.82,
  },
  DUPLA_CHANCE_X2: { padrao: 0.82 },
  DUPLA_CHANCE_12: { padrao: 0.80 },
};

// ── Padrões P1–P6 — bônus contextuais ────────────────────────────────────────
// Aplicados quando as condições do padrão são detectadas.
// Bônus máximo acumulado por jogo: +0.15 (soma de todos os padrões ativos).
// Padrão ativo deve ser logado para rastreabilidade.
export const BONUS_PADROES = {

  // P1 — Under em jogo controlado por time superior
  // [A3] Sacramento 0-0 Minnesota — MLS vs liga menor · jogo gerenciado
  P1_under_controlado: {
    mercados:   ['Under 1.5', 'Under 2.5'],
    bonus:      +0.08,
    condicao:   'time de nível superior vs liga menor · jogo gerenciado',
    dimensao_lider: 'D4',
    referencia: '[A3] Sacramento vs Minnesota 0-0',
  },

  // P2 — Over 2.5 em UCL KO entre times de elite
  // [B1] Bayern 4-3 Real Madrid — 7 gols · H2H histórico alto
  P2_over_ucl_ko_gigantes: {
    mercados:   ['Over 2.5', 'BTTS'],
    bonus:      +0.10,
    condicao:   'UCL KO (quartas/semi/final) · ambos times com ataque top europeu · H2H média ≥ 3.5',
    dimensao_lider: 'D3+D6',
    referencia: '[B1] Bayern vs Real 4-3',
  },

  // P3 — Corners Over em jogo truncado sul-americano
  // [B2] Olimpia 0-0 Barracas — escanteios GREEN com 0 gols
  P3_corners_press_sem_gols: {
    mercados:   ['Over Corners 6.5', 'Over Corners 7.5'],
    bonus:      +0.10,
    condicao:   'Libertadores/Sul-Am · xG combinado ≥ 2.5 · time casa pressiona sem converter',
    dimensao_lider: 'D6',
    referencia: '[B2] Olimpia vs Barracas 0-0',
  },

  // P4 — YC em Libertadores time físico vs técnico
  // [B3] Racing 2-3 Botafogo — YC GREEN · ARG físico vs BRA técnico
  P4_yc_fisico_vs_tecnico: {
    mercados:   ['YC 3.5', 'YC 4.5'],
    bonus:      +0.08,
    condicao:   'Libertadores grupos/KO · time ARG/URU físico em casa vs time BRA/COL técnico',
    dimensao_lider: 'D5+D4',
    referencia: '[B3] Racing vs Botafogo 2-3',
  },

  // P5 — Resultado Final visitante claramente superior
  // [A1] Sport Boys 1-3 Melgar · [B3] Racing 2-3 Botafogo
  P5_resultado_visitante_superior: {
    mercados:   ['X2', '2'],
    bonus:      +0.07,
    condicao:   'visitante claramente superior + forma recente ≥ 4/5 vitórias',
    dimensao_lider: 'D2+D4',
    referencia: '[A1] Melgar venceu 3-1 · [B3] Botafogo venceu 3-2',
  },

  // P6 — Dupla Chance 1X mandante favorito Sul-Am
  // [B4] São Paulo 2-0 O'Higgins — diferença de nível clara
  P6_dupla_chance_mandante_sul_am: {
    mercados:   ['1X'],
    bonus:      +0.08,
    condicao:   'Sul-Am/Libertadores · time BRA/ARG/MEX mandante vs visitante de liga menor',
    dimensao_lider: 'D4+D1',
    referencia: '[B4] São Paulo vs O\'Higgins 2-0',
  },
};

// ── Metadados ─────────────────────────────────────────────────────────────────
export const META = {
  versao:           '1.0',
  vigente_desde:    '2026-04-15',
  baseado_em:       '7 sinais GREEN auditados — 15/04/2026',
  proxima_revisao:  '2026-04-30',
  jogos_referencia: ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'B4'],
  d4_destaque:      'Contexto Motivacional é o preditor #1 — 4/7 GREENs liderados por D4',
};
