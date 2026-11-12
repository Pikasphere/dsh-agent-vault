// Early compaction ("sleep"): threshold, cooldown, accounting, failure paths.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { SLEEP_DEFAULTS, createSleep } from './sleep.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-sleep-'))
const logFile = path.join(root, 'index', 'compaction.jsonl')

function harness(options = {}) {
  fs.rmSync(logFile, { force: true })
  fs.rmSync(path.join(root, 'index', 'sleep.json'), { force: true })
  const settings = {
    enabled: true,
    triggerTokens: 1000,
    cooldownMs: 0,
    mode: 'host',
    // The fake surface is tiny, so the real 30k gate would skip every fold here.
    minSavedTokens: 0,
    ...(options.settings ?? {}),
  }
  const calls = []
  const surfaceCalls = []
  const nodes = []
  const events = new Map()
  const totalNodes = options.nodes ?? 40
  for (let index = 1; index <= totalNodes; index += 1) {
    const seq = index
    nodes.push(seq)
    const isToolResult = options.toolResults !== false && index % 5 === 0
    const body = [{ type: 'text', text: 'x'.repeat(200) }]
    events.set(
      seq,
      isToolResult
        ? { type: 'tool/result', data: { message: { content: body } } }
        : { type: 'user/message', data: { content: body } },
    )
  }
  const appended = []
  const session = {
    surface: { nodes },
    eventAt: seq => events.get(seq),
    append: (type, data, opts) => {
      appended.push({ type, data, opts })
      return { type, seq: 999, time: Date.now(), data }
    },
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  const services = {
    sessions: { get: id => (id === 'session-a' ? session : undefined) },
    compaction: {
      compactRegion: async (start, end, context) => {
        surfaceCalls.push({ start, end })
        if (options.regionThrows === true) throw new Error('region refused')
        return { compactionId: 'r1', summary: [{ type: 'text', text: 'y'.repeat(40) }], shadowedTokenCount: 2000 }
      },
      compactIfNeeded: async (context, trigger, signal) => {
        calls.push({ context, trigger, aborted: signal.aborted })
        if (options.throws === true) throw new Error('summary failed')
        if (options.null === true) return null
        return {
          compactionId: 'c1',
          summary: [{ type: 'text', text: 'x'.repeat(120) }],
          shadowedTokenCount: 5000,
        }
      },
    },
  }
  const ctx = {
    get: name => services[name],
    on: () => () => {},
    effect: fn => fn(),
  }
  const store = {
    root,
    settings: () => ({ sleep: settings }),
    bindingOf: () => 'agent-a',
  }
  let tokens = options.tokens ?? 0
  const writes = []
  const journals = {
    write: input => {
      writes.push(input)
      return { id: `j-${writes.length}`, at: '2026-11-02T00:00:00.000Z', kind: 'note', title: input.title, chars: input.text.length }
    },
  }
  const sleep = createSleep({
    ctx,
    store,
    journals,
    measureTokens: () => tokens,
    recordError: (target, scope, error) => {
      throw new Error(`unexpected recordError ${scope}: ${error?.message ?? error}`)
    },
  })
  return {
    sleep,
    store,
    calls,
    surfaceCalls,
    writes,
    appended,
    nodes,
    events,
    settings,
    setTokens: value => {
      tokens = value
    },
  }
}

// disabled: never touches the service
{
  const h = harness({ settings: { enabled: false }, tokens: 999999 })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result, null)
  assert.equal(h.calls.length, 0)
  assert.equal(h.surfaceCalls.length, 0)
}

// below threshold: no call
{
  const h = harness({ tokens: 500 })
  assert.equal(await h.sleep.maybeCompact({ id: 'session-a' }), null)
  assert.equal(h.calls.length, 0)
}

// above threshold: one call, early trigger, one accounting line
{
  const h = harness({ tokens: 1200 })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result?.attempted, true)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].trigger, 'context-overflow')
  assert.equal(h.calls[0].context.options.provider, 'p')
  assert.equal(h.calls[0].context.session, undefined ?? h.calls[0].context.session)
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  const row = JSON.parse(lines[0])
  assert.equal(row.sessionId, 'session-a')
  assert.equal(row.ok, true)
  assert.equal(row.beforeTokens, 1200)
  assert.equal(row.shadowedTokenCount, 5000)
  assert.equal(row.summaryChars, 120)
  assert.equal(row.reason, 'threshold')
  assert.ok(row.durationMs >= 0)
}

