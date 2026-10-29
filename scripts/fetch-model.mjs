#!/usr/bin/env node
/**
 * Fetch the local embedding model (BGE-small-zh-v1.5, int8 ONNX, ~24 MB).
 *
 * The model is deliberately not shipped in the npm tarball: it is a download,
 * not a source artifact. This script is the CLI half of `memory.model`; the
 * panel button (alpha.9) will call the same file list.
 *
 *   node scripts/fetch-model.mjs [--dir <modelsDir>] [--force]
 *
 * Mirrors are tried in order; each file is skipped when it already exists with
 * the right size and sha256, so re-running resumes an interrupted download.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = 'BAAI/bge-small-zh-v1.5'
const MIRRORS = ['https://hf-mirror.com', 'https://huggingface.co']
const FILES = [
  ['config.json', 716, 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f'],
  ['tokenizer.json', 439125, '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26'],
  ['tokenizer_config.json', 367, 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a'],
  ['special_tokens_map.json', 125, 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3'],
  ['vocab.txt', 109540, '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c'],
  ['onnx/model_quantized.onnx', 24010842, '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc'],
]

const argv = process.argv.slice(2)
const flag = name => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? '' : String(argv[at + 1] ?? '')
}
const force = argv.includes('--force')
const dir = flag('dir') || path.join(os.homedir(), '.dsh', 'agent-memory', 'models', 'bge-small-zh-v1.5')

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function ok(file, size, sha) {
  if (!fs.existsSync(file)) return false
  const stat = fs.statSync(file)
  if (stat.size !== size) return false
  return sha256(file) === sha
}

async function download(name, size, sha) {
  const target = path.join(dir, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (!force && ok(target, size, sha)) {
    console.log(`  ${name} — already present`)
    return
  }
  let lastError = null
  for (const mirror of MIRRORS) {
    const url = `${mirror}/${REPO}/resolve/main/${name}`
    try {
      const response = await fetch(url, { redirect: 'follow' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length !== size) throw new Error(`size ${bytes.length} != ${size}`)
      const got = crypto.createHash('sha256').update(bytes).digest('hex')
      if (got !== sha) throw new Error(`sha256 ${got.slice(0, 16)}… != ${sha.slice(0, 16)}…`)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(`${target}.part`, bytes)
      fs.renameSync(`${target}.part`, target)
      console.log(`  ${name} — ${(size / 1048576).toFixed(1)} MB from ${mirror}`)
      return
    } catch (error) {
      lastError = error
      console.log(`  ${name} — ${mirror} failed: ${String(error?.message ?? error)}`)
    }
  }
  throw new Error(`${name}: ${String(lastError?.message ?? lastError)}`)
}

console.log(`model ${REPO} → ${dir}`)
for (const [name, size, sha] of FILES) await download(name, size, sha)
console.log('done. `memory.model {action:"prepare"}` (or a plugin restart) builds the vectors.')
