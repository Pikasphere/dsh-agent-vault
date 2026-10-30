/**
 * Throwaway helper: where does the labelled note actually land under the
 * *keyword* path? That, not token overlap, is what makes a paraphrase case
 * worth keeping — a case the keyword path already ranks first measures
 * nothing about semantics.
 *   node eval/check-cases.mjs
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = name => import(`file://${path.join(here, '..', name).replace(/\\/g, '/')}`)
const { createStore } = await load('store.js')
const { createJournals } = await load('journal.js')
const { createRecall } = await load('recall.js')
const { LEXICAL_CASES, PARAPHRASE_CASES } = await load('eval/cases.mjs')

const store = createStore({ rootDir: os.homedir() + '/.dsh/agent-memory' })
const journals = createJournals({ rootDir: store.root })
// access: false — a measurement run must not read or write the live heat counters,
// otherwise the second eval reports different numbers than the first.
const recall = createRecall({ rootDir: store.root, store, journals, vectors: false , access: false })

async function rankOf(query, expect) {
  const result = await recall.search({
    id: 'demo-agent',
    query,
    source: 'journal',
    limit: 25,
    expand: 0,
    mode: 'lexical',
  })
  const index = result.results.findIndex(row => row.id === expect)
  return { index: index === -1 ? Infinity : index + 1, total: result.total }
}

for (const [family, cases] of [['lexical', LEXICAL_CASES], ['paraphrase', PARAPHRASE_CASES]]) {
  console.log(`\n## ${family}`)
  let good = 0
  for (const [query, expect] of cases) {
    const { index, total } = await rankOf(query, expect)
    // lexical family: must be rank 1. paraphrase family: must NOT be rank 1 —
    // ideally outside the top 3, otherwise the case cannot show semantic lift.
    const verdict = family === 'lexical'
      ? (index === 1 ? 'ok' : `BAD rank=${index}`)
      : (index === 1 ? 'USELESS (lexical already 1st)' : index === Infinity ? 'good (absent)' : `good rank=${index}`)
    if (!String(verdict).startsWith('BAD') && !String(verdict).startsWith('USELESS')) good += 1
    console.log(`  ${query}\t${expect}\tlexical=${index === Infinity ? '-' : index}/${total}\t${verdict}`)
  }
  console.log(`  -> ${good}/${cases.length} usable`)
}

// The native ORT session keeps the event loop alive on some runs; exit
// explicitly so a finished eval does not hang the shell.
process.exit(0)
