/**
 * Client-side guard.
 *
 * 1. `window.confirm()` is silently dropped inside some mobile webviews and
 *    embedded frames: the call returns false without showing anything, so a
 *    destructive button just looks dead (that is exactly how "删除智能体" broke
 *    on phones). The panel must ask with its own dialog instead.
 * 2. Every `t('key')` lookup must exist in both locale dictionaries; a missing
 *    key renders as `undefined` in the UI and is easy to ship unnoticed.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const raw = fs.readFileSync(path.join(here, 'client.js'), 'utf8')

// strip comments so the explanatory notes about window.confirm() do not count
const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')

const confirmCalls = source.match(/window\.confirm\s*\(/g) ?? []
assert.equal(confirmCalls.length, 0, 'client.js must not call window.confirm(); use askConfirm() so phones see the dialog')

assert.match(raw, /am-modal-mask/, 'the in-panel confirmation dialog markup is missing')

const keys = new Set()
for (const match of source.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)) keys.add(match[1])
assert.ok(keys.size > 100, `expected many locale lookups, found ${keys.size}`)

const missing = []
for (const key of keys) {
  // multi-line values put the string on the next line, so only match "key:"
  const hits = source.match(new RegExp(`^\\s{8}${key}:`, 'gm')) ?? []
  if (hits.length < 2) missing.push(`${key} (${hits.length} definition${hits.length === 1 ? '' : 's'})`)
}
assert.deepEqual(missing, [], `locale keys used by t() but missing in zh/en: ${missing.join(', ')}`)

console.log(`client guard: ${keys.size} locale keys, no window.confirm()`)
console.log('ALL CLIENT TESTS PASSED')
