// Transcripts source: frame walking, redaction, volume cap, known-session selection.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { MAX_CHARS, SESSION_FILE, createTranscripts, redact, readRecords } from './transcripts.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-transcripts-'))
const root = path.join(scratch, 'memory')
const sessions = path.join(scratch, 'sessions')
const workspace = path.join(sessions, '--E-Projects--')
const sessionId = 'session-11111111-2222-3333-4444-555555555555'
const sessionDir = path.join(workspace, sessionId)

fs.mkdirSync(path.join(root, 'journal'), { recursive: true })
fs.mkdirSync(sessionDir, { recursive: true })

const records = [
  { type: 'session', version: 4, id: sessionId, createdAt: 1790000000000, cwd: 'E:\\Projects' },
  { type: 'turn/start', seq: 4, time: 1790000001000, data: { turn: 1 } },
  { type: 'user/message', seq: 5, time: 1790000002000, data: { content: [{ type: 'text', text: '为什么包名要改' }] } },
  {
    type: 'assistant/message',
    seq: 6,
    time: 1790000003000,
    data: {
      message: {
        content: [
          { type: 'reasoning', text: '思考过程不该进索引' },
          { type: 'text', text: '因为 dsh-agent-vault 已在 npm 上被占用。' },
          { type: 'tool-call', id: 'call_1', name: 'ops_bash', arguments: '{}' },
        ],
      },
    },
  },
  { type: 'tool/call', seq: 7, time: 1790000004000, data: { turn: 1, step: 1, callId: 'call_1', name: 'ops_bash', arguments: '{}' } },
  {
    type: 'tool/result',
    seq: 8,
    time: 1790000005000,
    data: { message: { content: [{ type: 'text', text: '工具输出不该进索引' }] } },
  },
  { type: 'user/message', seq: 9, time: 1790000006000, data: { content: [{ type: 'text', text: '导出 token sk-abcdefghijklmnopqrstuvwx 到文件' }] } },
  { type: 'session/title', seq: 10, time: 1790000007000, data: { title: '包名与发布' } },
]

