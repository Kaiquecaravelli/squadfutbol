/**
 * prediction.js — Schema de Predições
 *
 * Armazena todas as previsões geradas pelo PIE.
 * Cada predição contém múltiplos mercados (BTTS, Over 1.5, etc.)
 */

import mongoose from 'mongoose';

const marketSchema = new mongoose.Schema({
  market: { type: String, required: true },
  recommendation: { type: String },
  probabilidade: { type: Number },
  confianca: { type: Number, default: 0 },
  odds_minima: { type: Number },
  ev_estimado: { type: Number },
}, { _id: false });

const predictionSchema = new mongoose.Schema({
  idx: { type: Number, index: true },
  match_id: { type: String, index: true },
  match_name: { type: String },
  competition: { type: String, index: true },
  match_date: { type: String },
  sofascore_id: { type: Number, index: true },
  kickoff_time: { type: Date },
  xg_home: { type: Number },
  xg_away: { type: Number },
  markets: [marketSchema],
  created_at: { type: Date, default: Date.now, index: true },
  // Armazenado como string para evitar CastError com UUIDs do pie.json
  result_id: { type: String },
}, {
  collection: 'predictions',
  timeseries: false,
});

// Index para consultas frequentes
predictionSchema.index({ competition: 1, created_at: -1 });
predictionSchema.index({ result_id: 1 });

export const Prediction = mongoose.model('Prediction', predictionSchema);