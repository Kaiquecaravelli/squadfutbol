/**
 * lambdaFator.js — Schema de Fatores Lambda por Competição
 *
 * Armazena os fatores de calibração aprendidos pelo feed-loop.
 * Cada competição tem seu próprio fator (range 0.75-1.25).
 */

import mongoose from 'mongoose';

const lambdaFatorSchema = new mongoose.Schema({
  competition: { type: String, required: true, index: true, unique: true },
  fator: { type: Number, required: true, min: 0.75, max: 1.25 },
  samples_used: { type: Number, default: 0 },
  accuracy_before: { type: Number },
  accuracy_after: { type: Number },
  updated_at: { type: Date, default: Date.now },
}, {
  collection: 'lambda_fatores',
  timeseries: false,
});

// Middleware para validar range antes de salvar
lambdaFatorSchema.pre('save', function (next) {
  if (this.fator < 0.75) this.fator = 0.75;
  if (this.fator > 1.25) this.fator = 1.25;
  this.updated_at = new Date();
  next();
});

export const LambdaFator = mongoose.model('LambdaFator', lambdaFatorSchema);