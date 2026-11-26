/** Agent teams: projects, tasks, attempts, reports, persistence and stale recovery. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { createTeam } = await import(`file://${path.join(here, 'team', 'store.js').replace(/\\/g, '/')}`)
const { MemoryError } = await import(`file://${path.join(here, 'store.js').replace(/\\/g, '/')}`)

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-team-'))
const root = path.join(scratch, 'mem')
const agents = [
  { id: 'alpha', name: 'Alpha' },
  { id: 'beta', name: 'Beta' },
  { id: 'gamma', name: 'Gamma' },
  { id: 'delta', name: 'Delta' },
]
const team = createTeam({ rootDir: root, agents: () => agents })

const code = (fn, expected) => {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof MemoryError, `expected MemoryError, got ${error}`)
    assert.equal(error.code, expected)
    return
  }
  assert.fail(`expected ${expected}`)
}
const rejects = async (promise, expected) => {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof MemoryError, `expected MemoryError, got ${error}`)
    assert.equal(error.code, expected)
    return
  }
  assert.fail(`expected ${expected}`)
}

// ── projects ────────────────────────────────────────────────────────────────

const project = team.createProject({ name: '搜索重写', lead: 'alpha', members: ['beta', 'beta', 'gamma'], capacity: 2 })
assert.match(project.id, /^p-[a-z0-9]{4,12}$/)
assert.equal(project.lead, 'alpha')
assert.deepEqual(project.members, ['beta', 'gamma'], 'duplicates and the lead are dropped')
assert.equal(project.capacity, 2)
assert.equal(project.roomId, '')
assert.equal(team.listProjects().length, 1)
assert.equal(team.listProjects()[0].tasks.total, 0)
assert.deepEqual(team.slots(project.id), { project: project.id, running: 0, capacity: 2 })

code(() => team.createProject({ name: 'x', lead: 'nobody' }), 'no-lead')
code(() => team.createProject({ name: '  ', lead: 'alpha' }), 'bad-project')
code(() => team.createProject({ name: 'x', lead: 'alpha', members: ['nobody'] }), 'no-member')
assert.equal(team.listProjects().length, 1, 'failed creation leaves no project')

// membership changes are lead-only and keep the roster coherent
await team.addMember({ project: project.id, member: 'delta', by: 'alpha' })
assert.deepEqual(team.project(project.id).members, ['beta', 'gamma', 'delta'])
await rejects(team.addMember({ project: project.id, member: 'beta', by: 'beta' }), 'not-lead')
await rejects(team.addMember({ project: project.id, member: 'alpha', by: 'alpha' }), 'bad-member')

// ── one agent, one active team ──────────────────────────────────────────────
// The binding model keeps one active conversation per agent, so two teams would
// wake the same conversation for both projects; the roster refuses that.
code(() => team.createProject({ name: '第二队', lead: 'alpha' }), 'agent-busy-team')
code(() => team.createProject({ name: '第二队', lead: 'beta', members: ['delta'] }), 'agent-busy-team')
assert.equal(team.listProjects().length, 1, 'a refused project leaves nothing behind')

// leaving the team frees the agent
await team.removeMember({ project: project.id, member: 'delta', by: 'alpha' })
const second = team.createProject({ name: '第二队', lead: 'delta' })
assert.match(second.id, /^p-[a-z0-9]{4,12}$/)
await rejects(team.addMember({ project: second.id, member: 'alpha', by: 'delta' }), 'agent-busy-team')

// archiving frees every member, including the lead, and freezes new work
const archived = await team.archiveProject({ project: second.id, by: 'delta' })
assert.equal(archived.status, 'archived')
assert.equal(team.listProjects().find(item => item.id === second.id).status, 'archived')
code(() => team.createTask({ project: second.id, title: 'x', brief: 'y' }), 'project-archived')
await rejects(team.addMember({ project: second.id, member: 'beta', by: 'delta' }), 'project-archived')
const third = team.createProject({ name: '第三队', lead: 'delta' })
assert.match(third.id, /^p-[a-z0-9]{4,12}$/, 'an archived project no longer occupies its members')

// ── tasks and assignment ────────────────────────────────────────────────────

const task = await team.createTask({ project: project.id, title: '重写查询层', brief: '按记录里的约束重写', createdBy: 'alpha' })
assert.match(task.id, /^t-[a-z0-9]{4,12}$/)
assert.equal(task.status, 'open')
assert.equal(task.assignee, '')

const assigned = await team.assignTask({ project: project.id, task: task.id, member: 'beta', by: 'alpha' })
assert.equal(assigned.task.status, 'assigned')
assert.equal(assigned.task.assignee, 'beta')
assert.equal(assigned.attempt.state, 'queued')

await rejects(team.assignTask({ project: project.id, task: task.id, member: 'beta', by: 'beta' }), 'not-lead')
await rejects(team.assignTask({ project: project.id, task: task.id, member: 'nobody', by: 'alpha' }), 'no-member')

// reclaiming cancels the previous open attempt
const reassigned = await team.assignTask({ project: project.id, task: task.id, member: 'gamma', by: 'alpha' })
assert.equal(reassigned.task.attempts.length, 2)
assert.equal(reassigned.task.attempts[0].state, 'cancelled')
assert.equal(reassigned.attempt.state, 'queued')

// ── claim and report ────────────────────────────────────────────────────────

await rejects(team.claimTask({ project: project.id, task: task.id, agent: 'beta' }), 'not-assignee')
const claimed = await team.claimTask({ project: project.id, task: task.id, agent: 'gamma', sessionId: 's-1' })
assert.equal(claimed.task.status, 'running')
assert.equal(claimed.attempt.state, 'running')
assert.equal(claimed.attempt.sessionId, 's-1')
assert.equal(team.slots(project.id).running, 1, 'a running attempt occupies one slot')

const progress = await team.reportTask({ project: project.id, task: task.id, agent: 'gamma', state: 'progress', summary: '改了一半' })
assert.equal(progress.task.status, 'running')
assert.equal(progress.attempt.state, 'running')
assert.equal(progress.attempt.report.state, 'progress')

await rejects(team.reportTask({ project: project.id, task: task.id, agent: 'beta', state: 'ready', summary: 'x' }), 'not-assignee')
await rejects(team.reportTask({ project: project.id, task: task.id, agent: 'gamma', state: 'finished', summary: 'x' }), 'bad-state')
await rejects(team.reportTask({ project: project.id, task: task.id, agent: 'gamma', state: 'ready', summary: '' }), 'bad-report')

const ready = await team.reportTask({
  project: project.id,
  task: task.id,
  agent: 'gamma',
  state: 'ready',
  summary: '查询层已重写，测试全绿',
  files: ['src/query.js', 'test-query.mjs'],
  knowledge: ['query-layer-notes', 'query-layer-notes'],
})
assert.equal(ready.task.status, 'review')
assert.equal(ready.attempt.state, 'ready')
assert.deepEqual(ready.attempt.report.files, ['src/query.js', 'test-query.mjs'])
assert.deepEqual(ready.attempt.report.knowledge, ['query-layer-notes'], 'task knowledge ids dedupe')
assert.equal(team.slots(project.id).running, 0, 'a finished attempt frees its slot')
assert.equal(ready.attempt.endedAt !== '', true)

// a closed task refuses further reports and assignments
const closed = await team.closeTask({ project: project.id, task: task.id, by: 'alpha', outcome: 'done', note: '验收通过' })
assert.equal(closed.status, 'done')
assert.equal(closed.closeNote, '验收通过')
await rejects(team.reportTask({ project: project.id, task: task.id, agent: 'gamma', state: 'ready', summary: 'x' }), 'task-closed')
await rejects(team.closeTask({ project: project.id, task: task.id, by: 'alpha', outcome: 'done' }), 'task-closed')
await rejects(team.closeTask({ project: project.id, task: task.id, by: 'beta', outcome: 'cancelled' }), 'not-lead')

// ── report states drive the task ────────────────────────────────────────────

const blocked = await team.createTask({ project: project.id, title: '接入上游', brief: '需要权限', assignee: 'beta', createdBy: 'alpha' })
assert.equal(blocked.status, 'assigned')
await team.claimTask({ project: project.id, task: blocked.id, agent: 'beta' })
const blockedReport = await team.reportTask({ project: project.id, task: blocked.id, agent: 'beta', state: 'blocked', summary: '缺 token', question: '能给我仓库写权限吗' })
assert.equal(blockedReport.task.status, 'blocked')
assert.equal(blockedReport.attempt.report.question, '能给我仓库写权限吗')

const cancelled = await team.createTask({ project: project.id, title: '补文档', brief: '写 README', assignee: 'gamma', createdBy: 'alpha' })
await team.claimTask({ project: project.id, task: cancelled.id, agent: 'gamma' })
const dropped = await team.reportTask({ project: project.id, task: cancelled.id, agent: 'gamma', state: 'dropped', summary: 'README 已由别人补过' })
assert.equal(dropped.task.status, 'cancelled')
assert.equal(dropped.attempt.state, 'dropped')

// a waiting report leaves the attempt open for another dispatch
const waiting = await team.createTask({ project: project.id, title: '选型', brief: '在 A/B 中选一个', assignee: 'beta', createdBy: 'alpha' })
await team.claimTask({ project: project.id, task: waiting.id, agent: 'beta' })
const waitingReport = await team.reportTask({ project: project.id, task: waiting.id, agent: 'beta', state: 'waiting', summary: '两个方案都能过', question: '优先延迟还是内存' })
assert.equal(waitingReport.task.status, 'waiting')
assert.equal(waitingReport.attempt.state, 'waiting')

// close cancels open attempts
const cancelOpen = await team.createTask({ project: project.id, title: '暂停线', brief: '先别做', assignee: 'gamma', createdBy: 'alpha' })
await team.claimTask({ project: project.id, task: cancelOpen.id, agent: 'gamma' })
const cancelledClose = await team.closeTask({ project: project.id, task: cancelOpen.id, by: 'alpha', outcome: 'cancelled' })
assert.equal(cancelledClose.status, 'cancelled')
assert.equal(cancelledClose.attempts[0].state, 'cancelled')

// ── listing and member status ───────────────────────────────────────────────

const all = team.listTasks({ project: project.id })
assert.equal(all.project.id, project.id)
assert.equal(all.tasks.length, 5)
const onlyBeta = team.listTasks({ project: project.id, agent: 'beta' })
assert.equal(onlyBeta.tasks.every(row => row.assignee === 'beta'), true)
const onlyReview = team.listTasks({ project: project.id, status: 'review' })
assert.equal(onlyReview.tasks.length, 0, 'the review task was accepted before the other tasks were created')

const status = team.memberStatus({ project: project.id, member: 'beta' })
assert.equal(status.member, 'beta')
assert.equal(status.active.some(row => row.id === blocked.id), true)
assert.equal(status.busy, false, 'beta holds no running attempt')
assert.equal(status.active.some(row => row.id === waiting.id), true, 'the waiting task shows as active')
assert.ok(status.last.report !== undefined)

// a member with an active task cannot be removed
await rejects(team.removeMember({ project: project.id, member: 'beta', by: 'alpha' }), 'member-busy')

// ── persistence, ids and events ─────────────────────────────────────────────

assert.match(task.id, /^t-[a-z0-9]{4,12}$/)
assert.match(assigned.attempt.id, /^a-[a-z0-9]{4,12}$/)
const events = fs.readFileSync(path.join(root, 'projects', project.id, 'events.jsonl'), 'utf8').trim().split('\n')
assert.equal(events.length > 5, true)
assert.equal(events.some(line => JSON.parse(line).type === 'report.recorded'), true)

const reopened = createTeam({ rootDir: root, agents: () => agents })
const persisted = reopened.project(project.id)
assert.equal(persisted.name, '搜索重写')
assert.equal(persisted.tasks.length, 5)
assert.equal(persisted.tasks.find(item => item.id === task.id).status, 'done')

// ── stale recovery ──────────────────────────────────────────────────────────

const stale = await reopened.createTask({ project: project.id, title: '中断的活', brief: '中途宿主停了', assignee: 'beta', createdBy: 'alpha' })
await reopened.claimTask({ project: project.id, task: stale.id, agent: 'beta' })
const tasksPath = path.join(root, 'projects', project.id, 'tasks.json')
const doc = JSON.parse(fs.readFileSync(tasksPath, 'utf8'))
const staleTask = doc.tasks.find(item => item.id === stale.id)
staleTask.attempts[0].startedAt = '2020-01-01T00:00:00.000Z'
fs.writeFileSync(tasksPath, JSON.stringify(doc, null, 2), 'utf8')

const afterRestart = createTeam({ rootDir: root, agents: () => agents, staleMs: 60000 })
const recovered = afterRestart.project(project.id).tasks.find(item => item.id === stale.id)
assert.equal(recovered.status, 'failed')
assert.equal(recovered.attempts[0].state, 'failed')
assert.equal(recovered.attempts[0].report.state, 'failed')

// ── stale recovery: resume policy ───────────────────────────────────────────
// `resume` puts the same attempt back in the queue with a recovery marker; the
// dispatcher turns that marker into the wake message's recovery note.
const resumeRoot = path.join(scratch, 'resume')
const resumeTeam = createTeam({ rootDir: resumeRoot, agents: () => agents, stalePolicy: 'resume' })
const resumeProject = resumeTeam.createProject({ name: '恢复队', lead: 'alpha', members: ['beta'] })
const resumeTask = await resumeTeam.createTask({
  project: resumeProject.id,
  title: '中断的活',
  brief: '宿主中途停了',
  assignee: 'beta',
  createdBy: 'alpha',
})
await resumeTeam.claimTask({ project: resumeProject.id, task: resumeTask.id, agent: 'beta' })
const resumePath = path.join(resumeRoot, 'projects', resumeProject.id, 'tasks.json')
const resumeDoc = JSON.parse(fs.readFileSync(resumePath, 'utf8'))
resumeDoc.tasks[0].attempts[0].startedAt = '2020-01-01T00:00:00.000Z'
fs.writeFileSync(resumePath, JSON.stringify(resumeDoc, null, 2), 'utf8')

const resumed = createTeam({ rootDir: resumeRoot, agents: () => agents, stalePolicy: 'resume', staleMs: 60000 })
const resumedTask = resumed.project(resumeProject.id).tasks.find(item => item.id === resumeTask.id)
assert.equal(resumedTask.status, 'assigned')
assert.equal(resumedTask.attempts[0].state, 'queued')
assert.equal(resumedTask.attempts[0].recovered, true)
const due = resumed.pendingDispatches()
assert.equal(due.length, 1)
assert.equal(due[0].recovered, true)

fs.rmSync(scratch, { recursive: true, force: true })
console.log('ALL TEAM TESTS PASSED')
