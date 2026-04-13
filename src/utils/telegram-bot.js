/**
 * Telegram Bot — Polling de comandos do grupo
 *
 * Comandos dos membros:
 *   /resultado N placar → registra placar real (Green/Red automático)
 *   /grade              → exibe os jogos do dia
 *   /stats              → estatísticas de acerto do modelo PIE
 *   /licoes             → lições aprendidas ativas
 */

import axios from 'axios';

const BASE = 'https://api.telegram.org';

export class TelegramBot {
  constructor({ token, groupId, onGradeRequest, onResultRequest, onStatsRequest, onLicoesRequest, onPerformanceRequest, onScanRequest, onLiveScanRequest, onLive2TRequest }) {
    this.token                = token;
    this.groupId              = String(groupId);
    this.onGradeRequest       = onGradeRequest;
    this.onResultRequest      = onResultRequest;
    this.onStatsRequest       = onStatsRequest;
    this.onLicoesRequest      = onLicoesRequest;
    this.onPerformanceRequest = onPerformanceRequest;
    this.onScanRequest        = onScanRequest;
    this.onLiveScanRequest    = onLiveScanRequest;
    this.onLive2TRequest      = onLive2TRequest;
    this.offset               = 0;
    this.running              = false;
  }

  async start() {
    if (!this.token || !this.groupId) return;
    this.running   = true;
    this.startTime = Math.floor(Date.now() / 1000); // ignora mensagens anteriores ao inicio
    // Avança offset para não reprocessar updates antigos
    await this._skipOldUpdates();
    console.log(`🤖 [Bot] Escutando comandos no grupo...`);
    this._poll().catch((err) => console.error('[Bot] Erro no polling:', err.message));
  }

  async _skipOldUpdates() {
    try {
      const res = await axios.get(`${BASE}/bot${this.token}/getUpdates`, {
        params: { offset: -1, limit: 1 },
        timeout: 10_000,
      });
      const updates = res.data?.result || [];
      if (updates.length) this.offset = updates[updates.length - 1].update_id + 1;
    } catch { /* ignora */ }
  }

  stop() { this.running = false; }

  async _poll() {
    while (this.running) {
      try {
        const res = await axios.get(`${BASE}/bot${this.token}/getUpdates`, {
          params: { offset: this.offset, timeout: 25, allowed_updates: ['message'] },
          timeout: 35_000,
        });

        const updates = res.data?.result || [];
        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this._handleUpdate(update).catch(() => {});
        }
      } catch {
        await sleep(5000);
      }
    }
  }

  async _handleUpdate(update) {
    const msg = update.message;
    if (!msg?.text) return;

    // Aceita somente mensagens do grupo configurado
    if (String(msg.chat.id) !== this.groupId) return;

    // Ignora mensagens anteriores ao início do bot (evita reprocessar)
    if (msg.date < this.startTime) return;

    const text    = msg.text.trim().toLowerCase();
    const user    = msg.from?.first_name || 'Membro';
    const msgId   = msg.message_id;

    // /resultado N placar  (ex: /resultado 3 2-1 ou /resultado3 2x1)
    const resultadoMatch = text.match(/^\/resultado(?:@\w+)?\s*(\d+)\s+([\d]+\s*[-x×:]\s*[\d]+)/i);
    if (resultadoMatch) {
      const idx    = parseInt(resultadoMatch[1]);
      const placar = resultadoMatch[2].trim();
      console.log(`🤖 [Bot] ${user} registrou resultado do jogo #${idx}: ${placar}`);
      await this._deleteMessage(msgId);
      await this.onResultRequest(idx, placar, user);
      return;
    }

    // /grade
    if (text.startsWith('/grade')) {
      console.log(`🤖 [Bot] ${user} solicitou a grade do dia`);
      await this._deleteMessage(msgId);
      await this.onGradeRequest();
      return;
    }

    // /stats
    if (text.startsWith('/stats')) {
      console.log(`🤖 [Bot] ${user} solicitou estatísticas PIE`);
      await this._deleteMessage(msgId);
      await this.onStatsRequest?.(user);
      return;
    }

    // /licoes
    if (text.startsWith('/licoes') || text.startsWith('/lições')) {
      console.log(`🤖 [Bot] ${user} solicitou lições aprendidas`);
      await this._deleteMessage(msgId);
      await this.onLicoesRequest?.(user);
      return;
    }

    // /performance
    if (text.startsWith('/performance') || text.startsWith('/perf') || text.startsWith('/ranking')) {
      console.log(`🤖 [Bot] ${user} solicitou dashboard de performance`);
      await this._deleteMessage(msgId);
      await this.onPerformanceRequest?.(user);
      return;
    }

    // /scan ou /refresh — força um novo ciclo de análise imediatamente
    if (text.startsWith('/scan') || text.startsWith('/refresh') || text.startsWith('/analisar')) {
      console.log(`🤖 [Bot] ${user} solicitou scan manual`);
      await this._deleteMessage(msgId);
      await this.onScanRequest?.(user);
      return;
    }

    // /live2t — dispara análise exclusiva do 2° Tempo
    if (text.startsWith('/live2t') || text.startsWith('/2t') || text.startsWith('/segundotempo')) {
      console.log(`🤖 [Bot] ${user} solicitou análise live 2T`);
      await this._deleteMessage(msgId);
      await this.onLive2TRequest?.(user);
      return;
    }

    // /live ou /inplay — dispara análise de jogos ao vivo (funil geral)
    if (text.startsWith('/live') || text.startsWith('/inplay') || text.startsWith('/aovivo')) {
      console.log(`🤖 [Bot] ${user} solicitou análise live`);
      await this._deleteMessage(msgId);
      await this.onLiveScanRequest?.(user);
      return;
    }

    // /help ou /start ou /ajuda
    if (text.startsWith('/help') || text.startsWith('/start') || text.startsWith('/ajuda')) {
      await this._deleteMessage(msgId);
      await this._sendHelp();
    }
  }

  async _deleteMessage(messageId) {
    try {
      await axios.post(`${BASE}/bot${this.token}/deleteMessage`, {
        chat_id: this.groupId,
        message_id: messageId,
      });
    } catch { /* ignora — bot pode não ter permissão */ }
  }

  async _sendHelp() {
    const text = [
      `🤖  <b>Bet Analysis Squad  —  Comandos</b>`,
      ``,
      `📋  /grade              Jogos do dia`,
      `📊  /resultado N X-X   Registrar placar  (Green / Red automático)`,
      `🧠  /stats              Acurácia do modelo PIE`,
      `📚  /licoes             Lições aprendidas`,
      `🏆  /performance        Ranking dos analistas em tempo real`,
      `🔄  /scan               Forçar novo ciclo de análise agora`,
      `🔴  /live               Análise de jogos ao vivo agora`,
      `🟡  /live2t             Análise exclusiva 2° Tempo (min 46+)`,
      ``,
      `<i>Análises e resultados são processados automaticamente.</i>`,
    ].join('\n');

    await axios.post(`${BASE}/bot${this.token}/sendMessage`, {
      chat_id: this.groupId,
      text,
      parse_mode: 'HTML',
    }).catch(() => {});
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
