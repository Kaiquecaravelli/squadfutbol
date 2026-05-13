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

  console.log('[MongoDB] DEBUG - MONGODB_URI:', uri ? 'PRESENTE' : 'UNDEFINED');
  console.log('[MongoDB] DEBUG - Valor:', uri ? uri.substring(0, 30) + '...' : 'N/A');

  if (!uri) {
    console.error('[MongoDB] ❌ MONGODB_URI está undefined!');
    console.error('[MongoDB] Variáveis de ambiente disponíveis:');
    console.error(Object.keys(process.env).filter(k => k.includes('MONGO') || k.includes('DB')));
    throw new Error('[MongoDB] MONGODB_URI não configurado — defina a variável de ambiente');
  }

  _connectionPromise = (async () => {
    try {
      console.log('[MongoDB] Tentando conectar ao Atlas...');

      await mongoose.connect(uri, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        connectTimeoutMS: 10000,
      });

      _isConnected = true;
      console.log('[MongoDB] ✅ Conectado ao Atlas com sucesso!');

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
      console.error('[MongoDB] ❌ ERRO DETALHADO:');
      console.error('   - Código:', err.code);
      console.error('   - Mensagem:', err.message);
      console.error('   - Nome:', err.name);

      if (err.message.includes('authentication')) {
        console.error('   → Falha na autenticação! Verifique usuário/senha.');
      } else if (err.message.includes('ENOTFOUND') || err.message.includes('getaddrinfo')) {
        console.error('   → DNS não resolveu! Verifique o hostname.');
      } else if (err.message.includes('timeout')) {
        console.error('   → Timeout! Rede lenta ou IP não liberado no Atlas.');
      } else if (err.message.includes('SCRAM')) {
        console.error('   → Problema de autenticação SCRAM! Senha pode estar errada.');
      }

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