/**
 * Agent teams: projects, tasks, attempts and reports, stored as files.
 *
 * A team is a project with one lead and several members; every member is an
 * agent from the vault registry — the unit of a team is the agent, never a
 * session. Tasks are assigned to members; each hand-over is an attempt, and a
 * member reports through a small, fixed state machine:
 *
 *   Task:    open → assigned → running → (waiting | review | blocked) → done | failed | cancelled
 *   Attempt: queued → running → (running | waiting | ready | blocked | failed | dropped | cancelled)
 *
 * Plain Node file storage, no Cordis dependency, so the model tools, the panel
 * and the tests all use the same functions.
 *
 * Layout:
 *   <root>/team/projects/<projectId>/project.json   members, lead, capacity
 *   <root>/team/projects/<projectId>/tasks.json     materialized tasks + attempts
 *   <root>/team/projects/<projectId>/events.jsonl   append-only audit / recovery source
 *
 * `tasks.json` is derived state that can be rebuilt from `events.jsonl`; the
 * event stream is the source of truth.
 *
 * @module team/store
 */

import fs from 'node:fs'
import path from 'node:path'

import { MemoryError } from '../store.js'

const ID_RE = /^[pt]-[a-z0-9]{4,12}$/
const ATTEMPT_RE = /^a-[a-z0-9]{4,12}$/
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

const TASK_STATES = new Set(['open', 'assigned', 'running', 'waiting', 'review', 'blocked', 'failed', 'done', 'cancelled'])
const TERMINAL_TASK = new Set(['done', 'cancelled'])
const ACTIVE_TASK = new Set(['open', 'assigned', 'running', 'waiting', 'review', 'blocked'])
const REPORT_STATES = new Set(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'])
const ACTIVE_ATTEMPT = new Set(['queued', 'running', 'waiting'])

/** How a report moves its task. `progress` keeps the task running. */
const TASK_BY_REPORT = {
  progress: 'running',
  waiting: 'waiting',
  ready: 'review',
  blocked: 'blocked',
  failed: 'failed',
  dropped: 'cancelled',
}

const LIMITS = {
  name: 80,
  title: 200,
  brief: 4000,
  acceptance: 1000,
  summary: 600,
  question: 500,
  note: 1000,
  files: 20,
  filePath: 300,
  members: 20,
  capacity: [1, 10],
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, text, 'utf8')
  fs.renameSync(temp, file)
}

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function soon() {
  return new Date().toISOString()
}

