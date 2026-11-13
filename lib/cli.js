// Calling the adb client that lives on this Ubuntu rootfs.
//
// The client is a normal program: any `adb` in PATH works, and when an app
// runtime upgrade removed it the plugin can put it back with apt (see
// installAdb). Every command shares the adb server on 127.0.0.1:5037 with the
// rest of the machine, so once the plugin connected, plain `adb shell` in a
// DSH bash call works too.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const CANDIDATES = [
  '/usr/bin/adb',
  '/usr/local/bin/adb',
  '/usr/lib/android-sdk/platform-tools/adb',
  '/opt/android-sdk/platform-tools/adb',
  '/root/bin/adb',
  '/sdcard/Android/data/io.github.ccch1mneyyy.dsh_app/files/adb',
]

let cached = { at: 0, path: null }

function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findOnPath(name) {
  for (const dir of String(process.env.PATH ?? '').split(':').filter(Boolean)) {
    const file = path.join(dir, name)
    if (executable(file)) return file
  }
  return null
}

/** Absolute path to a usable adb client, or null. Cached for 10 s. */
export function resolveAdb() {
  const now = Date.now()
  if (now - cached.at < 10_000) return cached.path
  let found = null
  for (const file of [process.env.ADB_PATH, process.env.ADB].filter(Boolean)) {
    if (executable(String(file))) {
      found = String(file)
      break
    }
  }
  if (!found) for (const file of CANDIDATES) if (executable(file)) { found = file; break }
  if (!found) found = findOnPath('adb')
  cached = { at: now, path: found }
  return found
}

/** Forget the cached lookup (after installing or removing the client). */
export function resetAdbCache() {
  cached = { at: 0, path: null }
}

/** Run a program, collect stdout/stderr, never throw for a non-zero exit. */
export function run(file, args, { timeoutMs = 15_000, signal, env } = {}) {
  return new Promise((resolve) => {
    let child
    let timer
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve(result)
    }
    const onAbort = () => { try { child?.kill('SIGKILL') } catch {} }
    try {
      child = spawn(file, args, {
        env: { ...process.env, HOME: process.env.HOME || '/root', ...(env ?? {}) },
        cwd: '/root',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.once('error', (error) => finish({ code: null, stdout, stderr, error }))
    child.once('close', (code, killedBy) => finish({ code, stdout, stderr, killed: killedBy ?? null }))
    timer = setTimeout(() => { onAbort() }, timeoutMs)
    timer.unref?.()
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener?.('abort', onAbort, { once: true })
    }
  })
}

/** `adb devices -l` parsed into [{ serial, state, model?, device? }]. */
export function parseDevices(text) {
  const out = []
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('List of devices') || line.startsWith('*')) continue
    const parts = line.split(/\s+/)
    const serial = parts[0]
    const state = parts[1]
    if (!serial || !state) continue
    const extra = {}
    for (const pair of parts.slice(2)) {
      const at = pair.indexOf(':')
      if (at > 0) extra[pair.slice(0, at)] = pair.slice(at + 1)
    }
    out.push({ serial, state, ...extra })
  }
  return out
}

/** Devices the adb server currently knows about (empty when no client or no server). */
export async function adbDevices(adbPath = resolveAdb(), options = {}) {
  if (!adbPath) return []
  const result = await run(adbPath, ['devices', '-l'], { timeoutMs: 10_000, ...options })
  if (result.error || (typeof result.code === 'number' && result.code !== 0 && result.stdout === '')) return []
  return parseDevices(result.stdout)
}

/** `adb connect 127.0.0.1:<port>`; returns { ok, detail }. */
export async function adbConnect(port, options = {}) {
  const adbPath = resolveAdb()
  if (!adbPath) return { ok: false, detail: 'no-adb' }
  const address = `127.0.0.1:${port}`
  const result = await run(adbPath, ['connect', address], { timeoutMs: 12_000, ...options })
  const text = `${result.stdout}\n${result.stderr}`.trim()
  return { ok: !result.error && text.toLowerCase().includes('connected'), detail: text }
}

/** `adb disconnect` for the endpoint and for bare 127.0.0.1; best effort. */
export async function adbDisconnect(port, options = {}) {
  const adbPath = resolveAdb()
  if (!adbPath) return { ok: false }
  const args = port ? ['disconnect', `127.0.0.1:${port}`] : ['disconnect']
  const result = await run(adbPath, args, { timeoutMs: 8_000, ...options })
  return { ok: !result.error, detail: `${result.stdout}`.trim() }
}

export async function adbStartServer(options = {}) {
  const adbPath = resolveAdb()
  if (!adbPath) return { ok: false, detail: 'no-adb' }
  const result = await run(adbPath, ['start-server'], { timeoutMs: 15_000, ...options })
  return { ok: !result.error && result.code === 0, detail: `${result.stderr}`.trim() }
}

/**
 * Put the distro's adb client back with apt when a runtime upgrade removed it.
 * Returns { ok, detail, path }.
 */
export async function installAdb({ signal, timeoutMs = 55_000 } = {}) {
  const apt = ['/usr/bin/apt-get', '/bin/apt-get'].find(executable) ?? findOnPath('apt-get')
  if (!apt) return { ok: false, detail: 'no-apt' }
  const result = await run(apt, ['install', '-y', '-qq', 'adb'], {
    timeoutMs,
    signal,
    env: { DEBIAN_FRONTEND: 'noninteractive' },
  })
  resetAdbCache()
  const path = resolveAdb()
  const tail = `${result.stderr}\n${result.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' | ')
  return { ok: path !== null, path, detail: tail.slice(0, 400) }
}

/**
 * Ports the phone itself is LISTENing on as uid 2000 (shell) — that is what adbd
 * uses, for both `adb tcpip <port>` and Android 11+ wireless debugging. Reading
 * /proc/net/tcp* through an existing channel gives the exact answer in ~60 ms,
 * which beats scanning 65k ports (~20 s) by two orders of magnitude.
 */
export async function shellListenPorts(serial, options = {}) {
  const adbPath = resolveAdb()
  if (!adbPath || !serial) return []
  const result = await run(
    adbPath,
    ['-s', serial, 'shell', 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null'],
    { timeoutMs: 6_000, ...options },
  )
  if (!result.stdout) return []
  const ports = new Set()
  for (const line of String(result.stdout).split('\n')) {
    const parts = line.trim().split(/\s+/)
    // sl local_address rem_address st ... uid ...
    if (parts.length < 8) continue
    if (parts[3] !== '0A') continue // TCP_LISTEN
    if (parts[7] !== '2000') continue // uid shell = adbd
    const at = parts[1].lastIndexOf(':')
    if (at < 0) continue
    const port = Number.parseInt(parts[1].slice(at + 1), 16)
    if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port)
  }
  return [...ports].sort((a, b) => a - b)
}
