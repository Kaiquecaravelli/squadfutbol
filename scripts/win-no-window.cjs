/**
 * win-no-window.cjs — Patch global: suprime janelas de console no Windows
 *
 * Carregado via --require ANTES de qualquer módulo ESM/CJS.
 * Intercepta child_process.spawn / execFile / exec e força windowsHide:true
 * em TODOS os processos filhos — incluindo os spawns internos do Playwright.
 *
 * Por que é necessário:
 *   No Windows 11 com Windows Terminal como terminal padrão, qualquer processo
 *   filho que crie um console (mesmo headless) abre uma aba no Windows Terminal.
 *   O Playwright não passa windowsHide:true internamente, causando aberturas
 *   visíveis de chromium_headless_shell no terminal do usuário.
 *
 * Uso (ecosystem.config.cjs):
 *   interpreter_args: '--require ./scripts/win-no-window.cjs'
 */
'use strict';

if (process.platform !== 'win32') return; // sem efeito em Linux/Mac

const cp = require('child_process');

// ── patch spawn ───────────────────────────────────────────────────────────────
const _spawn = cp.spawn;
cp.spawn = function (file, args, options) {
  // Normaliza sobrecargas: spawn(file) / spawn(file, args) / spawn(file, args, opts)
  if (!Array.isArray(args)) { options = args; args = []; }
  options = options ? { ...options } : {};
  if (options.windowsHide === undefined) options.windowsHide = true;
  return _spawn.call(this, file, args, options);
};

// ── patch spawnSync ───────────────────────────────────────────────────────────
const _spawnSync = cp.spawnSync;
cp.spawnSync = function (file, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  options = options ? { ...options } : {};
  if (options.windowsHide === undefined) options.windowsHide = true;
  return _spawnSync.call(this, file, args, options);
};

// ── patch exec ────────────────────────────────────────────────────────────────
const _exec = cp.exec;
cp.exec = function (command, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  options = options ? { ...options } : {};
  if (options.windowsHide === undefined) options.windowsHide = true;
  return _exec.call(this, command, options, callback);
};

// ── patch execSync ────────────────────────────────────────────────────────────
const _execSync = cp.execSync;
cp.execSync = function (command, options) {
  options = options ? { ...options } : {};
  if (options.windowsHide === undefined) options.windowsHide = true;
  return _execSync.call(this, command, options);
};

// ── patch execFile ────────────────────────────────────────────────────────────
const _execFile = cp.execFile;
cp.execFile = function (file, args, options, callback) {
  // (file, cb) | (file, args, cb) | (file, args, opts, cb)
  if (typeof args === 'function')    { callback = args;    args = [];    options = {}; }
  else if (typeof options === 'function') { callback = options; options = {}; }
  options = options ? { ...options } : {};
  if (options.windowsHide === undefined) options.windowsHide = true;
  if (callback) return _execFile.call(this, file, args, options, callback);
  return _execFile.call(this, file, args, options);
};

// ── patch execFileSync ────────────────────────────────────────────────────────
const _execFileSync = cp.execFileSync;
cp.execFileSync = function (file, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  options = options ? { ...options } : {};
  if (options.windowsHide === undefined) options.windowsHide = true;
  return _execFileSync.call(this, file, args, options);
};

// Registro silencioso — confirma que o patch está ativo
process.env.WIN_NO_WINDOW_PATCHED = '1';
