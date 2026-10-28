/** Rank, recall, checkpoint isolation and the index cursor. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = name => import(`file://${path.join(here, name).replace(/\\/g, '/')}`)
const { tokenize, scoreEntry, decay, rank } = await load('rank.js')
const { createStore } = await load('store.js')
const { createJournals } = await load('journal.js')
const { createRecall } = await load('recall.js')

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-recall-'))
const knowledgeDir = path.join(scratch, 'kb')
const store = createStore({ rootDir: path.join(scratch, 'mem'), knowledgeDir })
const agent = store.createAgent({ name: 'Recall' })
const journals = createJournals({ rootDir: store.root })
const recall = createRecall({ rootDir: store.root, store, journals })

// ── tokenizer ───────────────────────────────────────────────────────────────
assert.deepEqual(tokenize('归档与取消归档'), ['归档', '档与', '与取', '取消', '消归'])
assert.deepEqual(tokenize('dsh-agent-vault 的 RAG'), ['dsh-agent-vault', 'rag'])
assert.deepEqual(tokenize('   '), [])
assert.ok(!tokenize('the and 的').includes('the'), 'stopwords are dropped')

// ── scoring ─────────────────────────────────────────────────────────────────
const tokens = tokenize('archive')
const titleHit = scoreEntry({ title: 'archive notes', text: '' }, tokens)
const bodyHit = scoreEntry({ title: 'notes', text: 'archive archive archive' }, tokens)
assert.ok(titleHit > bodyHit, `a title hit outweighs repeated body hits (${titleHit} vs ${bodyHit})`)
const oneOfThree = scoreEntry({ title: 'alpha', text: 'alpha beta' }, tokenize('alpha beta gamma'))
const allThree = scoreEntry({ title: 'alpha', text: 'alpha beta gamma' }, tokenize('alpha beta gamma'))
assert.ok(allThree > oneOfThree, 'covering every query term wins')
assert.equal(scoreEntry({ title: 'unrelated', text: 'nothing' }, tokens), 0)
assert.equal(scoreEntry({ title: 'x', text: 'archive' }, []), 0)

// ── decay ───────────────────────────────────────────────────────────────────
const now = Date.parse('2026-06-01T00:00:00.000Z')
assert.equal(decay('2026-06-01T00:00:00.000Z', now), 1)
assert.equal(decay('2026-05-02T00:00:00.000Z', now), 0.5)
assert.ok(decay('not-a-date', now) === 0.5)

// ── rank ────────────────────────────────────────────────────────────────────
const rows = rank(
  [
    { id: 'a', at: '2026-05-31T00:00:00.000Z', title: 'kv cache', text: 'system prompt ordering' },
    { id: 'b', at: '2026-01-01T00:00:00.000Z', title: 'kv cache', text: 'system prompt ordering' },
    { id: 'c', at: '2026-05-31T00:00:00.000Z', title: 'unrelated', text: 'nothing here' },
  ],
  'kv cache',
)
assert.deepEqual(rows.map(row => row.entry.id), ['a', 'b'], 'fresh beats stale, non-matches dropped')
assert.ok(rows[0].score > rows[1].score)

// ── journal: checkpoints live in their own file ─────────────────────────────
journals.write({ id: agent.id, title: 'note one', text: 'right-click menu: archive and unarchive shipped' })
journals.write({ id: agent.id, kind: 'checkpoint', title: 'checkpoint', text: 'authoritative state' })
assert.equal(fs.existsSync(path.join(store.root, 'checkpoints', `${agent.id}.jsonl`)), true)
assert.equal(journals.notes(agent.id).length, 1, 'notes exclude checkpoints')
assert.equal(journals.count(agent.id), 2, 'count still sees both')

// A pre-2.0 file mixing kinds is migrated on first touch, without duplication.
const legacyRoot = path.join(scratch, 'legacy')
fs.mkdirSync(path.join(legacyRoot, 'journal'), { recursive: true })
const legacy = [
  { id: 'j-aaaa1', at: '2026-01-01T00:00:00.000Z', kind: 'note', title: 'old note', text: 'kept' },
  { id: 'j-aaaa2', at: '2026-01-02T00:00:00.000Z', kind: 'checkpoint', title: 'old checkpoint', text: 'moved' },
  { id: 'j-aaaa3', at: '2026-01-03T00:00:00.000Z', kind: 'note', title: 'new note', text: 'kept too' },
]
fs.writeFileSync(
  path.join(legacyRoot, 'journal', `${agent.id}.jsonl`),
  legacy.map(entry => `${JSON.stringify(entry)}\n`).join(''),
  'utf8',
)
const legacyJournals = createJournals({ rootDir: legacyRoot })
assert.equal(legacyJournals.count(agent.id), 3)
assert.equal(legacyJournals.notes(agent.id).length, 2, 'migration keeps notes in place')
const moved = fs
  .readFileSync(path.join(legacyRoot, 'checkpoints', `${agent.id}.jsonl`), 'utf8')
  .trim()
  .split('\n')
  .map(line => JSON.parse(line).id)
assert.deepEqual(moved, ['j-aaaa2'], 'exactly the checkpoint moved, once')
// Idempotent: asking twice does not duplicate.
legacyJournals.notes(agent.id)
const again = fs.readFileSync(path.join(legacyRoot, 'checkpoints', `${agent.id}.jsonl`), 'utf8').trim().split('\n')
assert.equal(again.length, 1, 'second touch does not duplicate the checkpoint')

// ── recall over journal + log + knowledge ───────────────────────────────────
store.writeMemory({ id: agent.id, content: 'archived the sidebar row menu today', note: 'progress' })
store.saveKnowledge({ id: agent.id, title: 'Sidebar context menu', content: 'right-click selection archives rows', tags: ['ui'] })

const hits = recall.search({ id: agent.id, query: 'archive' })
assert.ok(hits.total >= 3, `query hits every source (got ${hits.total})`)
assert.deepEqual(hits.results.map(item => item.src).sort(), ['journal', 'knowledge', 'log'])
assert.equal(hits.results[0].via, 'lexical')
assert.ok(hits.results.every(item => item.score > 0))

const journalOnly = recall.search({ id: agent.id, query: 'right-click', source: 'journal' })
assert.deepEqual(journalOnly.results.map(item => item.src), ['journal'])
assert.equal(journalOnly.results[0].preview.includes('right-click'), true)

const checkpointHit = recall.search({ id: agent.id, query: 'authoritative state' })
assert.equal(checkpointHit.results.some(item => item.title === 'checkpoint'), false, 'a checkpoint is never recalled')

const knowledgeOnly = recall.search({ id: agent.id, query: 'right-click', source: 'knowledge' })
assert.deepEqual(knowledgeOnly.results.map(item => item.src), ['knowledge'])
assert.equal(knowledgeOnly.results[0].id.startsWith('side'), true)

const limited = recall.search({ id: agent.id, query: 'archive', limit: 1 })
assert.equal(limited.results.length, 1)
assert.ok(limited.total > 1, 'total reports every match, not the page')

const since = recall.search({ id: agent.id, query: 'archive', since: '2000-01-01T00:00:00.000Z' })
assert.ok(since.total > 0)
const future = recall.search({ id: agent.id, query: 'archive', since: '2999-01-01T00:00:00.000Z' })
assert.equal(future.total, 0)

// Deleting a note invalidates the cache on the next search.
const doomed = journals.write({ id: agent.id, title: 'temporary', text: 'obsolete archive wording' })
assert.ok(recall.search({ id: agent.id, query: 'obsolete' }).total > 0)
journals.remove({ id: agent.id, entry: doomed.id })
assert.equal(recall.search({ id: agent.id, query: 'obsolete' }).total, 0, 'removal is visible immediately')

// ── index state ─────────────────────────────────────────────────────────────
const built = recall.reindex()
assert.ok(built.total >= 3)
assert.ok(fs.existsSync(path.join(store.root, 'index', 'state.json')))
assert.equal(built.sources[`journal:${agent.id}`], 1)
const state = recall.state()
assert.equal(state.builtAt, built.builtAt)
assert.ok(state.cached.length > 0)

console.log('ALL RECALL TESTS PASSED')
