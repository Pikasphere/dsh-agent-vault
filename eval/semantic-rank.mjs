/**
 * Throwaway: when a paraphrase case misses, is it the fusion or the retrieval?
 * Ranks the target among all notes by raw cosine, ignoring lexical scores.
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = name => import(`file://${path.join(here, '..', name).replace(/\\/g, '/')}`)
const { createStore } = await load('store.js')
const { createJournals } = await load('journal.js')
const { createRecall } = await load('recall.js')
const { PARAPHRASE_CASES } = await load('eval/cases.mjs')

const store = createStore({ rootDir: os.homedir() + '/.dsh/agent-memory' })
const journals = createJournals({ rootDir: store.root })
const recall = createRecall({ rootDir: store.root, store, journals })
await recall.prepare()

for (const [query, expect] of PARAPHRASE_CASES) {
  const hits = await recall.search({ id: 'demo-agent', query, source: 'journal', limit: 25, expand: 0, mode: 'hybrid', minCosine: 0 })
  const byCosine = hits.results
    .filter(row => row.why?.cosine !== undefined)
    .sort((a, b) => b.why.cosine - a.why.cosine)
  const rank = byCosine.findIndex(row => row.id === expect) + 1
  const target = byCosine.find(row => row.id === expect)
  const top = byCosine[0]
  console.log(
    `${query.padEnd(20)} target cos ${(target?.why?.cosine ?? 0).toFixed(3)}  semantic rank ${rank || '-'}/${byCosine.length}  top1 ${top?.id} ${(top?.why?.cosine ?? 0).toFixed(3)} "${(top?.title ?? '').slice(0, 18)}"`,
  )
}

// The native ORT session keeps the event loop alive on some runs; exit
// explicitly so a finished eval does not hang the shell.
process.exit(0)
