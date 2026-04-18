/* ═══════════════════════════════════════════════════════════════
 * AGENTE ELIMINADO — 18/04/2026
 * Nome: DoubleChanceAgent
 * Mercado: Dupla Chance (1X / X2 / 12)
 * Motivo: Pontuação 5/100 — abaixo dos 3 selecionados
 *         Precisão final: 45.4% — desqualificado (<50%)
 *         INATIVO há >14 dias — zero amostras Fire Zone
 * Amostras PIE: 162 (1X: 92 · X2: 70)
 * Condição de reativação: shadow mode 50 amostras ≥ 80% de precisão
 *                         Mín. 3 semanas · gate +5pp no retorno
 * Histórico PIE: PRESERVADO — não deletar
 * ═══════════════════════════════════════════════════════════════
 */

import { BaseMarketAgent } from './BaseMarketAgent.js';

/**
 * DoubleChanceAgent — Dupla Chance (1X / X2 / 12)
 * Fonte primária: Academia das Apostas (probabilidade histórica de mercado)
 * Validação: SofaScore (forma recente, H2H)
 */
export class DoubleChanceAgent extends BaseMarketAgent {
  constructor() {
    super({
      name:              'Dupla Chance',
      market:            'Dupla Chance',
      promptFile:        'double-chance.txt',
      primaryDataSource: 'academia',
    });
  }
}
