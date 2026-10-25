/** Handoff: pressure thresholds, the requested→ready transition, checkpoint text. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { createHandoff, DEFAULT_TRIGGER_TOKENS, DEFAULT_STARTUP_PROMPT } = await import(
  `file://${path.join(here, 'handoff.js').replace(/\\/g, '/')}`
)

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-handoff-'))
let clock = Date.parse('2026-10-20T12:00:00.000Z')
const handoff = createHandoff({ rootDir: path.join(scratch, 'mem'), now: () => new Date(clock) })

const config = handoff.config()
assert.equal(config.enabled, true)
assert.equal(config.triggerTokens, DEFAULT_TRIGGER_TOKENS)
assert.equal(config.triggerTokens, 300000)
assert.equal(config.remindEverySteps, 2)
assert.equal(config.exportDir, '')
assert.equal(config.autoSwitch, false)
assert.equal(config.startupPrompt, DEFAULT_STARTUP_PROMPT)
assert.ok(config.startupPrompt.includes('agent_journal'))
handoff.saveConfig({ autoSwitch: true })
assert.equal(handoff.config().autoSwitch, true)
handoff.saveConfig({ autoSwitch: false })
assert.equal(handoff.config().autoSwitch, false)
// the startup instruction is editable, explicit clearing means "send nothing",
// and an overlong value is capped instead of bloating handoff.json
handoff.saveConfig({ startupPrompt: '  继续上次的工作。  ' })
assert.equal(handoff.config().startupPrompt, '继续上次的工作。')
handoff.saveConfig({ startupPrompt: '' })
assert.equal(handoff.config().startupPrompt, '')
handoff.saveConfig({ startupPrompt: 'x'.repeat(3000) })
assert.equal(handoff.config().startupPrompt.length, 2000)
handoff.saveConfig({ startupPrompt: DEFAULT_STARTUP_PROMPT })

// below the threshold: nothing happens
assert.equal(handoff.evaluate({ sessionId: 's1', tokens: 1000 }).stage, 'watching')

// crossing it records a request and asks for the reminder
const first = handoff.evaluate({ sessionId: 's1', tokens: 310000 })
assert.equal(first.stage, 'requested')
assert.equal(first.remind, true)
assert.ok(handoff.stateOf('s1').requestedAt)

// still pending while nothing new was written
// the next step stays silent: the reminder cadence is every 2 steps
const pending = handoff.evaluate({ sessionId: 's1', tokens: 320000, memoryAt: '', journalAt: '' })
assert.equal(pending.stage, 'requested')
assert.equal(pending.remind, false)

// only entries written after the request settle it
const before = handoff.evaluate({
  sessionId: 's1',
  tokens: 325000,
  memoryAt: '2026-10-20T11:00:00.000Z',
  journalAt: '2026-10-20T11:30:00.000Z',
})
assert.equal(before.stage, 'requested')
assert.equal(before.remind, true)

clock += 5000
const ready = handoff.evaluate({
  sessionId: 's1',
  tokens: 330000,
  memoryAt: new Date(clock - 3000).toISOString(),
  journalAt: new Date(clock - 1000).toISOString(),
})
assert.equal(ready.stage, 'ready')
assert.equal(ready.remind, false)

// a settled session stays settled even if pressure keeps climbing
handoff.patchState('s1', { settledAt: new Date(clock).toISOString() })
assert.equal(handoff.evaluate({ sessionId: 's1', tokens: 400000 }).stage, 'settled')

// other sessions are independent
assert.equal(handoff.evaluate({ sessionId: 's2', tokens: 1000 }).stage, 'watching')

// falling well back below the threshold clears the request (compaction happened)
handoff.evaluate({ sessionId: 's3', tokens: 310000 })
assert.ok(handoff.stateOf('s3'))
handoff.evaluate({ sessionId: 's3', tokens: 100000 })
assert.equal(handoff.stateOf('s3'), null)

// disabled means no action at all
handoff.saveConfig({ enabled: false })
assert.equal(handoff.evaluate({ sessionId: 's4', tokens: 999999 }).stage, 'off')
handoff.saveConfig({ enabled: true, triggerTokens: 50000 })
assert.equal(handoff.config().triggerTokens, 50000)
assert.equal(handoff.evaluate({ sessionId: 's5', tokens: 60000 }).stage, 'requested')

// arming the next session: one-shot, cwd-scoped, expiring
handoff.armNext('s1', {
  agentId: 'alpha',
  cwd: 'E:\\work',
  approval: 'never',
  model: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
  startupPrompt: '接着做。',
})
assert.equal(handoff.nextOf('s1').agentId, 'alpha')
assert.equal(handoff.takeNext({ cwd: 'E:\\other' }), null)
assert.ok(handoff.nextOf('s1'))
const taken = handoff.takeNext({ cwd: 'E:\\work' })
assert.equal(taken.sessionId, 's1')
assert.equal(taken.agentId, 'alpha')
assert.equal(taken.approval, 'never')
assert.equal(taken.startupPrompt, '接着做。')
assert.deepEqual(taken.model, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' })
assert.equal(handoff.takeNext({ cwd: 'E:\\work' }), null)
assert.equal(handoff.nextOf('s1'), null)

// an intent without a cwd matches any directory
handoff.armNext('s2', { agentId: 'beta' })
assert.equal(handoff.takeNext({ cwd: 'E:\\work' }).sessionId, 's2')

// and it expires instead of capturing a much later session
handoff.armNext('s2', { agentId: 'beta' })
clock += 31 * 60 * 1000
assert.equal(handoff.takeNext({ cwd: 'E:\\work' }), null)
assert.equal(handoff.nextOf('s2'), null)

// checkpoint text carries memory and the journal index
const text = handoff.buildCheckpointText({
  agentId: 'alpha',
  agentName: 'Alpha',
  sessionId: 'session-abc12345',
  tokens: 312000,
  threshold: 300000,
  memory: '下一步：接上界面。',
  entries: [{ id: 'j-1', at: '2026-10-20T11:00:00.000Z', title: '第一步' }],
})
assert.ok(text.includes('下一步：接上界面。'))
assert.ok(text.includes('312,000'))
assert.ok(text.includes('j-1'))

// export is off by default, and writes a file when a directory is set
assert.equal(handoff.exportCheckpoint({ text, sessionId: 'session-abc12345' }), '')
handoff.saveConfig({ exportDir: path.join(scratch, 'out') })
const file = handoff.exportCheckpoint({ text, sessionId: 'session-abc12345' })
assert.ok(file !== '')
assert.equal(fs.existsSync(file), true)
assert.ok(fs.readFileSync(file, 'utf8').includes('下一步：接上界面。'))

fs.rmSync(scratch, { recursive: true, force: true })
console.log('ALL HANDOFF TESTS PASSED')
