import { BaseMarketAgent } from './BaseMarketAgent.js';
export class YellowCardsAgent extends BaseMarketAgent {
  constructor() { super({ name: 'Cartões', market: 'Cartões Amarelos', promptFile: 'yellow-cards.txt' }); }
}
