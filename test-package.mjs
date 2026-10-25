/**
 * Packaging guard: every runtime module on the import chain must be listed in
 * package.json "files".
 *
 * The npm tarball for 1.2.0 and 1.3.0 omitted archive.js while index.js imports
 * it, so the installed plugin failed with ERR_MODULE_NOT_FOUND and DSH marked
 * it as a failed startup. Source tests could not see that because they import
 * the working tree, where every file exists.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'))

/** npm "files" entries are globs; `*` never crosses a path separator. */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
  return new RegExp(`^${escaped}$`)
}

const patterns = (manifest.files ?? []).map(globToRegExp)
const listed = relative => patterns.some(pattern => pattern.test(relative))

// Package entry points that Node or DSH loads directly.
const entries = new Set()
for (const value of Object.values(manifest.exports ?? {})) {
  if (typeof value === 'string' && value.endsWith('.js')) entries.add(value.replace(/^\.\//, ''))
}
if (entries.size === 0) entries.add('index.js')

// Follow relative imports from every entry; each resolved file must ship.
const seen = new Set()
const queue = [...entries]
while (queue.length > 0) {
  const relative = queue.shift()
  if (seen.has(relative)) continue
  seen.add(relative)
  assert.ok(fs.existsSync(path.join(here, relative)), `runtime file is missing from the repository: ${relative}`)
  assert.ok(listed(relative), `package.json "files" does not ship runtime file: ${relative}`)
  const text = fs.readFileSync(path.join(here, relative), 'utf8')
  for (const match of text.matchAll(/from\s+'(\.{1,2}\/[^']+)'|import\s+'(\.{1,2}\/[^']+)'/g)) {
    const specifier = match[1] ?? match[2]
    queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier)))
  }
}

// Assets and plugin metadata DSH reads without importing them.
for (const relative of ['cordis.patch.yml', 'icon.svg', 'archive.js']) {
  assert.ok(fs.existsSync(path.join(here, relative)), `package asset is missing: ${relative}`)
  assert.ok(listed(relative), `package.json "files" does not ship package asset: ${relative}`)
}

console.log(`import chain shipped: ${[...seen].sort().join(', ')}`)
console.log('ALL PACKAGE TESTS PASSED')
