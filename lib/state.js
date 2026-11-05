// What the plugin remembers between engine restarts: the port that worked and
// whether the user already authorized the adb key on the phone. Keeping it
// under DSH_HOME (not inside the package) means publishing and reinstalling
// the plugin never ships runtime data, and the memory survives both engine
// resets and plugin upgrades.
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.DSH_HOME?.trim() || path.join(process.env.HOME || '/root', '.dsh')
const FILE = path.join(HOME, 'dsh-go', 'adb-link', 'state.json')

const DEFAULTS = Object.freeze({
  v: 1,
  port: null,
  authorized: false,
  auto: true,
  lastAt: 0,
  authWaitUntil: 0,
  lastError: '',
})

let current = null

function clean(value) {
  const out = { ...DEFAULTS }
  if (value === null || typeof value !== 'object') return out
  if (Number.isInteger(value.port) && value.port > 0 && value.port < 65536) out.port = value.port
  if (typeof value.authorized === 'boolean') out.authorized = value.authorized
  if (typeof value.auto === 'boolean') out.auto = value.auto
  if (Number.isFinite(value.lastAt)) out.lastAt = value.lastAt
  if (Number.isFinite(value.authWaitUntil)) out.authWaitUntil = value.authWaitUntil
  if (typeof value.lastError === 'string') out.lastError = value.lastError.slice(0, 200)
  return out
}

/** The persisted state (cached in memory). */
export function loadState() {
  if (current) return current
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch {
    raw = null
  }
  current = clean(raw)
  return current
}

/** Merge `patch` into the persisted state and write it back (best effort). */
export function saveState(patch = {}) {
  const next = { ...loadState(), ...patch, v: 1 }
  current = clean(next)
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    const tmp = `${FILE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, FILE)
  } catch {
    try { fs.rmSync(`${FILE}.${process.pid}.tmp`, { force: true }) } catch {}
  }
  return current
}

export const statePath = FILE
