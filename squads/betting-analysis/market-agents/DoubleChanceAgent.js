import { BaseMarketAgent } from './BaseMarketAgent.js';
export class DoubleChanceAgent extends BaseMarketAgent {
  constructor() { super({ name: 'Dupla Chance', market: 'Dupla Chance', promptFile: 'double-chance.txt' }); }
}
