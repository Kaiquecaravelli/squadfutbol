import { BaseMarketAgent } from './BaseMarketAgent.js';

/**
 * GoalsAgent — Over/Under Gols
 * Fonte primária: Academia das Apostas (probabilidade histórica de mercado)
 * Validação: SofaScore (xG técnico)
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
}
