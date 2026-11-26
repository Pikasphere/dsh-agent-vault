/** Team dispatch: wake a member for a queued attempt, relay reports, skip duplicates, degrade without the inbox API. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { createTeam } = await import(`file://${path.join(here, 'team', 'store.js').replace(/\\/g, '/')}`)
const { createTeamDispatch } = await import(`file://${path.join(here, 'team', 'dispatch.js').replace(/\\/g, '/')}`)

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-team-dispatch-'))
const root = path.join(scratch, 'mem')
const agents = [
  { id: 'alpha', name: 'Alpha' },
  { id: 'beta', name: 'Beta' },
]
const team = createTeam({ rootDir: root, agents: () => agents })

// A fake host: bindings map, a session per binding, agents that record deliveries and keep them in the inbox.
const bindings = new Map([['sess-alpha', 'alpha'], ['sess-beta', 'beta']])
const fakeStore = {
  listBindings: () => [...bindings].map(([sessionId, agentId]) => ({ sessionId, agentId })),
  setBinding: ({ sessionId, agentId }) => bindings.set(sessionId, agentId),
}
const delivered = []
function makeHost(withInbox) {
  const sessions = new Map()
  function agentOf(sessionId) {
    if (!sessions.has(sessionId)) {
      const agent = {
        id: sessionId,
        inbox: { nextTurn: [], nextStep: [] },
        deliver(message) {
          delivered.push({ sessionId, id: message.id, text: message.content[0].text })
          agent.inbox.nextTurn.push(message)
        },
      }
      if (withInbox) agent.followup = message => agent.deliver(message)
      sessions.set(sessionId, agent)
    }
    return sessions.get(sessionId)
  }
  return {
    controller: {
      create: async () => ({ sessionId: `sess-created-${sessions.size + 1}` }),
      resolveAgent: async id => ({ agent: agentOf(id) }),
    },
    persistence: { flush: async () => {} },
  }
}
const ctxFor = mock => ({ get: name => (name === 'sessionController' ? mock.controller : name === 'sessionPersistence' ? mock.persistence : undefined) })
const logs = []
const ctx = ctxFor(makeHost(true))
const dispatch = createTeamDispatch({ ctx, store: fakeStore, team, log: message => logs.push(message) })

const project = team.createProject({ name: '调度测试', lead: 'alpha', members: ['beta'] })
const task = await team.createTask({ project: project.id, title: '唤醒成员', brief: '看到这条就 claim 并汇报', createdBy: 'alpha' })
await team.assignTask({ project: project.id, task: task.id, member: 'beta', by: 'alpha' })

// ── wake ────────────────────────────────────────────────────────────────────
await dispatch.drain()
assert.equal(delivered.length, 1)
assert.equal(delivered[0].sessionId, 'sess-beta')
assert.match(delivered[0].text, /\[Team task\]/)
assert.match(delivered[0].text, new RegExp(`task: ${task.id}`))
assert.match(delivered[0].text, /team_task_report/)
assert.equal(delivered[0].id, `vault-team:dispatch:${team.project(project.id).tasks[0].attempts[0].id}`)

const afterWake = team.project(project.id).tasks[0]
assert.equal(afterWake.status, 'running')
assert.equal(afterWake.attempts[0].state, 'running')
assert.equal(afterWake.attempts[0].sessionId, 'sess-beta')

// ── a crash between wake and claim does not send twice ─────────────────────
const tasksPath = path.join(root, 'projects', project.id, 'tasks.json')
const rewrite = change => {
  const doc = JSON.parse(fs.readFileSync(tasksPath, 'utf8'))
  change(doc)
  fs.writeFileSync(tasksPath, JSON.stringify(doc, null, 2))
}
rewrite(doc => {
  doc.tasks[0].status = 'assigned'
  doc.tasks[0].attempts[0].state = 'queued'
  doc.tasks[0].attempts[0].sessionId = ''
})
await dispatch.drain()
assert.equal(delivered.length, 1, 'the message is already in the inbox')
assert.equal(team.project(project.id).tasks[0].status, 'running')

// ── report relayed to the lead ─────────────────────────────────────────────
await team.reportTask({ project: project.id, task: task.id, agent: 'beta', state: 'ready', summary: '成员写好了', files: ['src/x.js'] })
assert.equal(team.pendingRelays().length, 1)
await dispatch.drain()
const leadDelivery = delivered.find(item => item.sessionId === 'sess-alpha')
assert.ok(leadDelivery !== undefined)
assert.match(leadDelivery.text, /\[Team report\]/)
assert.match(leadDelivery.text, /成员写好了/)
assert.match(leadDelivery.text, /src\/x\.js/)
const relayed = team.project(project.id).tasks[0].attempts[0]
assert.equal(typeof relayed.relayedAt, 'string')
assert.equal(relayed.relayedAt !== '', true)

// a relay retried after a crash is skipped by its inbox id
rewrite(doc => { delete doc.tasks[0].attempts[0].relayedAt })
await dispatch.drain()
assert.equal(delivered.filter(item => item.sessionId === 'sess-alpha').length, 1)

// ── degraded hosts leave the attempt queued instead of failing ─────────────
const degradedTeam = createTeam({ rootDir: path.join(scratch, 'degraded'), agents: () => agents })
const degradedProject = degradedTeam.createProject({ name: '降级', lead: 'alpha', members: ['beta'] })
const degradedTask = await degradedTeam.createTask({ project: degradedProject.id, title: '没有 inbox', brief: 'x', assignee: 'beta', createdBy: 'alpha' })
const degradedDispatch = createTeamDispatch({ ctx: { get: () => undefined }, store: fakeStore, team: degradedTeam, log: () => {} })
await degradedDispatch.drain()
assert.equal(degradedTeam.pendingDispatches().length, 1, 'stays queued for the manual claim path')
assert.equal(degradedTeam.project(degradedProject.id).tasks[0].status, 'assigned')

// an agent without followup is skipped the same way
const noInboxTeam = createTeam({ rootDir: path.join(scratch, 'no-inbox'), agents: () => agents })
const noInboxProject = noInboxTeam.createProject({ name: '无 inbox', lead: 'alpha', members: ['beta'] })
await noInboxTeam.createTask({ project: noInboxProject.id, title: 'y', brief: 'y', assignee: 'beta', createdBy: 'alpha' })
const noInboxDispatch = createTeamDispatch({ ctx: ctxFor(makeHost(false)), store: fakeStore, team: noInboxTeam, log: () => {} })
await noInboxDispatch.drain()
assert.equal(noInboxTeam.pendingDispatches().length, 1)

fs.rmSync(scratch, { recursive: true, force: true })
console.log('ALL TEAM DISPATCH TESTS PASSED')
