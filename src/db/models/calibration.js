/**
 * calibration.js — Schema de Calibração por Mercado
 *
 * Armazena estatísticas de precisão por mercado, faixa de probabilidade e competição.
 * Essencial para o gate de qualidade do PIE.
 */

import mongoose from 'mongoose';

// Sub-schema para faixas de probabilidade
const rangeStatsSchema = new mongoose.Schema({
  total: { type: Number, default: 0 },
  hits: { type: Number, default: 0 },
}, { _id: false });

// Sub-schema para estatísticas por competição
const competitionStatsSchema = new mongoose.Schema({
  total: { type: Number, default: 0 },
  hits: { type: Number, default: 0 },
}, { _id: false });

const calibrationSchema = new mongoose.Schema({
  market: { type: String, required: true, index: true, unique: true },
  total: { type: Number, default: 0 },
  hits: { type: Number, default: 0 },
  byRange: {
    type: Map,
    of: rangeStatsSchema,
    default: new Map(),
  },
  byCompetition: {
    type: Map,
    of: competitionStatsSchema,
    default: new Map(),
  },
  updated_at: { type: Date, default: Date.now },
}, {
  collection: 'calibration',
  timeseries: false,
});

// Helper para retornar dados formatados
calibrationSchema.methods.toStats = function () {
  const total = this.total || 0;
  const hits = this.hits || 0;
  return {
    total,
    hits,
    accuracy: total > 0 ? ((hits / total) * 100).toFixed(1) : null,
  };
};

export const Calibration = mongoose.model('Calibration', calibrationSchema);