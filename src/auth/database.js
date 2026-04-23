/**
 * src/auth/database.js — SQLite database for BettingSquad Pro auth
 */
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';
import bcrypt from 'bcryptjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..');
const DB_PATH = join(ROOT, 'data', 'bettingsquad.db');

// Garante que o diretório data existe
if (!existsSync(join(ROOT, 'data'))) {
  mkdirSync(join(ROOT, 'data'), { recursive: true });
}

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      trial_expires_at TEXT,
      subscription_expires_at TEXT,
      status TEXT DEFAULT 'trial',
      created_at TEXT DEFAULT (datetime('now')),
      last_login TEXT
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      mp_payment_id TEXT,
      plan TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // Migração: adiciona colunas se não existirem (idempotente)
  const allCols = [
    'superbet_email TEXT',
    'superbet_password_enc TEXT',
    'superbet_connected INTEGER DEFAULT 0',
    'superbet_balance REAL',
    'superbet_balance_text TEXT',
    'superbet_bets TEXT',
    'superbet_last_sync TEXT',
    'login_attempts INTEGER DEFAULT 0',
    'locked_until TEXT',
  ];
  for (const col of allCols) {
    try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch {}
  }

  // Cria admin padrão se não existir
  const admin = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@bettingsquadpro.com');
  if (!admin) {
    const hash = bcrypt.hashSync('Admin@2026!', 10);
    const trialExpires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO users (name, email, password_hash, role, trial_expires_at, subscription_expires_at, status)
      VALUES (?, ?, ?, 'admin', ?, ?, 'active')
    `).run('Admin', 'admin@bettingsquadpro.com', hash, trialExpires, trialExpires);
    console.log('[DB] Admin padrão criado: admin@bettingsquadpro.com');
  }
}

export default getDb;
