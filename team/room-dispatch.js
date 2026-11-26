/**
 * Room mention dispatch: a person's message in a discussion room may @ members;
 * each mention creates (or reuses) the agent's bound conversation and delivers
 * the room message there, so the room doubles as the team's task surface.
 *
 * Mentions resolve against the room's members only, by agent id or by the
 * registered display name (the longest match wins). Only a person's message
 * dispatches: an agent speaking through `agent_room` never wakes another agent,
 * so two agents cannot ping-pong mentions.
 *
 * Delivery reuses the team dispatcher's session binding and inbox API with a
 * deterministic id (`vault-room:<room>:<message>:<agent>`), so a repeated say is
 * delivered once. The result is annotated on the stored message as `dispatched`
 * and `dispatchFailed`.
 *
 * @module team/room-dispatch
 */

import { withTimeout } from './dispatch.js'

const MAX_TRANSCRIPT = 10
const MAX_LINE = 400
/** A mention must not hold the panel request forever. */
const DELIVERY_TIMEOUT_MS = 30_000

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

export function createRoomDispatch(options = {}) {
  const { rooms, store, dispatch, team } = options
  const log = typeof options.log === 'function' ? options.log : () => {}

  function agentRows() {
    try {
      const vaults = store.state().vaults ?? []
      return vaults
        .map(item => ({ id: String(item.id ?? ''), name: String(item.name ?? '') }))
        .filter(item => item.id !== '')
    } catch {
      return []
    }
  }

  /** Members mentioned in `text`, in first-mention order, without duplicates. */
  function mentions(room, text) {
    const members = Array.isArray(room.members) ? room.members : []
    if (members.length === 0) return []
    const byId = new Map(agentRows().map(row => [row.id, row]))
    const candidates = []
    for (const memberId of members) {
      const row = byId.get(memberId) ?? { id: memberId, name: memberId }
      if (row.name !== '') candidates.push({ token: row.name, row })
      candidates.push({ token: row.id, row })
    }
    const found = []
    const seen = new Set()
    const source = String(text)
    let at = source.indexOf('@')
    while (at !== -1) {
      let best = null
      for (const candidate of candidates) {
        if (best !== null && candidate.token.length <= best.token.length) continue
        if (source.startsWith(`@${candidate.token}`, at)) best = candidate
      }
      if (best === null) {
        at = source.indexOf('@', at + 1)
        continue
      }
      if (!seen.has(best.row.id)) {
        seen.add(best.row.id)
        found.push(best.row)
      }
      at = source.indexOf('@', at + best.token.length)
    }
    return found
  }

  /** The active team whose room this is, for the no-mention lead handoff. */
  function projectOfRoom(room) {
    if (team === undefined || team === null || typeof team.listProjects !== 'function') return null
    try {
      return (
        team
          .listProjects()
          .find(item => item.roomId === room.id && item.status === 'active') ?? null
      )
    } catch {
      return null
    }
  }

  function leadText(room, transcript, project, text) {
    const lines = [`[Room "${room.name}" (${room.id})]`, `[You are the lead of team "${project.name}" (${project.id}).]`]
    if (transcript.length > 0) {
      lines.push('[Recent transcript]')
      for (const item of transcript) {
        const who = item.from?.name || item.from?.id || '?'
        lines.push(`${who}: ${collapse(item.text).slice(0, MAX_LINE)}`)
      }
    }
    const members = [project.lead, ...(project.members ?? [])].filter(id => id !== '')
    lines.push(
      '',
      '[Your turn as the lead]',
      'A person posted to the whole team without addressing anyone.',
      text,
      '',
      'Triage it:',
      `- If it is work, split it into one task per deliverable with team_task_create (project=${project.id}, assignee=<member>). ` +
        'Assigning wakes the member automatically, so do not ping them in the room. ' +
        `The members are: ${members.join(', ')}.`,
      `- If it needs no work, answer with agent_room say (room=${room.id}).`,
    )
    return lines.join('\n')
  }

  function messageText(room, transcript, row, text) {
    const lines = [`[Room "${room.name}" (${room.id})]`]
    if (transcript.length > 0) {
      lines.push('[Recent transcript]')
      for (const item of transcript) {
        const who = item.from?.name || item.from?.id || '?'
        lines.push(`${who}: ${collapse(item.text).slice(0, MAX_LINE)}`)
      }
    }
    lines.push(
      '',
      `[Your turn as ${row.name || row.id}]`,
      text,
      '',
      `Reply in the room with agent_room say (room=${room.id}). ` +
        'If this belongs to a team task, use team_task_report.',
    )
    return lines.join('\n')
  }

  /**
   * Post a message and wake every mentioned room member. Returns the annotated
   * message plus which agents were woken and which could not be reached.
   */
  async function say({ id, text, from }) {
    const room = rooms.requireRoom(id)
    const speaker = from !== null && typeof from === 'object' ? from : { kind: 'user', id: 'user', name: '我' }
    const targets = speaker.kind === 'user' ? mentions(room, text) : []
    // A person addressing the room as a whole hands the message to the lead,
    // who decides whether it becomes tasks; mentioning someone keeps that
    // agent the only receiver.
    const project = targets.length === 0 && speaker.kind === 'user' ? projectOfRoom(room) : null
    const message = rooms.say({ id: room.id, text, from: speaker })
    if (targets.length === 0 && project === null) return { message, dispatched: [], failed: [] }
    if (dispatch === undefined || dispatch === null || typeof dispatch.deliver !== 'function') {
      return { message, dispatched: [], failed: targets.map(row => row.id), unsupported: true }
    }
    const transcript = rooms
      .read({ id: room.id, limit: MAX_TRANSCRIPT + 1 })
      .messages.filter(item => item.id !== message.id)
      .slice(-MAX_TRANSCRIPT)
    const dispatched = []
    const failed = []
    const deliverOne = async (row, text) => {
      try {
        const result = await withTimeout(
          dispatch.deliver(row.id, {
            id: `vault-room:${room.id}:${message.id}:${row.id}`,
            text,
          }),
          DELIVERY_TIMEOUT_MS,
          'room dispatch',
        )
        if (result?.delivered === true) dispatched.push(row.id)
        else failed.push(row.id)
      } catch (error) {
        failed.push(row.id)
        log(`room dispatch to ${row.id} failed: ${String(error?.message ?? error)}`)
      }
    }
    for (const row of targets) await deliverOne(row, messageText(room, transcript, row, message.text))
    if (project !== null) {
      const leadRow = agentRows().find(item => item.id === project.lead) ?? { id: project.lead, name: project.lead }
      await deliverOne(leadRow, leadText(room, transcript, project, message.text))
    }
    const annotated =
      dispatched.length > 0 || failed.length > 0
        ? rooms.annotate({
            id: room.id,
            message: message.id,
            patch: { ...(dispatched.length > 0 ? { dispatched } : {}), ...(failed.length > 0 ? { dispatchFailed: failed } : {}) },
          })
        : undefined
    return { message: annotated ?? message, dispatched, failed }
  }

  return { say, mentions }
}
