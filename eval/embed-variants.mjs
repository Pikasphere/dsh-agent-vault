/**
 * Throwaway experiment: does whole-note embedding dilute the meaning?
 * bge-small truncates at 512 word-pieces, and these notes are long with a
 * generic opener ("1.2.0-beta.4: …"), so the title's topic can drown.
 *
 * Compares three inputs per note, all against the same 15 paraphrase queries:
 *   full    — title + "\n" + text (what vectors.js embeds today)
 *   head    — title + first 240 chars of text
 *   title   — the title alone
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = name => import(`file://${path.join(here, '..', name).replace(/\\/g, '/')}`)
const { createStore } = await load('store.js')
const { createJournals } = await load('journal.js')
const { createEmbedder, cosine, QUERY_PREFIX } = await load('embed.js')
const { PARAPHRASE_CASES } = await load('eval/cases.mjs')

const store = createStore({ rootDir: os.homedir() + '/.dsh/agent-memory' })
const journals = createJournals({ rootDir: store.root })
const notes = journals.notes('demo-agent')

const modelDir = path.join(os.homedir(), '.dsh', 'agent-memory', 'models', 'bge-small-zh-v1.5')
const embedder = createEmbedder({ modelDir })
await embedder.load()

const variants = {
  full: note => `${note.title}\n${note.text}`,
  head: note => `${note.title}\n${note.text.slice(0, 240)}`,
  title: note => note.title,
}

function normalise(vector) {
  let sum = 0
  for (const value of vector) sum += value * value
  const length = Math.sqrt(sum) || 1
  return vector.map(value => value / length)
}

const queries = PARAPHRASE_CASES.map(([query]) => query)
const queryVectors = []
for (const query of queries) queryVectors.push(normalise((await embedder.embed(`${QUERY_PREFIX}${query}`))[0]))

for (const [name, build] of Object.entries(variants)) {
  const noteVectors = []
  for (const note of notes) noteVectors.push(normalise((await embedder.embed(build(note)))[0]))

  let top1 = 0
  let mrr = 0
  let inTop5 = 0
  for (const [index, [, expect]] of PARAPHRASE_CASES.entries()) {
    const scored = notes
      .map((note, position) => ({ id: note.id, score: cosine(queryVectors[index], noteVectors[position]) }))
      .sort((a, b) => b.score - a.score)
    const rank = scored.findIndex(row => row.id === expect) + 1
    top1 += rank === 1 ? 1 : 0
    inTop5 += rank <= 5 ? 1 : 0
    mrr += 1 / rank
  }
  console.log(
    `${name.padEnd(6)} semantic-only: top-1 ${String(top1).padStart(2)}/${queries.length}  top-5 ${String(inTop5).padStart(2)}/${queries.length}  MRR ${(mrr / queries.length).toFixed(3)}`,
  )
}

// The native ORT session keeps the event loop alive on some runs; exit
// explicitly so a finished eval does not hang the shell.
process.exit(0)