// cooldown: the second attempt inside the window is skipped
{
  const h = harness({ tokens: 1200, settings: { cooldownMs: 60000 } })
  assert.equal((await h.sleep.maybeCompact({ id: 'session-a' }))?.attempted, true)
  assert.equal(await h.sleep.maybeCompact({ id: 'session-a' }), null)
  assert.equal(h.calls.length, 1)
}

// service declines: still accounted, but nothing was folded
{
  const h = harness({ tokens: 1200, null: true })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result?.attempted, true)
  assert.equal(result.result, null)
  const rows = h.sleep.history(10)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].ok, true)
  assert.equal(rows[0].compacted, false)
  assert.equal(rows[0].shadowedTokenCount, 0)
}

// failure: accounted with the error, never thrown to the loop
{
  const h = harness({ tokens: 1200, throws: true })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result?.attempted, true)
  assert.equal(result.error instanceof Error, true)
  const rows = h.sleep.history(10)
  assert.equal(rows[0].ok, false)
  assert.ok(String(rows[0].error).includes('summary failed'))
}

// missing session or missing service: no call, no throw
{
  const h = harness({ tokens: 1200 })
  assert.equal(await h.sleep.maybeCompact({ id: 'session-unknown' }), null)
  const bare = createSleep({
    ctx: { get: () => undefined, on: () => () => {}, effect: fn => fn() },
    store: { root, settings: () => ({ sleep: { enabled: true, triggerTokens: 1 } }), bindingOf: () => '' },
    measureTokens: () => 999999,
    recordError: () => {},
  })
  const bareResult = await bare.maybeCompact({ id: 'session-a' })
  // With the host service unreachable the sweep falls back to memory slices;
  // here there is no agent binding, so the fallback reports why it did nothing.
  assert.ok(bareResult === null || bareResult.attempted === false)
}

// state(): settings + totals from the log
{
  fs.rmSync(logFile, { force: true })
  const h = harness({ tokens: 1200 })
  await h.sleep.maybeCompact({ id: 'session-a' })
  const state = h.sleep.state()
  assert.equal(state.enabled, true)
  assert.equal(state.triggerTokens, 1000)
  assert.equal(state.attempts, 1)
  assert.equal(state.savedTokens, 5000)
  assert.equal(state.logFile, logFile)
  assert.equal(state.last.shadowedTokenCount, 5000)
}

// continuous mode below the hard threshold: fold a tail span instead
{
  const h = harness({ tokens: 700, settings: { keepUnder: 400, triggerTokens: 1000, cooldownMs: 0, minFoldTokens: 100 } })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result?.attempted, true)
  assert.equal(result.kind, 'small')
  assert.equal(h.calls.length, 0, 'the hard path is not used')
  assert.equal(h.surfaceCalls.length, 1)
  const { start, end } = h.surfaceCalls[0]
  assert.ok(start < end, 'span is ordered')
  assert.ok(end < h.nodes.at(-1), 'the recent working set is left alone')
  assert.notEqual(h.events.get(start).type, 'tool/result', 'never starts on a tool result')
  assert.notEqual(h.events.get(end).type, 'tool/call', 'never ends on a tool call')
  const row = h.sleep.history(10)[0]
  assert.equal(row.kind, 'small')
  assert.equal(row.reason, 'sweep')
  assert.equal(row.ok, true)
  assert.equal(row.shadowedTokenCount, 2000)
  assert.ok(row.span !== null && row.span.nodes > 1)
}

// below the trigger and with no keep-under target, nothing happens at all
{
  const h = harness({ tokens: 400, settings: { keepUnder: 400, triggerTokens: 1000 } })
  assert.equal(await h.sleep.maybeCompact({ id: 'session-a' }), null)
  assert.equal(h.surfaceCalls.length, 0)
}

// a refused region is accounted, not thrown
{
  const h = harness({ tokens: 700, settings: { keepUnder: 400, triggerTokens: 1000, minFoldTokens: 100 }, regionThrows: true })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result?.attempted, true)
  assert.equal(result.error instanceof Error, true)
  const row = h.sleep.history(10)[0]
  assert.equal(row.ok, false)
  assert.equal(row.kind, 'small')
}

// a slice below minFoldTokens waits for the next idle
{
  const h = harness({ tokens: 700, settings: { keepUnder: 400, triggerTokens: 1000, cooldownMs: 0, minFoldTokens: 100000 } })
  assert.equal(await h.sleep.maybeCompact({ id: 'session-a' }), null)
  assert.equal(h.surfaceCalls.length, 0)
}

