import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { createStore, MemoryError, MEMORY_LIMIT } = await import(`file://${path.join(here, 'store.js').replace(/\\/g, '/')}`)

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-test-'))
const memoryRoot = path.join(scratch, 'mem')
const knowledgeDir = path.join(scratch, 'kb')
const store = createStore({ rootDir: memoryRoot, knowledgeDir })

// registry
const agent = store.createAgent({ name: 'Refactor Assistant', description: 'keeps the tree clean' })
assert.match(agent.id, /^[a-z0-9][a-z0-9-]{0,63}$/)
assert.equal(agent.name, 'Refactor Assistant')
assert.equal(store.state().vaults.length, 1)
console.log('registry ok', agent.id)

// memory
const saved = store.writeMemory({ id: agent.id, content: 'Goal: split store. Done: memory layer. Next: UI.' })
assert.equal(saved.chars, 48)
assert.equal(store.state().vaults[0].memoryChars, 48)
assert.ok(store.state().vaults[0].memoryUpdatedAt !== '')
let tooLong = false
try {
  store.writeMemory({ id: agent.id, content: 'x'.repeat(MEMORY_LIMIT + 1) })
} catch (error) {
  tooLong = error instanceof MemoryError && error.code === 'memory-too-long'
}
assert.ok(tooLong, 'memory limit enforced')
assert.ok(fs.readFileSync(path.join(memoryRoot, 'memory', `${agent.id}.log.md`), 'utf8').includes('Next: UI'))
const withSession = store.writeMemory({ id: agent.id, content: 'session tagged save', sessionId: 'session-0123456789' })
const logNow = fs.readFileSync(path.join(memoryRoot, 'memory', `${agent.id}.log.md`), 'utf8')
assert.ok(logNow.includes('[session: session-0123456789]'), 'the audit log records the conversation')
assert.equal(withSession.chars, 'session tagged save'.length)
console.log('memory ok')

// knowledge create
const first = store.saveKnowledge({
  id: agent.id,
  title: 'Windows 沙箱 ACL 修复',
  content: 'icacls 需要先授予目录遍历权限，否则写入被拒绝。',
  tags: ['acl', 'windows'],
})
assert.equal(first.created, true)
assert.match(first.entry, /^[a-z0-9-]+$/)

const second = store.saveKnowledge({ id: agent.id, title: 'Bundle install', content: 'pnpm 链接目录，改完要重启宿主。' })
assert.equal(second.created, true)
assert.notEqual(second.entry, first.entry)
console.log('knowledge create ok', first.entry, second.entry)

// search / read
const hits = store.searchKnowledge({ id: agent.id, query: 'acl' })
assert.equal(hits.entries.length, 1)
assert.equal(hits.entries[0].id, first.entry)
assert.equal(store.searchKnowledge({ id: agent.id, query: 'nothing-here' }).entries.length, 0)
assert.equal(store.listKnowledge({ id: agent.id }).entries.length, 2)

const full = store.readKnowledge({ id: agent.id, entry: first.entry })
assert.equal(full.title, 'Windows 沙箱 ACL 修复')
assert.ok(full.content.includes('icacls'))
assert.deepEqual(full.tags, ['acl', 'windows'])
console.log('search/read ok')

// refine keeps created
const refined = store.saveKnowledge({
  id: agent.id,
  entry: first.entry,
  title: 'Windows 沙箱 ACL 修复',
  content: 'icacls 需要先授予目录遍历权限；随后用 dsh 的 diagnose 技能复核。',
  tags: ['acl', 'windows', 'sandbox'],
})
assert.equal(refined.created, false)
const after = store.readKnowledge({ id: agent.id, entry: first.entry })
assert.ok(after.content.includes('diagnose'))
assert.equal(after.created, full.created)
console.log('refine ok')

// settings: custom directory takes effect immediately, content is not moved
const other = path.join(scratch, 'kb2')
store.saveSettings({ knowledgeDir: other })
assert.equal(store.state().knowledgeDir, path.resolve(other))
assert.equal(store.listKnowledge({ id: agent.id }).entries.length, 0)
store.saveSettings({ knowledgeDir })
assert.equal(store.listKnowledge({ id: agent.id }).entries.length, 2)
// recall defaults survive an empty file, and a partial patch keeps the rest
assert.deepEqual(store.state().recall, { mode: 'hybrid', lexicalWeight: 0.6, semanticWeight: 0.4, minCosine: 0.45, rrfK: 20 })
store.saveSettings({ recall: { mode: 'lexical' } })
assert.deepEqual(store.state().recall, { mode: 'lexical', lexicalWeight: 0.6, semanticWeight: 0.4, minCosine: 0.45, rrfK: 20 })
store.saveSettings({ recall: { mode: 'sideways', minCosine: 9, lexicalWeight: -3 } })
assert.deepEqual(store.state().recall, { mode: 'lexical', lexicalWeight: 0, semanticWeight: 0.4, minCosine: 1, rrfK: 20 })
store.saveSettings({ recall: { rrfK: 0 } })
assert.equal(store.state().recall.rrfK, 1)
store.saveSettings({ recall: { rrfK: 9999 } })
assert.equal(store.state().recall.rrfK, 200)
store.saveSettings({ recall: { mode: 'hybrid' } })
console.log('settings ok')

// selection
store.saveSettings({ activeVault: agent.id })
assert.equal(store.state().activeVault, agent.id)
assert.equal(store.resolveVault({}).id, agent.id)
store.saveSettings({ activeVault: '' })
let noActive = false
try {
  store.resolveVault({})
} catch (error) {
  noActive = error instanceof MemoryError && error.code === 'no-active-vault'
}
assert.ok(noActive)
console.log('selection ok')

// validation
let traversal = false
try {
  store.readKnowledge({ id: agent.id, entry: '../../agents' })
} catch (error) {
  traversal = error instanceof MemoryError && error.code === 'bad-entry'
}
assert.ok(traversal, 'entry id traversal rejected')
let unknown = false
try {
  store.writeMemory({ id: 'nope', content: 'x' })
} catch (error) {
  unknown = error instanceof MemoryError && error.code === 'no-vault'
}
assert.ok(unknown)
console.log('validation ok')

// delete
store.deleteAgent({ id: agent.id, deleteKnowledge: true })
assert.equal(store.state().vaults.length, 0)
assert.equal(fs.existsSync(path.join(knowledgeDir, agent.id)), false)
assert.equal(fs.existsSync(path.join(memoryRoot, 'memory', `${agent.id}.md`)), false)
console.log('delete ok')

fs.rmSync(scratch, { recursive: true, force: true })
console.log('ALL STORE TESTS PASSED')
