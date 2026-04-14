import { BaseAgent } from './BaseAgent.js';

export class RanogajacAgent extends BaseAgent {
  constructor() {
    super({
      name: 'Ranogajac',
      promptFile: 'ranogajac.txt',
      role: 'Volume Astronômico e Arbitragem Global (Zeljko Ranogajac)',
    });
  }
}