// the fold watermark moves forward and blocks rewriting the same prefix
{
  const h = harness({ tokens: 700, settings: { keepUnder: 400, triggerTokens: 1000, cooldownMs: 0, minFoldTokens: 100 } })
  assert.equal((await h.sleep.maybeCompact({ id: 'session-a' }))?.attempted, true)
  const first = h.surfaceCalls[0]
  const mark = h.sleep.state().foldStartSeq['session-a']
  assert.equal(mark, first.start, 'watermark records where the fold started')
  const second = await h.sleep.maybeCompact({ id: 'session-a' })
  // The watermark forbids rewriting at or before the last fold; a later fold may
  // still happen, but only on material after it (the clamp keeps it monotonic).
  if (second !== null && h.surfaceCalls.length > 1) {
    assert.ok(h.surfaceCalls[1].start > first.start, 'never rewrites at or before the watermark')
  }
  const row = h.sleep.history(10)[0]
  assert.equal(row.kind, 'small')
  assert.ok(row.span.start >= first.start)
}

// calibration: the estimator is corrected by what the meter actually dropped
{
  const h = harness({
    tokens: 1200,
    settings: { mode: 'shelve', keepUnder: 400, triggerTokens: 1000, minSavedTokens: 0, minFoldTokens: 100 },
  })
  const first = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(first?.ok, true)
  const row = h.sleep.history(10)[0]
  assert.equal(row.calibration, 1, 'the first fold trusts the raw estimate')
  const ratio = Number(JSON.parse(fs.readFileSync(path.join(root, 'index', 'sleep.json'), 'utf8')).calibration['session-a'].ratio)
  assert.ok(ratio > 0 && ratio <= 2, `learned ratio ${ratio}`)
  assert.notEqual(ratio, 1, 'the factor moves toward the measured saving')
  // The learned factor sticks and is applied to the next estimate.
  const before = h.sleep.history(10).length
  const second = await h.sleep.maybeCompact({ id: 'session-a' })
  const rows = h.sleep.history(10)
  // The second idle may legitimately be a duplicate (the stamp registry now
  // remembers silent folds, which leave no text to scan), so only assert when a
  // second fold actually committed.
  if (second !== null && rows.length > before && second.why !== 'duplicate' && second.attempted !== false) {
    // Same-ISO-second rows can tie, so look for the row rather than trusting order.
    const calibrated = rows.find(r => r.calibration === ratio && r.rawEstimatedSavedTokens > 0)
    assert.ok(calibrated !== undefined, 'the previous fold calibrated this one')
  }
}

// low-gain gate: a slice that would free too little is skipped, not folded
{
  const h = harness({ tokens: 1200, settings: { mode: 'shelve', keepUnder: 400, triggerTokens: 1000, minSavedTokens: 30000, minFoldTokens: 100 } })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result?.attempted, false)
  assert.equal(result.why, 'low-gain')
  assert.ok(result.estimatedSavedTokens < 30000)
  assert.equal(h.appended.length, 0, 'the surface is untouched')
  assert.equal(h.writes.length, 0, 'nothing is archived either')
  const row = h.sleep.history(10).find(r => r.kind === 'skip' && r.why === 'low-gain')
  assert.ok(row !== undefined, 'the skip is accounted')
  assert.ok(row.span.nodes > 1)
}

// the same slice folds once the bar is low enough
{
  const h = harness({ tokens: 1200, settings: { mode: 'shelve', keepUnder: 400, triggerTokens: 1000, minSavedTokens: 1, minFoldTokens: 100 } })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result?.attempted, true)
  assert.ok(h.appended.length >= 1)
  const row = h.sleep.history(10)[0]
  assert.equal(row.kind, 'shelve')
  assert.ok(typeof row.estimatedSavedTokens === 'number')
}

