// Pure-Node ADB discovery.
//
// The phone exposes adbd over TCP when a Shizuku-style manager (Stellar) or
// `adb tcpip <port>` turns TCP debugging on. Finding that port does not need an
// adb binary: opening the ADB handshake (CNXN) on a port answers with
// CNXN (already paired) or AUTH (wants a key) on a real adbd, and nothing on any
// other service.
import net from 'node:net'
import zlib from 'node:zlib'

const CNXN = 0x4e584e43
const AUTH = 0x48545541
const VERSION = 0x01000000 // protocol version 1.0.0
const MAX_PAYLOAD = 256 * 1024

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function cnxnPacket() {
  const payload = Buffer.from('host::\0', 'latin1')
  const head = Buffer.alloc(24)
  head.writeUInt32LE(CNXN, 0)
  head.writeUInt32LE(VERSION, 4)
  head.writeUInt32LE(MAX_PAYLOAD, 8)
  head.writeUInt32LE(payload.length, 12)
  head.writeUInt32LE(crc32(payload), 16)
  head.writeUInt32LE((CNXN ^ 0xffffffff) >>> 0, 20)
  return Buffer.concat([head, payload])
}

/**
 * True when `port` on `host` answers the ADB handshake.
 * Anything that is not adbd (HTTP servers, TLS endpoints, adb's own server
 * socket) simply closes the connection or times out, so a probe is cheap.
 */
export function probeAdb(port, { host = '127.0.0.1', timeoutMs = 450 } = {}) {
  return new Promise((resolve) => {
    let settled = false
    let socket
    const done = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket?.destroy() } catch {}
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    timer.unref?.()
    try {
      socket = net.connect({ host, port })
    } catch {
      done(false)
      return
    }
    socket.unref?.()
    socket.setNoDelay?.(true)
    socket.once('connect', () => {
      // TCP self-connect: when the kernel picks the destination port itself as
      // the source port (common while scanning the ephemeral range), the socket
      // talks to itself and echoes our own packet back. Not an adbd.
      if (socket.localPort === port) return done(false)
      try { socket.write(cnxnPacket()) } catch { done(false) }
    })
    socket.once('data', (chunk) => {
      if (chunk.length < 4) return
      const cmd = chunk.readUInt32LE(0)
      // A real adbd answers AUTH, or CNXN with a "device::" banner. Our own
      // CNXN carries "host::"; a reply with that is the self-connect echo.
      if (cmd === CNXN) {
        const banner = chunk.length >= 30 ? chunk.subarray(24, 30).toString('latin1') : ''
        return done(banner !== 'host::')
      }
      done(cmd === AUTH)
    })
    socket.once('error', () => done(false))
    socket.once('close', () => done(false))
  })
}

/**
 * Probe `candidatePorts` first, then scan `[start, end]` until an adbd answers.
 * Resolves to the ports found (usually exactly one). `signal` aborts cleanly.
 */
export async function findAdbPorts({
  candidatePorts = [],
  start = 1,
  end = 65535,
  concurrency = 400,
  timeoutMs = 280,
  exclude = [],
  signal,
} = {}) {
  const blocked = new Set(exclude)
  const candidates = [...new Set(candidatePorts)].filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535 && !blocked.has(p))
  for (const port of candidates) {
    if (signal?.aborted) return []
    if (await probeAdb(port, { timeoutMs: Math.max(600, timeoutMs * 2) })) return [port]
  }

  const found = []
  let next = Math.max(1, start)
  const stop = () => signal?.aborted === true || found.length > 0
  const worker = async () => {
    while (!stop()) {
      const port = next++
      if (port > end) return
      if (blocked.has(port)) continue
      if (await probeAdb(port, { timeoutMs })) found.push(port)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(800, concurrency)) }, worker))
  return found.sort((a, b) => a - b)
}
