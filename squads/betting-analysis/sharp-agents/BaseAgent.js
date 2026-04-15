import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { callGroqWithRotation } from '../../../src/utils/groq-key-manager.js';
import {
  cacheGet, cacheSet,
  compactMatchData,
  trackCall, trackCacheHit,
  flushStats,
} from '../../../src/utils/groq-token-economy.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, '../prompts');

export class BaseAgent {
  /**
   * @param {object} config
   * @param {string} config.name        - Nome do agente (ex: "Rebelo")
   * @param {string} config.promptFile  - Nome do arquivo .txt em prompts/ (ex: "rebelo.txt")
   * @param {string} config.role        - Função resumida (ex: "Arbitragem e Exchange Trading")
   */
  constructor({ name, promptFile, role }) {
    this.name       = name;
    this.promptFile = promptFile;
    this.role       = role;
    this.provider   = (process.env.AI_PROVIDER || 'groq').toLowerCase();
    this.systemPrompt = this._loadPrompt();
  }

  // ── Carrega o prompt do arquivo .txt ────────────────────────────────────────
  _loadPrompt() {
    const filePath = join(PROMPTS_DIR, this.promptFile);
    try {
      return readFileSync(filePath, 'utf-8').trim();
    } catch (err) {
      throw new Error(`[${this.name}] Prompt não encontrado: ${filePath} — ${err.message}`);
    }
  }

  // ── Monta payload comprimido (economia de tokens: remove nulos, limita arrays) ─
  _buildUserMessage(matchData) {
    const compact = compactMatchData(matchData);
    return `Retorne APENAS o JSON do schema. DADOS:\n${JSON.stringify(compact)}`;
  }

  // ── Extrai JSON limpo da resposta da IA ─────────────────────────────────────
  _parseResponse(text) {
    let clean = text
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    try { return JSON.parse(clean); } catch {}

    const match = clean.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}

      let depth = 0, start = -1, end = -1;
      for (let i = 0; i < clean.length; i++) {
        if (clean[i] === '{') { if (depth === 0) start = i; depth++; }
        else if (clean[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (start !== -1 && end !== -1) {
        try { return JSON.parse(clean.slice(start, end + 1)); } catch {}
      }
    }

    throw new Error(`[${this.name}] Resposta não contém JSON válido. Raw: ${text.slice(0, 120)}`);
  }

  // ── Chamada Groq com cache + rotação de chaves ───────────────────────────────
  async _callGroq(userMessage, matchName = '') {
    // 1. Verifica cache — mesmo agente + mesma partida na sessão = reusa
    const cached = cacheGet(this.name, matchName);
    if (cached) {
      trackCacheHit();
      return cached;
    }

    // 2. Chamada Groq com rotação de chaves
    trackCall();
    const model = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

    const text = await callGroqWithRotation(async (apiKey) => {
      const res = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model,
          temperature:     0.2,
          max_tokens:      400,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user',   content: userMessage },
          ],
        },
        {
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          timeout: 30_000,
        }
      );
      const t = res.data?.choices?.[0]?.message?.content;
      if (!t) throw new Error(`[${this.name}] Resposta vazia do Groq`);
      return t;
    }, this.name, 18);

    // 3. Armazena no cache para outras chamadas desta sessão
    cacheSet(this.name, matchName, '', text);
    return text;
  }

  // ── Chamada para a API da OpenAI ─────────────────────────────────────────────
  async _callOpenAI(userMessage) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY não configurada no .env');

    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const url   = 'https://api.openai.com/v1/chat/completions';

    const body = {
      model,
      temperature: 0.2,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: this.systemPrompt },
        { role: 'user',   content: userMessage },
      ],
    };

    const res  = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 30_000,
    });
    const text = res.data?.choices?.[0]?.message?.content;
    if (!text) throw new Error(`[${this.name}] Resposta vazia da OpenAI`);
    return text;
  }

  // ── Ponto de entrada principal ────────────────────────────────────────────────
  async analyze(matchData) {
    const userMessage = this._buildUserMessage(matchData);
    const matchName   = matchData?.match || matchData?.match_name || '';

    let rawText;
    if (this.provider === 'openai') {
      rawText = await this._callOpenAI(userMessage);
    } else {
      rawText = await this._callGroq(userMessage, matchName);
    }

    const result = this._parseResponse(rawText);
    return { agent: this.name, role: this.role, ...result };
  }
}
