/**
 * models/index.js — Exporta todos os schemas Mongoose
 *
 * Importação centralizada de todos os modelos para uso no projeto.
 * Uso:
 *   import { Prediction, Result, Lesson, Calibration, LambdaFator } from '../db/models/index.js';
 */

export { Prediction } from './prediction.js';
export { Result } from './result.js';
export { Lesson } from './lesson.js';
export { Calibration } from './calibration.js';
export { LambdaFator } from './lambdaFator.js';

/**
 * Exporta todos os modelos em um objeto para fácil acesso.
 * @returns {Object} { Prediction, Result, Lesson, Calibration, LambdaFator }
 */
export function getAllModels() {
  return {
    Prediction: require('./prediction.js').Prediction,
    Result: require('./result.js').Result,
    Lesson: require('./lesson.js').Lesson,
    Calibration: require('./calibration.js').Calibration,
    LambdaFator: require('./lambdaFator.js').LambdaFator,
  };
}