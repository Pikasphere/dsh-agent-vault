/** Private journals: one per agent, never readable from another agent. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { createJournals } = await import(`file://${path.join(here, 'journal.js').replace(/\\/g, '/')}`)
const { MemoryError } = await import(`file://${path.join(here, 'store.js').replace(/\\/g, '/')}`)

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-journal-'))
const journals = createJournals({ rootDir: path.join(scratch, 'mem') })

const alpha = journals.write({ id: 'alpha', title: '第一步', text: '把存储层拆开，先验证记忆。' })
assert.match(alpha.id, /^j-[a-z0-9]{4,16}$/)
assert.ok(alpha.chars > 0)

journals.write({ id: 'alpha', title: '第二步', text: '界面接上，发现标题解析要用投影缓存。' })
journals.write({ id: 'beta', title: '别人的日记', text: '这条属于 beta，alpha 不应该看到。' })

// isolation: each agent only ever sees its own file
const alphaList = journals.list({ id: 'alpha' })
assert.equal(alphaList.total, 2)
assert.equal(alphaList.entries.length, 2)
assert.ok(alphaList.entries.every(entry => entry.title !== '别人的日记'))

const betaList = journals.list({ id: 'beta' })
assert.equal(betaList.total, 1)
assert.equal(betaList.entries[0].title, '别人的日记')

// newest first
assert.equal(alphaList.entries[0].title, '第二步')

// search is scoped to the same agent
const hit = journals.list({ id: 'alpha', query: '界面' })
assert.equal(hit.matching, 1)
assert.equal(hit.entries[0].title, '第二步')
assert.equal(journals.list({ id: 'alpha', query: '别人的日记' }).matching, 0)

// read one entry
const full = journals.read({ id: 'alpha', entry: alpha.id })
assert.equal(full.title, '第一步')
assert.ok(full.text.includes('存储层'))

// a missing or foreign entry id is a typed failure
assert.throws(
  () => journals.read({ id: 'beta', entry: alpha.id }),
  error => error instanceof MemoryError && error.code === 'no-entry',
)

// counts
assert.equal(journals.count('alpha'), 2)
assert.equal(journals.count('nobody'), 0)

// delete only touches the caller's journal
journals.remove({ id: 'alpha', entry: alpha.id })
assert.equal(journals.count('alpha'), 1)
assert.equal(journals.count('beta'), 1)

// invalid agent ids never reach the filesystem
assert.throws(
  () => journals.write({ id: '../evil', text: 'x' }),
  error => error instanceof MemoryError && error.code === 'bad-vault',
)
assert.throws(
  () => journals.write({ id: 'alpha', text: '   ' }),
  error => error instanceof MemoryError && error.code === 'empty-entry',
)

// checkpoints live in their own file and are hidden unless asked for
const cp = journals.write({
  id: 'alpha',
  kind: 'checkpoint',
  title: '交棒检查点 · 12k tokens',
  text: '交接上下文：做完测试，下一步接面板。',
  meta: { tokens: 12000, threshold: 10000, sessionId: 'session-abc' },
})
assert.equal(cp.kind, 'checkpoint')
const notesOnly = journals.list({ id: 'alpha' })
assert.equal(notesOnly.entries.some(entry => entry.kind === 'checkpoint'), false)
const withCheckpoints = journals.list({ id: 'alpha', includeCheckpoints: true })
assert.equal(withCheckpoints.entries[0].id, cp.id)
assert.equal(withCheckpoints.entries[0].kind, 'checkpoint')
assert.equal(withCheckpoints.entries[0].meta.tokens, 12000)
assert.equal(withCheckpoints.entries[0].meta.sessionId, 'session-abc')
// the checkpoint went to its own file, the note file stays checkpoint-free
assert.ok(fs.existsSync(path.join(scratch, 'mem', 'checkpoints', 'alpha.jsonl')))
assert.ok(!fs.readFileSync(path.join(scratch, 'mem', 'journal', 'alpha.jsonl'), 'utf8').includes('"kind":"checkpoint"'))
// deleting a note never touches the checkpoint
journals.remove({ id: 'alpha', entry: notesOnly.entries[0].id })
assert.equal(journals.list({ id: 'alpha', includeCheckpoints: true }).entries.some(entry => entry.id === cp.id), true)

fs.rmSync(scratch, { recursive: true, force: true })
console.log('ALL JOURNAL TESTS PASSED')
