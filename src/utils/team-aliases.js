/**
 * team-aliases.js — Normalização de nomes de times
 * Resolve apelidos e variações para o nome canônico usado no SofaScore.
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir       = dirname(fileURLToPath(import.meta.url));
const ALIASES_PATH = join(__dir, '../../data/team-aliases.json');

let _cache = null;

function _load() {
  if (_cache) return _cache;
  try {
    _cache = existsSync(ALIASES_PATH)
      ? JSON.parse(readFileSync(ALIASES_PATH, 'utf8'))
      : {};
  } catch { _cache = {}; }
  return _cache;
}

/**
 * Resolve nome de time para o nome canônico (lowercase, sem acentos).
 * Tenta: alias exato → prefixo de 5 chars → retorna original normalizado.
 */
export function resolveTeamName(name) {
  if (!name) return '';
  const aliases = _load();
  const normalized = name.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Tentativa 1: match exato
  if (aliases[normalized]) return aliases[normalized];

  // Tentativa 2: o nome já é o canônico (está nos values)
  const values = Object.values(aliases);
  if (values.includes(normalized)) return normalized;

  // Tentativa 3: prefixo (para "manchester" → "manchester city" se único)
  const prefix = normalized.slice(0, 8);
  const prefixMatches = Object.entries(aliases).filter(([k]) => k.startsWith(prefix));
  if (prefixMatches.length === 1) return prefixMatches[0][1];

  return normalized; // retorna normalizado original
}

/** Invalida o cache (útil se aliases.json for atualizado em runtime) */
export function reloadAliases() { _cache = null; }