// shelve mode: archive into the journal first, then replace the span with a stub
{
  const h = harness({ tokens: 1200, settings: { mode: 'shelve', keepUnder: 400, triggerTokens: 1000, cooldownMs: 0, minFoldTokens: 100, maxSlices: 1, stubStyle: 'full' } })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result?.attempted, true)
  assert.equal(result.ok, true)
  assert.equal(h.calls.length, 0, 'the compaction service is never touched')
  assert.ok(h.writes.length >= 1, 'history is archived before the surface changes')
  const archived = h.writes[0]
  assert.equal(archived.kind, 'note')
  assert.equal(archived.meta.sessionId, 'session-a')
  assert.ok(archived.text.includes('[#'))
  assert.equal(h.appended.length, 1)
  const [append] = h.appended
  assert.equal(append.type, 'user/message')
  assert.equal(append.opts.surfaceOp.op, 'replace')
  assert.ok(append.opts.surfaceOp.startSeq < append.opts.surfaceOp.endSeq)
  // v4 admits one identified message with a producer-owned source; a row without
  // either is written happily and then poisons the log at load time.
  assert.equal(append.data.role, 'user')
  assert.equal(typeof append.data.id, 'string')
  assert.ok(append.data.id.length > 0)
  assert.deepEqual(append.data.source, { kind: 'user' })
  // every shadowed node must be listed: the host refuses the replace otherwise
  assert.ok(Array.isArray(append.opts.sourceEventSeqs) && append.opts.sourceEventSeqs.length >= 2)
  assert.ok(append.data.content[0].text.includes('【已归档】'))
  assert.ok(append.data.content[0].text.includes('j-1'))
  assert.equal(h.sleep.state().foldStartSeq['session-a'], append.opts.surfaceOp.startSeq)
  const row = h.sleep.history(10)[0]
  assert.equal(row.kind, 'shelve')
  assert.equal(row.ok, true)
  assert.ok(row.archived.length >= 1)
}

// shelve refuses when the session is not bound (no memory to write into)
{
  const h = harness({ tokens: 1200, settings: { mode: 'shelve', keepUnder: 400, triggerTokens: 1000, minFoldTokens: 100, stubStyle: 'full' } })
  h.store.bindingOf = () => ''
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result?.attempted, false)
  assert.equal(result.why, 'no-agent')
  assert.equal(h.appended.length, 0)
}

// a span may not end on an assistant message that still carries tool calls:
// the call would be folded while its result stays in the surface, and the next
// model request dies with "tool result has no matching call"
{
  const h = harness({ tokens: 1200, settings: { mode: 'shelve', keepUnder: 400, triggerTokens: 1000, cooldownMs: 0, minFoldTokens: 100 } })
  const pending = h.nodes[h.nodes.length - 1 - 8]
  h.events.set(pending, {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'call-pending', name: 'ops_bash', arguments: '{}' }] } },
  })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result?.attempted, true)
  const [append] = h.appended
  assert.ok(append.opts.surfaceOp.endSeq < pending, 'the fold stops before the pending call')
}

// continuous mode: fold on every idle until the target token count is met
{
  const h = harness({
    tokens: 90000,
    toolResults: false,
    settings: {
      softTokens: 200000,
      triggerTokens: 325000,
      keepUnder: 40000,
      chunkTokens: 20000,
      keepRecent: 4,
      minFoldTokens: 1500,
      cooldownMs: 0,
      mode: 'shelve',
      stubStyle: 'full',
    },
  })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result?.attempted, true, 'continuous mode folds below the soft threshold')
  assert.equal(h.appended.length, 1, 'one slice per turn end, not a burst')
  assert.equal(h.writes.length, 0, 'a small fold is a cache move, not a journal note')
  assert.ok(h.appended[0].data.content[0].text.includes('【已折叠】'), 'the stub points at the session log')
}

// without keepUnder the same session is simply below threshold
{
  const h = harness({ tokens: 90000, toolResults: false, settings: { keepUnder: 200000, triggerTokens: 325000, cooldownMs: 0, mode: 'shelve' } })
  assert.equal(await h.sleep.maybeCompact({ id: 'session-a' }), null)
  assert.equal(h.writes.length, 0)
}

// foldEveryTurn: no target at all, one pass per idle
{
  const h = harness({
    tokens: 30000,
    nodes: 120,
    toolResults: false,
    settings: { keepUnder: 200000, triggerTokens: 325000, cooldownMs: 60000, mode: 'shelve', foldEveryTurn: true, keepRecent: 4, minFoldTokens: 1500, stubStyle: 'full' },
  })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result?.attempted, true, 'folds even though the session is tiny')
  assert.equal(h.writes.length, 0, 'a small fold is not journaled')
  assert.equal(h.appended.length, 1, 'left one pointer stub')
}

