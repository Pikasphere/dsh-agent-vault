/** Rank, recall, checkpoint isolation and the index cursor. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = name => import(`file://${path.join(here, name).replace(/\\/g, '/')}`)
const { tokenize, scoreEntry, decay, rank, snippet } = await load('rank.js')
const { createStore } = await load('store.js')
const { createJournals } = await load('journal.js')
const { createRecall } = await load('recall.js')
const { extractEntities } = await load('graph.js')

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

const hits = await recall.search({ id: agent.id, query: 'archive' })
assert.ok(hits.total >= 3, `query hits every source (got ${hits.total})`)
assert.deepEqual(hits.results.map(item => item.src).sort(), ['journal', 'knowledge', 'log'])
assert.equal(hits.results[0].via, 'lexical')
assert.ok(hits.results.every(item => item.score > 0))

const journalOnly = await recall.search({ id: agent.id, query: 'right-click', source: 'journal' })
assert.deepEqual(journalOnly.results.map(item => item.src), ['journal'])
assert.equal(journalOnly.results[0].preview.includes('right-click'), true)

const checkpointHit = await recall.search({ id: agent.id, query: 'authoritative state' })
assert.equal(checkpointHit.results.some(item => item.title === 'checkpoint'), false, 'a checkpoint is never recalled')

const knowledgeOnly = await recall.search({ id: agent.id, query: 'right-click', source: 'knowledge' })
assert.deepEqual(knowledgeOnly.results.map(item => item.src), ['knowledge'])
assert.equal(knowledgeOnly.results[0].id.startsWith('side'), true)

const limited = await recall.search({ id: agent.id, query: 'archive', limit: 1 })
assert.equal(limited.results.length, 1)
assert.ok(limited.total > 1, 'total reports every match, not the page')

const since = await recall.search({ id: agent.id, query: 'archive', since: '2000-01-01T00:00:00.000Z' })
assert.ok(since.total > 0)
const future = await recall.search({ id: agent.id, query: 'archive', since: '2999-01-01T00:00:00.000Z' })
assert.equal(future.total, 0)

// Deleting a note invalidates the cache on the next search.
const doomed = journals.write({ id: agent.id, title: 'temporary', text: 'obsolete archive wording' })
assert.ok((await recall.search({ id: agent.id, query: 'obsolete' })).total > 0)
journals.remove({ id: agent.id, entry: doomed.id })
assert.equal((await recall.search({ id: agent.id, query: 'obsolete' })).total, 0, 'removal is visible immediately')

// ── open: the full record behind a hit (panel expand view) ──────────────────
const openedKnowledge = recall.open({ id: agent.id, src: 'knowledge', entry: knowledgeOnly.results[0].id })
assert.equal(openedKnowledge.src, 'knowledge')
assert.equal(openedKnowledge.text.includes('right-click'), true)
assert.equal(openedKnowledge.title, 'Sidebar context menu')
const openedLog = recall.open({ id: agent.id, src: 'log', entry: hits.results.find(item => item.src === 'log').id })
assert.ok(openedLog.text.length > 0)
assert.equal(recall.open({ id: agent.id, src: 'log', entry: 'm-999' }), null, 'unknown id returns null')
assert.equal(recall.open({ id: agent.id, src: 'nope', entry: 'x' }), null, 'unknown source returns null')

// ── index state ─────────────────────────────────────────────────────────────
const built = await recall.reindex()
assert.ok(built.total >= 3)
assert.ok(fs.existsSync(path.join(store.root, 'index', 'state.json')))
assert.equal(built.sources[`journal:${agent.id}`], 1)
const state = recall.state()
assert.equal(state.builtAt, built.builtAt)
assert.ok(state.cached.length > 0)
assert.equal(state.expand, 1, 'graph expansion is on by default')
assert.equal(fs.existsSync(path.join(store.root, 'index', 'aliases.json')), true, 'reindex creates the alias map')

// ── graph expansion (§6.5) ──────────────────────────────────────────────────
// Entity extraction is by shape, and generic shapes are dropped so the graph
// does not fuse into one blob.
assert.equal(extractEntities('json node windows true').size, 0, 'generic words are not entities')
const shapes = extractEntities('see E:\\Projects\\dsh-agent-vault\\index.js and j-ab12, agent-6sbx')
assert.equal(shapes.has('e:/projects/dsh-agent-vault/index.js'), true, 'windows path is an entity')
assert.equal(shapes.has('j-ab12'), true, 'journal id is an entity')
assert.equal(shapes.has('agent-6sbx'), true, 'agent id is an entity')

// Entity bridge: the query only speaks A's language; B shares the repo name.
const bridgeA = journals.write({ id: agent.id, title: 'widget memory', text: 'the widget writes dsh-agent-vault notes' })
const bridgeB = journals.write({ id: agent.id, title: 'clone day', text: 'cloned dsh-agent-vault again' })
const lexicalOnly = await recall.search({ id: agent.id, query: 'widget', expand: 0 })
assert.equal(lexicalOnly.expand, 0)
assert.ok(lexicalOnly.results.every(item => item.via === 'lexical'))
assert.equal(lexicalOnly.results.some(item => item.id === bridgeB.id), false, 'expand:0 stays lexical')
const bridged = await recall.search({ id: agent.id, query: 'widget' })
assert.equal(bridged.expand, 1)
const bridgeRow = bridged.results.find(item => item.id === bridgeB.id)
assert.ok(bridgeRow, 'the shared repo name pulls the other note in')
assert.equal(bridgeRow.via, 'entity')
assert.equal(bridgeRow.why.hub, 'dsh-agent-vault')
assert.ok(bridgeRow.score < bridged.results.find(item => item.id === bridgeA.id).score, 'a neighbour ranks under its seed')

// Reference bridge: a knowledge entry cites a journal id.
const cited = journals.write({ id: agent.id, title: 'cited target', text: 'the plugin manager path is the junction' })
store.saveKnowledge({ id: agent.id, title: 'Install citation', content: `follow ${cited.id} before changing the path` })
const refHit = await recall.search({ id: agent.id, query: 'citation' })
const refRow = refHit.results.find(item => item.id === cited.id)
assert.ok(refRow, 'a cited note is pulled in')
assert.equal(refRow.via, 'ref')
assert.equal(refRow.why.hub, cited.id)

// Alias: hand-written equivalence, the whole query is Chinese and matches nothing lexically.
fs.writeFileSync(
  path.join(store.root, 'index', 'aliases.json'),
  JSON.stringify({ 小鲸鱼: ['dsh-whale-widget'] }),
  'utf8',
)
const whale = journals.write({ id: agent.id, title: 'whale widget pet', text: 'dsh-whale-widget release 0.6.8 ships the pet' })
journals.write({ id: agent.id, kind: 'checkpoint', title: 'checkpoint', text: 'dsh-whale-widget is authoritative state' })
const aliasHit = await recall.search({ id: agent.id, query: '小鲸鱼' })
assert.equal(aliasHit.results[0]?.id, whale.id, 'the alias turns the target into a hit')
assert.equal(aliasHit.results[0].via, 'alias')
assert.equal(aliasHit.results[0].why.hub, '小鲸鱼')
assert.equal(
  aliasHit.results.some(item => item.title === 'checkpoint'),
  false,
  'a checkpoint never joins the graph',
)

// The alias table is writable through recall's own ops (panel + agent_alias).
const tableBefore = recall.aliases()
assert.equal(tableBefore.table['小鲸鱼'][0], 'dsh-whale-widget')
const aliasSet = recall.aliasSet({ key: '小鲸鱼', targets: ['dsh-whale-widget', 'pet'] })
assert.deepEqual(aliasSet.targets, ['dsh-whale-widget', 'pet'])
assert.deepEqual(recall.aliases().table['小鲸鱼'], ['dsh-whale-widget', 'pet'])
const aliasAgain = await recall.search({ id: agent.id, query: '小鲸鱼' })
assert.equal(aliasAgain.results[0]?.id, whale.id, 'the written alias is live without a reindex')
assert.equal(recall.aliasRemove({ key: '小鲸鱼' }).removed, true)
assert.equal(recall.aliases().table['小鲸鱼'], undefined)
assert.equal(recall.aliasRemove({ key: '小鲸鱼' }).removed, false)
assert.equal(recall.aliasSet({ key: '小鲸鱼', targets: [] }).targets.length, 0, 'an empty target list deletes')

// A memory save records the conversation it came from, so a log hit can jump back.
store.writeMemory({ id: agent.id, content: 'the log entry remembers its session', sessionId: 'session-abcdef01' })
const logged = await recall.search({ id: agent.id, query: 'remembers its session', source: 'log' })
assert.equal(logged.results[0]?.src, 'log')
assert.equal(logged.results[0]?.sessionId, 'session-abcdef01', 'log rows carry the session id')
assert.equal(recall.open({ id: agent.id, src: 'log', entry: logged.results[0].id })?.sessionId, 'session-abcdef01')

// Expansion is capped and every extra carries a reason.
for (const row of (await recall.search({ id: agent.id, query: 'dsh-agent-vault', limit: 25 })).results) {
  if (row.via === 'lexical') continue
  assert.ok(Number.isFinite(row.why?.weight) && row.why.weight >= 0.35, 'edge weight is reported and above the floor')
}

// A long body previews the window around the match, not its first 160 chars.
{
  const body = `${'无关内容 '.repeat(40)}这里提到 zstd 帧与压缩${' 后续无关内容'.repeat(40)}`
  const cut = snippet(body, ['zstd'])
  assert.ok(cut.includes('zstd'), 'snippet keeps the match')
  assert.ok(cut.startsWith('…') && cut.endsWith('…'), 'both sides elided')
  assert.ok(cut.length <= 165, `snippet size ${cut.length}`)
  assert.equal(snippet('短文本', ['x']), '短文本')
  const hits = snippet(body, ['zstd', '压缩'])
  assert.ok(hits.includes('压缩'), 'densest window keeps both tokens')
  assert.ok(snippet(body, []).length <= 162, 'no tokens falls back to the head')
}

// ── message-level hits ──────────────────────────────────────────────────────
{
  const messages = [
    { seq: 1, role: 'user', at: '2026-10-20T10:00:00.000Z', text: '先跑一下测试' },
    { seq: 2, role: 'assistant', at: '2026-10-20T10:01:00.000Z', text: 'zstd 帧的尾巴被截断了，我补一个解析器' },
    { seq: 3, role: 'user', at: '2026-10-20T10:02:00.000Z', text: '好' },
  ]
  const stub = {
    entries: () => [{ id: 'session-x', sessionId: 'session-x', at: '2026-10-20T10:01:00.000Z', title: '会话 X', text: messages.map(item => item.text).join(' ') }],
    messagesOf: sessionId => (sessionId === 'session-x' ? messages : []),
    list: () => [],
    root: '',
  }
  const scoped = createRecall({ rootDir: store.root, store, journals, transcripts: stub })
  const found = await scoped.search({ id: 'demo-agent', query: 'zstd 解析器', source: 'session' })
  assert.equal(found.results.length, 1)
  assert.equal(found.results[0].hit?.seq, 2, 'hit points at the matching message')
  assert.equal(found.results[0].hit?.role, 'assistant')
  assert.ok(found.results[0].hit.text.includes('zstd'))
  const missed = await scoped.search({ id: 'demo-agent', query: '完全不存在的词', source: 'session' })
  assert.equal(missed.results.length, 0)
  assert.deepEqual(scoped.messages('session-x').map(item => item.seq), [1, 2, 3])
}

console.log('ALL RECALL TESTS PASSED')
