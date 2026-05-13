/**
 * result.js — Schema de Resultados Reais
 *
 * Armazena os resultados reais das partidas e o outcome de cada mercado.
 * Usado para atualizar a calibração do PIE.
 */

import mongoose from 'mongoose';

const marketOutcomeSchema = new mongoose.Schema({
  market: { type: String, required: true },
  probabilidade: { type: Number },
  acertou: { type: Boolean },
  competition: { type: String },
}, { _id: false });

const resultSchema = new mongoose.Schema({
  // Armazenado como string para evitar CastError com UUIDs do pie.json
  prediction_id: { type: String, index: true },
  match_name: { type: String },
  placar_real: { type: String },
  competition: { type: String, index: true },
  market_outcomes: [marketOutcomeSchema],
  registered_at: { type: Date, default: Date.now, index: true },
}, {
  collection: 'results',
  timeseries: false,
});

// Index para backfill
resultSchema.index({ competition: 1, registered_at: -1 });

export const Result = mongoose.model('Result', resultSchema);