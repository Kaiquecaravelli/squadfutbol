/**
 * mongo-connection.js — Conexão MongoDB Atlas
 *
 * Gerencia a conexão com MongoDB Atlas para o SquadFutbol Serverless.
 * Suporta caching de conexão para execuções em cold start.
 */

import mongoose from 'mongoose';

let _isConnected = false;
let _connectionPromise = null;

/**
 * Conecta ao MongoDB Atlas usando MONGODB_URI.
 * Executa apenas uma conexão por execução ( singleton em memória ).
 *
 * @returns {Promise<typeof mongoose>} instância do mongoose
 */
export async function connectDB() {
  // Se já conectado nesta execução, retorna a conexão ativa
  if (_isConnected && mongoose.connection.readyState === 1) {
    return mongoose;
  }

  // Se há uma conexão pendente, espera ela
  if (_connectionPromise) {
    return _connectionPromise;
  }

  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error('[MongoDB] MONGODB_URI não configurado — defina a variável de ambiente');
  }

  _connectionPromise = (async () => {
    try {
      await mongoose.connect(uri, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      });

      _isConnected = true;
      console.log('[MongoDB] ✅ Conectado ao Atlas');

      // Event listeners para monitoring
      mongoose.connection.on('error', (err) => {
        console.error('[MongoDB] Erro na conexão:', err.message);
        _isConnected = false;
      });

      mongoose.connection.on('disconnected', () => {
        console.warn('[MongoDB] Desconectado do Atlas');
        _isConnected = false;
      });

      return mongoose;
    } catch (err) {
      _connectionPromise = null;
      throw new Error(`[MongoDB] Falha ao conectar: ${err.message}`);
    }
  })();

  return _connectionPromise;
}

/**
 * Retorna o estado atual da conexão.
 * @returns {boolean}
 */
export function isConnected() {
  return _isConnected && mongoose.connection.readyState === 1;
}

/**
 * Fecha a conexão com MongoDB.
 * Útil para testes ou cleanup em serverless cold starts.
 * @returns {Promise<void>}
 */
export async function disconnectDB() {
  if (_isConnected) {
    await mongoose.disconnect();
    _isConnected = false;
    _connectionPromise = null;
    console.log('[MongoDB] 🔌 Conexão fechada');
  }
}

/**
 * Retorna a instância do mongoose para operações diretas.
 * @returns {typeof mongoose}
 */
export function getMongoose() {
  return mongoose;
}