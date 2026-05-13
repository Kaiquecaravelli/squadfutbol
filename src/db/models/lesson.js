/**
 * lesson.js — Schema de Lições Aprendidas
 *
 * Armazena as lições do PIE (padrões que falharam ou成功了).
 * Usado para injetar contexto nos agentes.
 */

import mongoose from 'mongoose';

const lessonSchema = new mongoose.Schema({
  market: { type: String, index: true },
  competition: { type: String, index: true },
  directive: { type: String, required: true },
  error_type: { type: String }, // 'calibration', 'model_failure', 'context', etc.
  weight: { type: Number, default: 1 },
  active: { type: Boolean, default: true, index: true },
  applied_count: { type: Number, default: 0 },
  source_prediction_id: { type: String },
  created_at: { type: Date, default: Date.now },
  last_seen: { type: Date, default: Date.now },
}, {
  collection: 'lessons',
});

// Index para queries frequentes
lessonSchema.index({ active: 1, weight: -1, applied_count: -1 });
lessonSchema.index({ competition: 1, market: 1 });

export const Lesson = mongoose.model('Lesson', lessonSchema);