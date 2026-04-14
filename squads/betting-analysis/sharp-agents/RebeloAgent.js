import { BaseAgent } from './BaseAgent.js';

export class RebeloAgent extends BaseAgent {
  constructor() {
    super({
      name: 'Rebelo',
      promptFile: 'rebelo.txt',
      role: 'Arbitragem e Exchange Trading (Paulo Rebelo)',
    });
  }
}