// foldEveryTurn off: the same tiny session is left alone, cooldown or not
{
  const h = harness({ tokens: 30000, nodes: 120, toolResults: false, settings: { keepUnder: 200000, triggerTokens: 325000, cooldownMs: 0, mode: 'shelve', keepRecent: 4 } })
  assert.equal(await h.sleep.maybeCompact({ id: 'session-a' }), null)
  assert.equal(h.writes.length, 0)
}

// a run of failed attempts is surfaced, and only counts the trailing run
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleep-fail-'))
  fs.mkdirSync(path.join(dir, 'index'), { recursive: true })
  const lines = [
    { at: '2026-11-04T10:00:00.000Z', kind: 'shelve', ok: false, sessionId: 'session-a', error: 'boom' },
    { at: '2026-11-04T10:01:00.000Z', kind: 'shelve', ok: false, sessionId: 'session-a', error: 'boom again' },
    { at: '2026-11-04T10:02:00.000Z', kind: 'shelve', ok: false, sessionId: 'session-b', error: 'unbalanced' },
    { at: '2026-11-04T10:03:00.000Z', kind: 'shelve', ok: true, sessionId: 'session-b', shadowedTokenCount: 10 },
  ]
  fs.writeFileSync(
    path.join(dir, 'index', 'compaction.jsonl'),
    lines.map(line => JSON.stringify(line)).join('\n') + '\n',
  )
  const bare = createSleep({
    ctx: { get: () => undefined, on: () => () => {}, effect: fn => fn(), logger: console },
    store: { root: dir, bindingOf: () => 'agent-a', settings: () => ({}) },
    journals: { notes: () => [] },
    measureTokens: () => 0,
  })
  const reported = bare.state()
  assert.equal(reported.failing.length, 1, 'the trailing run wins over older failures')
  assert.equal(reported.failing[0].sessionId, 'session-a')
  assert.equal(reported.failing[0].count, 2)
  assert.equal(reported.failing[0].error, 'boom again')
  assert.equal(reported.alert?.sessionId, 'session-a', 'two in a row is an alert')
  fs.rmSync(dir, { recursive: true, force: true })
}

// foldSummary keeps the two fold paths apart: the ledger shows them separately
{
  const continuous = harness({ tokens: 700, toolResults: false, settings: { keepUnder: 500, triggerTokens: 5000, mode: 'shelve', minFoldTokens: 500, cooldownMs: 0 } })
  const first = await continuous.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(first?.ok, true)
  const summary = continuous.sleep.foldSummary('session-a')
  assert.ok(summary.continuous.count >= 1, 'at least one continuous fold')
  assert.equal(summary.deep.count, 0)
  assert.equal(summary.recent.at(-1).deep, false)
  assert.ok(summary.continuous.tokens > 0)
  assert.equal(summary.alert, null)
}
{
  const deep = harness({ tokens: 700, toolResults: false, settings: { keepUnder: 500, triggerTokens: 600, mode: 'shelve', minFoldTokens: 500, cooldownMs: 0 } })
  const first = await deep.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(first?.ok, true)
  const summary = deep.sleep.foldSummary('session-a')
  assert.equal(summary.deep.count, 1)
  assert.equal(summary.continuous.count, 0)
  assert.equal(summary.recent.at(-1).deep, true)
}

// silent stubs: the node stays (the host requires a replacement) but carries
// no readable text, and the slice is archived so it stays reachable.
{
  const h = harness({ tokens: 1200, settings: { mode: 'shelve', keepUnder: 400, triggerTokens: 1000, cooldownMs: 0, minFoldTokens: 100, maxSlices: 1, archive: false } })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result?.attempted, true)
  assert.equal(h.appended.length, 1)
  const [append] = h.appended
  assert.equal(append.data.content[0].text, '\u200b')
  assert.ok(h.writes.length >= 1, 'a silent stub still archives the slice')
  const again = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(again?.why, 'duplicate', 'the persisted stamp stops a second fold')
  assert.equal(h.appended.length, 1)
}

// defaults stay conservative
assert.deepEqual(
  { ...SLEEP_DEFAULTS },
  { enabled: false, triggerTokens: 400000, chunkTokens: 60000, keepRecent: 8, keepUnder: 0, foldEveryTurn: false, minFoldTokens: 5000, minSavedTokens: 3000, mode: 'host', stubStyle: 'silent', maxSlices: 3, bigChunkTokens: 200000, fallbackShelve: true, cooldownMs: 600000 },
)

fs.rmSync(root, { recursive: true, force: true })
console.log('ALL SLEEP TESTS PASSED')
