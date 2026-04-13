/**
 * MemPalace Bridge — Node.js ↔ Python
 *
 * Integra o MemPalace (sistema de memória vetorial) ao projeto squadfutbol.
 * Cada agente pode consultar memórias semânticas antes de analisar,
 * enriquecendo o contexto com lições, padrões e análises passadas.
 *
 * Funcionalidades expostas:
 *   search(query, opts)      — busca semântica no palace
 *   addMemory(text, opts)    — arquiva nova memória (drawer)
 *   kgAdd(s, p, o)           — adiciona fato ao knowledge graph
 *   kgQuery(entity)          — consulta relações de uma entidade
 *   wakeUp()                 — carrega contexto crítico (~170 tokens)
 *   diaryWrite(agent, entry) — registra entrada no diário do agente
 *   diaryRead(agent)         — lê diário recente do agente
 *   status()                 — visão geral do palace
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname     = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT  = join(__dirname, '../../');

// Caminho para o Python com MemPalace instalado
const PYTHON = process.env.MEMPALACE_PYTHON
  || 'C:\\Users\\PCHOME01\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';

const PALACE_PATH = process.env.MEMPALACE_PALACE_PATH
  || join(process.env.USERPROFILE || 'C:\\Users\\PCHOME01', '.mempalace', 'palace');

const WING = process.env.MEMPALACE_WING || 'squadfutbol';

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: executa comando Python MemPalace e retorna JSON
// ─────────────────────────────────────────────────────────────────────────────

async function _runPython(script) {
  try {
    const { stdout } = await execFileAsync(PYTHON, ['-c', script], {
      timeout: 15_000,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    return JSON.parse(stdout.trim());
  } catch (err) {
    // MemPalace indisponível — retorna null silenciosamente (graceful fallback)
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Verificar se MemPalace está disponível
// ─────────────────────────────────────────────────────────────────────────────

let _available = null;

export async function isAvailable() {
  if (_available !== null) return _available;
  try {
    const res = await execFileAsync(PYTHON, ['-c', 'import mempalace; print("ok")'], {
      timeout: 5_000,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    _available = res.stdout.trim() === 'ok';
  } catch {
    _available = false;
  }
  return _available;
}

// ─────────────────────────────────────────────────────────────────────────────
// BUSCA SEMÂNTICA — principal ponto de integração para os agentes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Busca memórias semanticamente relevantes para uma query.
 *
 * @param {string} query   — o que buscar (ex: "BTTS Premier League Arsenal")
 * @param {object} opts
 *   @param {string} opts.room      — filtrar por sala (ex: "src", "squads")
 *   @param {number} opts.nResults  — número de resultados (padrão: 5)
 * @returns {Array<{text, room, similarity, source_file}>}
 */
