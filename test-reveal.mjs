/**
 * `fs.reveal` opens a directory the *host* chose, never a path the page sent.
 * These checks keep the seam from drifting into "open anything".
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = name => import(`file://${path.join(here, name).replace(/\\/g, '/')}`)

const { createReveal, REVEAL_TARGETS } = await load('reveal.js')

assert.deepEqual(REVEAL_TARGETS, ['root', 'knowledge', 'plugin'])

// ── per-platform command ────────────────────────────────────────────────────
for (const [platform, command, args] of [
  ['win32', 'explorer.exe', ['C:\\data']],
  ['darwin', 'open', ['/data']],
  ['linux', 'xdg-open', ['/data']],
]) {
  const calls = []
  const reveal = createReveal({
    platform,
    run: (cmd, argv, options) => {
      calls.push({ cmd, argv, options })
      return { on() {}, unref() {} }
    },
  })
  assert.equal(reveal(platform === 'win32' ? 'C:\\data' : '/data'), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cmd, command)
  assert.deepEqual(calls[0].argv, args)
  assert.equal(calls[0].options.detached, true)
  assert.equal(calls[0].options.stdio, 'ignore')
}

// ── refuses to spawn for nonsense ───────────────────────────────────────────
{
  const calls = []
  const reveal = createReveal({ platform: 'linux', run: () => (calls.push(1), { on() {}, unref() {} }) })
  assert.equal(reveal(''), false)
  assert.equal(reveal(undefined), false)
  assert.equal(reveal(42), false)
  assert.equal(calls.length, 0)
}

// ── a throwing spawn reports failure instead of crashing the request ────────
{
  const reveal = createReveal({
    platform: 'linux',
    run: () => {
      throw new Error('ENOENT')
    },
  })
  assert.equal(reveal('/data'), false)
}

console.log('reveal: commands, guards, failure path ok')
console.log('ALL REVEAL TESTS PASSED')
