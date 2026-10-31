/**
 * Open a known directory in the operating system's file manager.
 *
 * The panel runs inside the Web GUI, so it cannot touch the filesystem itself.
 * All it can do is ask the host: `fs.reveal` carries a *target name*, never a
 * path, and this module is the only place that turns a target into one. That
 * keeps the JSON surface from becoming an "open anything" button.
 */
import { spawn } from 'node:child_process'

/** Targets the panel may ask for; the value is where it resolves. */
export const REVEAL_TARGETS = ['root', 'knowledge', 'plugin']

/**
 * @param {object} [options]
 * @param {string} [options.platform] `process.platform` in production.
 * @param {Function} [options.run] spawn-like function, injected by tests.
 */
export function createReveal({ platform = process.platform, run = spawn } = {}) {
  return function reveal(dir) {
    if (typeof dir !== 'string' || dir === '') return false
    const [command, args] =
      platform === 'win32'
        ? ['explorer.exe', [dir]]
        : platform === 'darwin'
          ? ['open', [dir]]
          : ['xdg-open', [dir]]
    try {
      // explorer.exe exits non-zero even on success, so never wait for it.
      const child = run(command, args, { detached: true, stdio: 'ignore' })
      child.on?.('error', () => {})
      child.unref?.()
      return true
    } catch {
      return false
    }
  }
}
