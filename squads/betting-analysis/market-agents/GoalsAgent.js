import { BaseMarketAgent } from './BaseMarketAgent.js';
export class GoalsAgent extends BaseMarketAgent {
  constructor() { super({ name: 'Gols', market: 'Total de Gols', promptFile: 'goals.txt' }); }
}