function newId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2).padEnd(8, '0').slice(0, 8)}`
}

function clampInt(value, low, high, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.trunc(number), low), high)
}

function textOf(value, limit, code) {
  const text = collapse(value).slice(0, limit)
  if (text === '') throw new MemoryError(code, 'text is required')
  return text
}

/**
 * Create the team store rooted at `<memoryDir>/team`.
 * `agents()` returns the registered agents (`{id, name}`), so the team layer
 * never keeps its own copy of the roster.
 */
export function createTeam(options = {}) {
  const root = path.resolve(options.rootDir || '.')
  const projectsDir = path.join(root, 'projects')
  const knownAgents = typeof options.agents === 'function' ? options.agents : () => []
  const staleMs = Number.isFinite(options.staleMs) && options.staleMs > 0 ? options.staleMs : 30 * 60 * 1000

  /** One promise chain per project: every mutation reads, changes and writes under the same lock. */
  const locks = new Map()

  fs.mkdirSync(projectsDir, { recursive: true })

  function dirOf(id) {
    return path.join(projectsDir, id)
  }
  function projectFile(id) {
    return path.join(dirOf(id), 'project.json')
  }
  function tasksFile(id) {
    return path.join(dirOf(id), 'tasks.json')
  }
  function eventsFile(id) {
    return path.join(dirOf(id), 'events.jsonl')
  }

  function agentMap() {
    return new Map(knownAgents().map(agent => [agent.id, agent]))
  }

  function requireKnownAgent(id, code = 'no-agent') {
    const key = String(id ?? '')
    if (!AGENT_ID.test(key)) throw new MemoryError(code, `invalid agent id: ${key || '(empty)'}`)
    if (!agentMap().has(key)) throw new MemoryError(code, `unknown agent: ${key}`)
    return key
  }

  function projectIdOf(value) {
    const id = String(value ?? '')
    if (!/^p-[a-z0-9]{4,12}$/.test(id)) throw new MemoryError('bad-project', `invalid project id: ${id || '(empty)'}`)
    return id
  }

  function taskIdOf(value) {
    const id = String(value ?? '')
    if (!/^t-[a-z0-9]{4,12}$/.test(id)) throw new MemoryError('bad-task', `invalid task id: ${id || '(empty)'}`)
    return id
  }

  function withLock(id, run) {
    const previous = locks.get(id) ?? Promise.resolve()
    const next = previous.then(run, run)
    locks.set(id, next.then(() => undefined, () => undefined))
    return next
  }

  function event(project, type, payload = {}) {
    fs.appendFileSync(eventsFile(project), `${JSON.stringify({ at: soon(), type, project, ...payload })}\n`)
  }

  function readProject(id) {
    const project = readJson(projectFile(id), undefined)
    if (project === undefined || project === null) throw new MemoryError('no-project', `unknown project: ${id}`)
    return project
  }

  function saveProject(project) {
    project.updatedAt = soon()
    writeAtomic(projectFile(project.id), `${JSON.stringify(project, null, 2)}\n`)
  }

  function readTasks(id) {
    const doc = readJson(tasksFile(id), { version: 1, tasks: [] })
    return Array.isArray(doc.tasks) ? doc : { version: 1, tasks: [] }
  }

  function saveTasks(projectId, doc) {
    doc.updatedAt = soon()
    writeAtomic(tasksFile(projectId), `${JSON.stringify(doc, null, 2)}\n`)
  }

  function findTask(doc, taskId) {
    const task = doc.tasks.find(item => item.id === taskId)
    if (task === undefined) throw new MemoryError('no-task', `unknown task: ${taskId}`)
    return task
  }

  function activeAttemptOf(task) {
    for (let index = task.attempts.length - 1; index >= 0; index -= 1) {
      if (ACTIVE_ATTEMPT.has(task.attempts[index].state)) return task.attempts[index]
    }
    return undefined
  }

  function cancelActiveAttempt(attempt, reason) {
    if (!ACTIVE_ATTEMPT.has(attempt.state)) return
    attempt.state = 'cancelled'
    attempt.endedAt = soon()
    attempt.cancelledReason = reason
  }

  function newAttempt(task, assignee) {
    return {
      id: newId('a'),
      task: task.id,
      assignee,
      sessionId: '',
      state: 'queued',
      createdAt: soon(),
      startedAt: '',
      endedAt: '',
      report: undefined,
    }
  }

  function requireLead(project, editor) {
    if (editor !== project.lead) {
      throw new MemoryError('not-lead', `only the lead (${project.lead}) may do this`)
    }
    return editor
  }

  function requireMember(project, id) {
    if (!project.members.includes(id)) throw new MemoryError('not-member', `${id} is not a member of this project`)
    return id
  }

  // ── projects ───────────────────────────────────────────────────────────────

  function createProject(input = {}) {
    const name = textOf(input.name, LIMITS.name, 'bad-project')
    const lead = requireKnownAgent(input.lead, 'no-lead')
    const rawMembers = Array.isArray(input.members) ? input.members : []
    const members = []
    for (const item of rawMembers) {
      const member = requireKnownAgent(item, 'no-member')
      if (member === lead || members.includes(member)) continue
      members.push(member)
    }
    if (members.length > LIMITS.members) throw new MemoryError('bad-members', `at most ${LIMITS.members} members`)
    const roomId = typeof input.roomId === 'string' ? input.roomId.trim().slice(0, 40) : ''
    const now = soon()
    let id = newId('p')
    while (fs.existsSync(dirOf(id))) id = newId('p')
    const project = {
      version: 1,
      id,
      name,
      lead,
      members,
      roomId,
      capacity: clampInt(input.capacity, LIMITS.capacity[0], LIMITS.capacity[1], 3),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }
    saveProject(project)
    event(id, 'project.created', { lead, members })
    return project
  }

  function listProjects() {
    let names = []
    try {
      names = fs.readdirSync(projectsDir).filter(name => /^p-[a-z0-9]{4,12}$/.test(name))
    } catch {
      return []
    }
    const rows = []
    for (const id of names) {
      try {
        const project = readProject(id)
        const doc = readTasks(id)
        const total = doc.tasks.length
        const active = doc.tasks.filter(task => ACTIVE_TASK.has(task.status)).length
        rows.push({
          id: project.id,
          name: project.name,
          lead: project.lead,
          members: project.members,
          capacity: project.capacity,
          status: project.status,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          tasks: { total, active, done: total - active },
        })
      } catch {
        /* a broken project directory is skipped, never fatal */
      }
    }
    rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    return rows
  }

  function project(id) {
    const project = readProject(projectIdOf(id))
    return { ...project, tasks: readTasks(project.id).tasks }
  }

  function addMember(input = {}) {
    const id = projectIdOf(input.project)
    return withLock(id, () => {
      const project = readProject(id)
      requireLead(project, input.by)
      const member = requireKnownAgent(input.member, 'no-member')
      if (member === project.lead) throw new MemoryError('bad-member', 'the lead is not a member')
      if (project.members.includes(member)) throw new MemoryError('bad-member', `${member} is already a member`)
      if (project.members.length >= LIMITS.members) throw new MemoryError('bad-members', `at most ${LIMITS.members} members`)
      project.members.push(member)
      saveProject(project)
      event(id, 'member.added', { member })
      return project
    })
  }

  function removeMember(input = {}) {
    const id = projectIdOf(input.project)
    return withLock(id, () => {
      const project = readProject(id)
      requireLead(project, input.by)
      const member = requireMember(project, requireKnownAgent(input.member, 'no-member'))
      const doc = readTasks(id)
      const held = doc.tasks.filter(task => task.assignee === member && ACTIVE_TASK.has(task.status))
      if (held.length > 0) {
        throw new MemoryError('member-busy', `${member} still holds ${held.length} active task(s): ${held.map(task => task.id).join(', ')}`)
      }
      project.members = project.members.filter(item => item !== member)
      saveProject(project)
      event(id, 'member.removed', { member })
      return project
    })
  }

  // ── tasks ──────────────────────────────────────────────────────────────────

  function createTask(input = {}) {
    const project = readProject(projectIdOf(input.project))
    const title = textOf(input.title, LIMITS.title, 'bad-task')
    const brief = textOf(input.brief, LIMITS.brief, 'bad-task')
    const acceptance = collapse(input.acceptance).slice(0, LIMITS.acceptance)
    const createdBy = String(input.createdBy ?? 'user')
    if (createdBy !== 'user') requireKnownAgent(createdBy, 'no-agent')
    const assignee = input.assignee === undefined || input.assignee === null || input.assignee === ''
      ? ''
      : requireMember(project, requireKnownAgent(input.assignee, 'no-member'))
    const now = soon()
    const task = {
      id: newId('t'),
      project: project.id,
      title,
      brief,
      acceptance,
      assignee,
      status: 'open',
      createdBy,
      attempts: [],
      knowledge: [],
      createdAt: now,
      updatedAt: now,
      closedAt: '',
      closedBy: '',
      closeNote: '',
    }
    if (assignee !== '') {
      task.status = 'assigned'
      task.attempts.push(newAttempt(task, assignee))
    }
    return withLock(project.id, () => {
      const doc = readTasks(project.id)
      doc.tasks.push(task)
      saveTasks(project.id, doc)
      event(project.id, 'task.created', { task: task.id, assignee })
      return task
    })
  }

  function assignTask(input = {}) {
    const id = projectIdOf(input.project)
    return withLock(id, () => {
      const project = readProject(id)
      requireLead(project, input.by)
      const member = requireMember(project, requireKnownAgent(input.member, 'no-member'))
      const doc = readTasks(id)
      const task = findTask(doc, taskIdOf(input.task))
      if (TERMINAL_TASK.has(task.status)) throw new MemoryError('task-closed', `task ${task.id} is ${task.status}`)
      const previous = activeAttemptOf(task)
      if (previous) cancelActiveAttempt(previous, 'reassigned')
      const attempt = newAttempt(task, member)
      task.attempts.push(attempt)
      task.assignee = member
      task.status = 'assigned'
      task.updatedAt = soon()
      saveTasks(id, doc)
      event(id, 'task.assigned', { task: task.id, member, attempt: attempt.id })
      return { task, attempt }
    })
  }

  function claimTask(input = {}) {
    const id = projectIdOf(input.project)
    return withLock(id, () => {
      const project = readProject(id)
      const agent = requireKnownAgent(input.agent, 'no-agent')
      const doc = readTasks(id)
      const task = findTask(doc, taskIdOf(input.task))
      if (task.assignee !== agent) throw new MemoryError('not-assignee', `task ${task.id} is assigned to ${task.assignee || '(nobody)'}`)
      if (TERMINAL_TASK.has(task.status)) throw new MemoryError('task-closed', `task ${task.id} is ${task.status}`)
      if (task.status !== 'assigned') throw new MemoryError('bad-state', `task ${task.id} is ${task.status}, not assigned`)
      const attempt = activeAttemptOf(task)
      if (!attempt || attempt.state !== 'queued') throw new MemoryError('bad-state', `task ${task.id} has no queued attempt`)
      attempt.state = 'running'
      attempt.startedAt = soon()
      attempt.sessionId = typeof input.sessionId === 'string' ? input.sessionId.slice(0, 120) : ''
      task.status = 'running'
      task.updatedAt = soon()
      saveTasks(id, doc)
      event(id, 'attempt.started', { task: task.id, attempt: attempt.id, member: agent })
      return { task, attempt }
    })
  }

  function reportTask(input = {}) {
    const id = projectIdOf(input.project)
    return withLock(id, () => {
      const agent = requireKnownAgent(input.agent, 'no-agent')
      const doc = readTasks(id)
      const task = findTask(doc, taskIdOf(input.task))
      if (task.assignee !== agent) throw new MemoryError('not-assignee', `task ${task.id} is assigned to ${task.assignee || '(nobody)'}`)
      if (TERMINAL_TASK.has(task.status)) throw new MemoryError('task-closed', `task ${task.id} is ${task.status}`)
      const state = String(input.state ?? '')
      if (!REPORT_STATES.has(state)) throw new MemoryError('bad-state', `report state must be one of ${[...REPORT_STATES].join(', ')}`)
      const summary = textOf(input.summary, LIMITS.summary, 'bad-report')
      const question = collapse(input.question).slice(0, LIMITS.question)
      const files = Array.isArray(input.files)
        ? input.files.filter(item => typeof item === 'string' && item.trim() !== '').slice(0, LIMITS.files).map(item => item.trim().slice(0, LIMITS.filePath))
        : []
      const attempt = activeAttemptOf(task)
      if (!attempt) throw new MemoryError('no-attempt', `task ${task.id} has no active attempt`)
      const at = soon()
      attempt.report = { state, summary, ...(question === '' ? {} : { question }), ...(files.length === 0 ? {} : { files }), at }
      if (state === 'progress') {
        // Still working: the task keeps running and the attempt stays open.
      } else {
        attempt.state = state
        attempt.endedAt = at
      }
      task.status = TASK_BY_REPORT[state]
      task.updatedAt = at
      saveTasks(id, doc)
      event(id, 'report.recorded', { task: task.id, attempt: attempt.id, member: agent, state })
      return { task, attempt }
    })
  }

  function closeTask(input = {}) {
    const id = projectIdOf(input.project)
    return withLock(id, () => {
      const project = readProject(id)
      if (input.by !== project.lead && input.by !== 'user') {
        throw new MemoryError('not-lead', `only the lead (${project.lead}) or the user may close a task`)
      }
      const outcome = String(input.outcome ?? '')
      if (outcome !== 'done' && outcome !== 'cancelled') {
        throw new MemoryError('bad-outcome', 'outcome must be done or cancelled')
      }
      const doc = readTasks(id)
      const task = findTask(doc, taskIdOf(input.task))
      if (TERMINAL_TASK.has(task.status)) throw new MemoryError('task-closed', `task ${task.id} is already ${task.status}`)
      const at = soon()
      const active = activeAttemptOf(task)
      if (active) cancelActiveAttempt(active, `task ${outcome}`)
      task.status = outcome
      task.closedAt = at
      task.closedBy = input.by
      task.closeNote = collapse(input.note).slice(0, LIMITS.note)
      task.updatedAt = at
      saveTasks(id, doc)
      event(id, 'task.closed', { task: task.id, outcome, by: input.by })
      return task
    })
  }

  function listTasks(input = {}) {
    const project = readProject(projectIdOf(input.project))
    const doc = readTasks(project.id)
    const status = typeof input.status === 'string' && input.status !== '' ? input.status : ''
    const only = typeof input.agent === 'string' && input.agent !== '' ? input.agent : ''
    let tasks = doc.tasks
    if (only !== '') tasks = tasks.filter(task => task.assignee === only)
    if (status !== '') {
      if (!TASK_STATES.has(status)) throw new MemoryError('bad-status', `unknown status: ${status}`)
      tasks = tasks.filter(task => task.status === status)
    }
    const rows = tasks.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    return {
      project: { id: project.id, name: project.name, lead: project.lead, members: project.members },
      tasks: rows.map(task => ({
        id: task.id,
        title: task.title,
        status: task.status,
        assignee: task.assignee,
        updatedAt: task.updatedAt,
        report: task.attempts.length > 0 ? task.attempts[task.attempts.length - 1].report : undefined,
      })),
    }
  }

  function memberStatus(input = {}) {
    const project = readProject(projectIdOf(input.project))
    const member = requireMember(project, requireKnownAgent(input.member, 'no-member'))
    const doc = readTasks(project.id)
    const own = doc.tasks.filter(task => task.assignee === member)
    const active = own.filter(task => ACTIVE_TASK.has(task.status))
    const last = own
      .slice()
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .find(task => task.attempts.length > 0)
    return {
      member,
      busy: active.some(task => task.status === 'running'),
      active: active.map(task => ({ id: task.id, title: task.title, status: task.status })),
      finished: own.filter(task => TERMINAL_TASK.has(task.status)).length,
      last: last === undefined
        ? undefined
        : {
            task: last.id,
            status: last.status,
            report: last.attempts[last.attempts.length - 1].report,
          },
    }
  }

  /**
   * Mark attempts left `running` by a stopped host as failed, so a stale lock
   * never looks like work in progress. Called once when the plugin starts.
   */
  function recoverStale(now = Date.now()) {
    let recovered = 0
    for (const row of listProjects()) {
      const doc = readTasks(row.id)
      let changed = false
      for (const task of doc.tasks) {
        if (TERMINAL_TASK.has(task.status)) continue
        for (const attempt of task.attempts) {
          if (attempt.state !== 'running') continue
          const started = Date.parse(attempt.startedAt || attempt.createdAt || '')
          if (!Number.isFinite(started) || now - started < staleMs) continue
          attempt.state = 'failed'
          attempt.endedAt = soon()
          attempt.report = {
            state: 'failed',
            summary: 'Recovered after the host stopped mid-attempt; assign this task again to continue.',
            at: soon(),
          }
          task.status = 'failed'
          task.updatedAt = soon()
          changed = true
          recovered += 1
          event(row.id, 'attempt.stale', { task: task.id, attempt: attempt.id })
        }
      }
      if (changed) saveTasks(row.id, doc)
    }
    return recovered
  }

  recoverStale()

  return {
    root,
    projectsDir,
    LIMITS,
    createProject,
    listProjects,
    project,
    addMember,
    removeMember,
    createTask,
    assignTask,
    claimTask,
    reportTask,
    closeTask,
    listTasks,
    memberStatus,
    recoverStale,
  }
}
