import { BaseAgent } from './BaseAgent.js';

export class BloomAgent extends BaseAgent {
  constructor() {
    super({
      name: 'Bloom',
      promptFile: 'bloom.txt',
      role: 'Probabilidade Estatística e Volume (Tony Bloom)',
    });
  }
}
