/**
 * src/auth/auth.js — Funções de autenticação BettingSquad Pro
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getDb } from './database.js';

const JWT_SECRET = process.env.JWT_SECRET || 'bettingsquad_secret_2026';
const JWT_EXPIRES = '7d';
const TRIAL_DAYS = 7;
const ENC_KEY = (JWT_SECRET + '00000000000000000000000000000000').slice(0, 32);

function _encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENC_KEY), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}

function _decrypt(text) {
  try {
    const [ivHex, encHex] = (text || '').split(':');
    const iv  = Buffer.from(ivHex, 'hex');
    const enc = Buffer.from(encHex, 'hex');
    const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENC_KEY), iv);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch { return null; }
}

export function registerUser(name, email, password) {
  const db = getDb();

  if (!name || !email || !password) throw new Error('Nome, email e senha são obrigatórios');
  if (password.length < 6) throw new Error('Senha deve ter pelo menos 6 caracteres');

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) throw new Error('Este email já está cadastrado');

  const hash = bcrypt.hashSync(password, 10);
  const trialExpires = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const result = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, trial_expires_at, status)
    VALUES (?, ?, ?, 'user', ?, 'trial')
  `).run(name.trim(), email.toLowerCase().trim(), hash, trialExpires);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  return { user: sanitizeUser(user), token: generateToken(user) };
}

export function loginUser(email, password) {
  const db = getDb();

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase());

  // Resposta genérica — não revela se o email existe
  if (!user) throw new Error('Email ou senha incorretos');

  // Verificar account lockout
  if (user.locked_until) {
    const lockedUntil = new Date(user.locked_until);
    if (lockedUntil > new Date()) {
      const mins = Math.ceil((lockedUntil - Date.now()) / 60_000);
      throw new Error(`Conta bloqueada temporariamente. Tente novamente em ${mins} minuto(s).`);
    }
    // Lockout expirou — resetar
    db.prepare('UPDATE users SET login_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
  }

  if (user.status === 'blocked') throw new Error('Conta bloqueada. Entre em contato com o suporte.');

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    // Incrementar tentativas falhas
    const attempts = (user.login_attempts || 0) + 1;
    if (attempts >= 10) {
      // Bloquear por 30 minutos
      const lockUntil = new Date(Date.now() + 30 * 60_000).toISOString();
      db.prepare('UPDATE users SET login_attempts = ?, locked_until = ? WHERE id = ?').run(attempts, lockUntil, user.id);
      throw new Error('Conta bloqueada por 30 minutos após múltiplas tentativas incorretas.');
    }
    db.prepare('UPDATE users SET login_attempts = ? WHERE id = ?').run(attempts, user.id);
    throw new Error('Email ou senha incorretos');
  }

  // Login bem-sucedido — resetar contadores e atualizar último login
  db.prepare('UPDATE users SET login_attempts = 0, locked_until = NULL, last_login = ? WHERE id = ?')
    .run(new Date().toISOString(), user.id);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  return { user: sanitizeUser(updated), token: generateToken(updated) };
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

export function getUserById(id) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return null;
  return sanitizeUser(user);
}

export function checkAccess(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.status === 'blocked') return false;

  const now = new Date();

  // Verifica subscription ativa
  if (user.subscription_expires_at) {
    const subExp = new Date(user.subscription_expires_at);
    if (subExp > now) return true;
  }

  // Verifica trial ativo
  if (user.status === 'trial' && user.trial_expires_at) {
    const trialExp = new Date(user.trial_expires_at);
    if (trialExp > now) return true;
  }

  return false;
}

export function getAllUsers() {
  const db = getDb();
  const users = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  return users.map(sanitizeUser);
}

export function updateUser(id, data) {
  const db = getDb();
  const allowed = ['name', 'status', 'role', 'trial_expires_at', 'subscription_expires_at'];
  const fields = Object.keys(data).filter(k => allowed.includes(k));
  if (!fields.length) throw new Error('Nenhum campo válido para atualizar');

  const sets = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => data[f]);
  db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...values, id);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return sanitizeUser(updated);
}

export function getUserPayments(userId) {
  const db = getDb();
  return db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

export function createPaymentRecord(userId, plan, amount, mpPaymentId = null) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO payments (user_id, mp_payment_id, plan, amount, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(userId, mpPaymentId, plan, amount);
  return result.lastInsertRowid;
}

export function activateSubscription(userId, plan, days) {
  const db = getDb();
  const now = new Date();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

  // Se já tem subscription ativa, extende a partir dela
  let base = now;
  if (user?.subscription_expires_at) {
    const current = new Date(user.subscription_expires_at);
    if (current > now) base = current;
  }

  const expires = new Date(base.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    UPDATE users SET subscription_expires_at = ?, status = 'active' WHERE id = ?
  `).run(expires, userId);

  db.prepare(`
    UPDATE payments SET status = 'approved' WHERE user_id = ? AND status = 'pending'
  `).run(userId);
}

export function saveSuperbetCredentials(userId, email, password) {
  const db = getDb();
  db.prepare(`
    UPDATE users SET superbet_email = ?, superbet_password_enc = ?, superbet_connected = 1
    WHERE id = ?
  `).run(email.trim().toLowerCase(), _encrypt(password), userId);
}

export function getSuperbetCredentials(userId) {
  const db = getDb();
  const u = db.prepare('SELECT superbet_email, superbet_password_enc, superbet_connected FROM users WHERE id = ?').get(userId);
  if (!u?.superbet_email) return null;
  return { email: u.superbet_email, password: _decrypt(u.superbet_password_enc), connected: u.superbet_connected === 1 };
}

export function updateUserSuperbetData(userId, { balance, balanceText, bets, lastSync } = {}) {
  const db = getDb();
  const sets = [], vals = [];
  if (balance     !== undefined) { sets.push('superbet_balance = ?');       vals.push(balance); }
  if (balanceText !== undefined) { sets.push('superbet_balance_text = ?');  vals.push(balanceText); }
  if (bets        !== undefined) { sets.push('superbet_bets = ?');          vals.push(bets ? JSON.stringify(bets) : null); }
  if (lastSync    !== undefined) { sets.push('superbet_last_sync = ?');     vals.push(lastSync); }
  if (!sets.length) return;
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, userId);
}

export function getUserSuperbetData(userId) {
  const db = getDb();
  const u = db.prepare(`
    SELECT superbet_email, superbet_connected, superbet_balance, superbet_balance_text, superbet_bets, superbet_last_sync
    FROM users WHERE id = ?
  `).get(userId);
  if (!u) return null;
  return {
    connected:   u.superbet_connected === 1,
    email:       u.superbet_email || null,
    balance:     u.superbet_balance ?? null,
    balanceText: u.superbet_balance_text || null,
    bets:        u.superbet_bets ? (() => { try { return JSON.parse(u.superbet_bets); } catch { return null; } })() : null,
    lastSync:    u.superbet_last_sync || null,
  };
}

// Inicializa o DB na importação do módulo
getDb();

function generateToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, ...safe } = user;
  return safe;
}
