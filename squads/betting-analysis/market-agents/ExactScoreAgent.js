import { BaseMarketAgent } from './BaseMarketAgent.js';
export class ExactScoreAgent extends BaseMarketAgent {
  constructor() { super({ name: 'Placar Exato', market: 'Placar Exato', promptFile: 'exact-score.txt' }); }
}