const file = path.join(sessionDir, SESSION_FILE)
const frames = records.map(record => zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')))
fs.writeFileSync(file, Buffer.concat(frames))

// Known sessions come from journal checkpoints and live bindings.
fs.mkdirSync(path.join(root, 'checkpoints'), { recursive: true })
fs.writeFileSync(
  path.join(root, 'checkpoints', 'demo-agent.jsonl'),
  `${JSON.stringify({ id: 'j-aaaa1111', kind: 'checkpoint', at: '2026-10-28T10:00:00.000Z', title: 'cp', text: 'x', meta: { sessionId } })}\n`,
)
fs.writeFileSync(path.join(root, 'journal', 'demo-agent.jsonl'), '')

const bindings = []
const transcripts = createTranscripts({
  rootDir: root,
  sessionsRoot: sessions,
  store: { listBindings: () => bindings },
})

// Read all frames, including the ones the stock one-shot decompressor skips.
const parsed = readRecords(file)
assert.equal(parsed.length, records.length, 'every frame is read')

const entries = transcripts.entries('demo-agent')
assert.equal(entries.length, 1, 'the checkpoint session is indexed for its owner')
assert.equal(transcripts.entries('someone-else').length, 0, 'other agents do not see it')
assert.equal(transcripts.entries().length, 1, 'no agent id means every agent (reindex)')
const entry = entries[0]
assert.equal(entry.sessionId, sessionId)
assert.equal(entry.title, '包名与发布')
assert.equal(entry.at, new Date(1790000006000).toISOString())

assert.match(entry.text, /为什么包名要改/, 'user text is indexed')
assert.match(entry.text, /npm 上被占用/, 'assistant text is indexed')
assert.doesNotMatch(entry.text, /工具输出不该进索引/, 'tool results stay out')
assert.doesNotMatch(entry.text, /思考过程/, 'reasoning stays out')
assert.doesNotMatch(entry.text, /sk-abcdefghijklmnopqrstuvwx/, 'secrets are redacted')
assert.match(entry.text, /\[redacted-key\]/)

// Unknown sessions are not indexed.
bindings.length = 0
fs.writeFileSync(path.join(root, 'checkpoints', 'demo-agent.jsonl'), '')
assert.equal(createTranscripts({ rootDir: root, sessionsRoot: sessions, store: { listBindings: () => bindings } }).entries('demo-agent').length, 0)

// Bindings alone are enough, and the cache notices a rewritten file.
bindings.push({ sessionId, agentId: 'demo-agent' })
const again = createTranscripts({ rootDir: root, sessionsRoot: sessions, store: { listBindings: () => bindings } })
assert.equal(again.entries('demo-agent').length, 1, 'bindings make a session known')
assert.equal(again.get(sessionId)?.title, '包名与发布')
const indexed = again.messagesOf(sessionId)
assert.ok(indexed.length >= 2, 'text-bearing messages are indexed')
assert.deepEqual([...new Set(indexed.map(message => message.role))].sort(), ['assistant', 'user'])
assert.ok(indexed.every(message => message.seq > 0 && message.text.trim() !== ''))
assert.deepEqual(again.messagesOf('session-unknown'), [])

const before = fs.statSync(file).mtimeMs
fs.appendFileSync(file, zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'user/message', seq: 11, time: 1790000008000, data: { content: [{ type: 'text', text: '追加的一条' }] } })}\n`)))
fs.utimesSync(file, new Date(), new Date(before + 5000))
assert.match(again.get(sessionId)?.text ?? '', /追加的一条/, 'cache invalidates on change')

// Truncated tail: a torn frame is skipped, earlier records survive.
const torn = Buffer.concat([Buffer.concat(frames.slice(0, 4)), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00])])
fs.writeFileSync(file, torn)
const survived = readRecords(file)
assert.equal(survived.length, 4, 'torn tail is dropped')

// Volume cap and the redaction helper.
assert.ok(redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456').includes('Bearer [redacted]'))
assert.ok(redact('AKIAIOSFODNN7EXAMPLE').includes('[redacted-key]'))
assert.ok(redact('plain text stays').includes('plain text stays'))

const big = []
for (let index = 0; index < 400; index += 1) {
  big.push({ type: 'user/message', seq: index, time: 1790000010000 + index, data: { content: [{ type: 'text', text: `第 ${index} 条：${'内容'.repeat(40)}` }] } })
}
fs.writeFileSync(file, Buffer.concat(big.map(record => zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`)))))
const t0 = Date.now()
const capped = createTranscripts({ rootDir: root, sessionsRoot: sessions, store: { listBindings: () => bindings } }).get(sessionId)
const elapsed = Date.now() - t0
assert.ok(capped.text.length <= MAX_CHARS, `capped: ${capped.text.length}`)
assert.ok(capped.text.includes('第 399 条'), 'the tail is kept')
assert.ok(capped.text.includes('第 0 条'), 'the head is kept')
assert.ok(elapsed < 1000, `single-session rebuild ${elapsed}ms`)

// Panel list + per-session exclusion: excluded sessions keep their membership
// (so they can be re-enabled) but stop feeding recall.
{
  fs.writeFileSync(file, Buffer.concat(frames))
  const excluded = createTranscripts({ rootDir: root, sessionsRoot: sessions, store: { listBindings: () => bindings }, exclude: () => [sessionId] })
  assert.equal(excluded.entries('demo-agent').length, 0, 'excluded session leaves recall')
  const listed = excluded.list('demo-agent')
  assert.equal(listed.length, 1, 'list still shows it')
  assert.equal(listed[0].included, false)
  assert.ok(listed[0].chars > 0 && listed[0].title === '包名与发布')
  const open = createTranscripts({ rootDir: root, sessionsRoot: sessions, store: { listBindings: () => bindings }, exclude: () => [] })
  assert.equal(open.list('demo-agent')[0].included, true)
  assert.equal(open.entries('demo-agent').length, 1)
}

fs.rmSync(scratch, { recursive: true, force: true })
console.log('ALL TRANSCRIPT TESTS PASSED')