export async function search(query, { room = null, nResults = 5 } = {}) {
  if (!await isAvailable()) return [];

  const script = `
import json, sys
from mempalace.searcher import search_memories
result = search_memories(
    ${JSON.stringify(query)},
    palace_path=${JSON.stringify(PALACE_PATH)},
    wing=${JSON.stringify(WING)},
    ${room ? `room=${JSON.stringify(room)},` : ''}
    n_results=${nResults},
)
print(json.dumps(result.get('results', [])))
`;
  const results = await _runPython(script);
  return Array.isArray(results) ? results : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// ARQUIVAR MEMÓRIA — salva nova gaveta no palace
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Arquiva um texto como nova memória no palace.
 *
 * @param {string} text      — conteúdo a arquivar
 * @param {object} opts
 *   @param {string} opts.room    — sala destino (ex: "src", "squads")
 *   @param {string} opts.source  — identificador de origem
 */
export async function addMemory(text, { room = 'general', source = 'auto' } = {}) {
  if (!await isAvailable()) return null;

  const script = `
import json, chromadb
client = chromadb.PersistentClient(path=${JSON.stringify(PALACE_PATH)})
try:
    col = client.get_collection("mempalace_drawers")
except:
    col = client.create_collection("mempalace_drawers")
import hashlib, time
doc_id = hashlib.md5((${JSON.stringify(text)} + str(time.time())).encode()).hexdigest()
col.add(
    documents=[${JSON.stringify(text)}],
    ids=[doc_id],
    metadatas=[{"wing": ${JSON.stringify(WING)}, "room": ${JSON.stringify(room)}, "source_file": ${JSON.stringify(source)}}]
)
print(json.dumps({"id": doc_id, "status": "ok"}))
`;
  return await _runPython(script);
}

// ─────────────────────────────────────────────────────────────────────────────
// KNOWLEDGE GRAPH — fatos temporais sobre times, competições, padrões
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adiciona fato ao knowledge graph.
 * Ex: kgAdd('Peñarol', 'btts_rate_last8', '100%')
 */
export async function kgAdd(subject, predicate, object, { validFrom = null, confidence = 0.9 } = {}) {
  if (!await isAvailable()) return null;

  const script = `
import json
from mempalace.knowledge_graph import KnowledgeGraph
kg = KnowledgeGraph(${JSON.stringify(PALACE_PATH)})
kg.add_triple(
    subject=${JSON.stringify(subject)},
    predicate=${JSON.stringify(predicate)},
    object=${JSON.stringify(object)},
    ${validFrom ? `valid_from=${JSON.stringify(validFrom)},` : ''}
    confidence=${confidence},
    source_closet="squadfutbol-agent"
)
print(json.dumps({"status": "ok"}))
`;
  return await _runPython(script);
}

/**
 * Consulta fatos de uma entidade no knowledge graph.
 * Ex: kgQuery('Peñarol') → [{predicate, object, valid_from, ...}]
 */
export async function kgQuery(entity, { direction = 'both', asOf = null } = {}) {
  if (!await isAvailable()) return [];

  const script = `
import json
from mempalace.knowledge_graph import KnowledgeGraph
kg = KnowledgeGraph(${JSON.stringify(PALACE_PATH)})
results = kg.query_entity(
    entity_id=${JSON.stringify(entity.toLowerCase().replace(/\s+/g, '_'))},
    direction=${JSON.stringify(direction)},
    ${asOf ? `as_of=${JSON.stringify(asOf)},` : ''}
)
print(json.dumps(results))
`;
  const res = await _runPython(script);
  return Array.isArray(res) ? res : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// WAKE-UP — contexto crítico para cold start dos agentes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retorna contexto crítico compacto (~170 tokens) para injetar no início
 * de cada ciclo de análise.
 */
export async function wakeUp() {
  if (!await isAvailable()) return '';

  const script = `
import json
from mempalace.searcher import search_memories
# Busca os fatos mais críticos (lições, padrões, calibração)
critical = search_memories(
    "padrões BTTS gols escanteios calibração agentes lições aprendidas",
    palace_path=${JSON.stringify(PALACE_PATH)},
    wing=${JSON.stringify(WING)},
    n_results=3
)
results = critical.get('results', [])
output = []
for r in results:
    text = r.get('text', '')[:300]
    output.append(text)
print(json.dumps({"context": " | ".join(output)}))
`;
  const res = await _runPython(script);
  return res?.context || '';
}

// ─────────────────────────────────────────────────────────────────────────────
// DIÁRIO DO AGENTE — memória persistente entre sessões por agente
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registra entrada no diário de um agente.
 * @param {string} agentName  — ex: "BTTSAgent", "GoalsAgent"
 * @param {string} entry      — o que o agente aprendeu/observou
 */
export async function diaryWrite(agentName, entry) {
  if (!await isAvailable()) return null;

  const timestamped = `[${new Date().toISOString()}] ${entry}`;
  return addMemory(timestamped, {
    room: 'general',
    source: `diary_${agentName}`,
  });
}

/**
 * Lê entradas recentes do diário de um agente.
 * @param {string} agentName  — ex: "BTTSAgent"
 * @param {number} n          — quantas entradas retornar
 */
export async function diaryRead(agentName, n = 5) {
  if (!await isAvailable()) return [];

  const results = await search(`diário ${agentName} aprendizado padrão`, { nResults: n });
  return results.filter((r) => r.source_file?.includes(`diary_${agentName}`));
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS — visão geral do palace
// ─────────────────────────────────────────────────────────────────────────────

export async function status() {
  if (!await isAvailable()) return { available: false };

  const script = `
import json, chromadb
client = chromadb.PersistentClient(path=${JSON.stringify(PALACE_PATH)})
try:
    col = client.get_collection("mempalace_drawers")
    count = col.count()
    print(json.dumps({"available": True, "drawers": count, "wing": ${JSON.stringify(WING)}, "palace": ${JSON.stringify(PALACE_PATH)}}))
except Exception as e:
    print(json.dumps({"available": True, "drawers": 0, "error": str(e)}))
`;
  return await _runPython(script) || { available: false };
}
