/**
 * How much of each note actually reaches the encoder?
 *
 * BGE's context is 512 tokens (`embed.js` truncates there). This prints the
 * token distribution of the journal layer and how many notes are cut off, so a
 * "chunking" decision rests on a measured number instead of a guess.
 *
 *   node eval/token-check.mjs [--dir <memoryDir>] [--agent <agentId>]
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = name => import(`file://${path.join(here, '..', name).replace(/\\/g, '/')}`)
const { createStore } = await load('store.js')
const { createJournals } = await load('journal.js')
const { loadVocab, encode, MAX_TOKENS } = await load('embed.js')

const argv = process.argv.slice(2)
const flag = name => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? '' : String(argv[at + 1] ?? '')
}
const memoryDir = flag('dir') || process.env.AGENT_MEMORY_DIR || path.join(os.homedir(), '.dsh', 'agent-memory')
const agentId = flag('agent') || 'demo-agent'

const store = createStore({ rootDir: memoryDir })
const journals = createJournals({ rootDir: store.root })
const modelDir = path.join(store.root, 'models', 'bge-small-zh-v1.5')
const vocab = loadVocab(modelDir)

const notes = journals.notes(agentId)
if (notes.length === 0) {
  console.log(`no notes for ${agentId}`)
  process.exit(1)
}

const rows = notes.map(note => {
  const text = `${note.title ?? ''}\n${note.text ?? ''}`
  const ids = encode(text, vocab, 100000)
  return { id: note.id, title: note.title ?? '', chars: text.length, tokens: ids.length, truncated: ids.length >= MAX_TOKENS }
})
rows.sort((a, b) => b.tokens - a.tokens)

const quantile = (list, q) => list[Math.min(list.length - 1, Math.floor(q * list.length))]
const tokens = rows.map(row => row.tokens).sort((a, b) => a - b)
const cut = rows.filter(row => row.truncated)

console.log(`${rows.length} notes (agent ${agentId}), encoder limit ${MAX_TOKENS} tokens`)
console.log(`tokens per note: min ${tokens[0]}, p25 ${quantile(tokens, 0.25)}, median ${quantile(tokens, 0.5)}, p75 ${quantile(tokens, 0.75)}, max ${tokens[tokens.length - 1]}`)
console.log(`truncated: ${cut.length}/${rows.length} (${((cut.length / rows.length) * 100).toFixed(0)}%), ${cut.reduce((sum, row) => sum + row.tokens - MAX_TOKENS, 0)} tokens never reach the encoder`)
console.log('')
console.log('the eight longest:')
for (const row of rows.slice(0, 8)) {
  const lost = row.tokens > MAX_TOKENS ? ` (-${row.tokens - MAX_TOKENS} cut)` : ''
  console.log(`  ${String(row.tokens).padStart(4)} tokens  ${String(row.chars).padStart(5)} chars  ${row.title.slice(0, 34).padEnd(34)}${lost}`)
}
