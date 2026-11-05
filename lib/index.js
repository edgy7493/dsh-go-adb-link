// local-adb-link — find this phone's Shizuku/Stellar TCP ADB port and keep adb
// connected, so a DSH bash call can use `adb shell` without anyone typing a
// port again.
//
// The phone is reachable because a Shizuku-style manager (Stellar, a Shizuku
// fork) or `adb tcpip <port>` leaves adbd listening over TCP. This plugin:
//   1. probes the remembered port and the usual candidates with the ADB
//      handshake (lib/adb.js, pure Node, no adb binary needed to search);
//   2. falls back to a localhost port scan when a button asks for it;
//   3. runs `adb connect`, waits for the key authorization (the phone shows
//      "允许调试" once), and remembers the port in state.json;
//   4. reconnects on every engine start afterwards, and the shared adb server
//      on 127.0.0.1:5037 is then what bash's `adb` talks to.
import { findAdbPorts, probeAdb } from './adb.js'
import { adbConnect, adbDevices, adbDisconnect, installAdb, resolveAdb } from './cli.js'
import { loadState, saveState, statePath } from './state.js'

export const name = 'dsh-go-adb-link'

const KNOWN_PORTS = [3455, 5555]
const PORT_EXCLUDE = [3080, 5037]
const SCAN_START = 1
const SCAN_END = 65535
const SCAN_CONCURRENCY = 400
const SCAN_TIMEOUT_MS = 280
const AUTO_COOLDOWN_MS = 90_000
const AUTH_COOLDOWN_MS = 10 * 60_000
const SCAN_RETRY_MS = 10 * 60_000
const PANEL_POLL_MS = 6_000
const STRIP_POLL_MS = 12_000
const CONNECT_WAIT_MS = 45_000
const CONNECT_WAIT_PENDING_MS = 20_000

// ── copy ──────────────────────────────────────────────────────────────────

const DICT = {
  zh: {
    plugin: 'ADB 自动连接',
    status: {
      connected: '已连接',
      checking: '检查中',
      connecting: '连接中',
      scanning: '扫描端口',
      installing: '安装 adb',
      waiting: '等待授权',
      disconnected: '未连接',
      noadb: '缺 adb 客户端',
    },
    strip: {
      connected: (port) => `ADB 已连接 · ${port}`,
      checking: 'ADB 检查中…',
      connecting: 'ADB 连接中…',
      scanning: '正在扫描端口…',
      installing: '正在装 adb…',
      waiting: 'ADB 待授权 · 点按',
      disconnected: 'ADB 未连接 · 点按',
      noadb: '缺 adb 客户端 · 点按',
    },
    note: {
      connected: 'ADB 通道已就绪，本机可直接执行 adb 命令。',
      checking: '正在检查 adb 状态…',
      connecting: '正在连接手机上的 ADB 端口…',
      scanning: '正在扫描本机端口，寻找 ADB 服务…',
      installing: '本机缺少 adb 客户端，正在自动安装…',
      waiting: '请在手机上点“允许”，并勾选“始终允许这台计算机”。',
      disconnected: '点“连接”自动找到手机上的 ADB 端口并连上。',
      noadb: '本机没有 adb 客户端，点“连接”会自动安装。',
    },
    key: { status: '状态', port: '端口', device: '设备', adb: '客户端', auto: '自动重连' },
    btn: { connect: '连接', scan: '扫描端口', disconnect: '断开', copy: '复制命令' },
    hint: '首次连接：在手机上点“允许”并勾选“始终允许这台计算机”，之后每次启动自动重连。',
    on: '开',
    off: '关',
    none: '未找到',
    pending: { connect: '连接 ADB', scan: '扫描 ADB 端口' },
    toast: {
      connected: (port) => `ADB 已连接 · ${port}`,
      already: 'ADB 已经连着了',
      unauthorized: '请在手机上点“允许调试”',
      noPort: '没找到 ADB 端口，请确认 Stellar 的 TCP 已开',
      installFailed: '自动安装 adb 失败，请手动安装',
      noAdb: '本机没有 adb 客户端',
      timeout: '连接 ADB 超时，请重试',
      disconnected: '已断开 ADB，不会再自动重连',
      copied: '命令已复制',
      cancelled: '已取消',
    },
  },
  en: {
    plugin: 'ADB auto-link',
    status: {
      connected: 'Connected',
      checking: 'Checking',
      connecting: 'Connecting',
      scanning: 'Scanning',
      installing: 'Installing',
      waiting: 'Waiting',
      disconnected: 'Offline',
      noadb: 'No adb client',
    },
    strip: {
      connected: (port) => `ADB connected · ${port}`,
      checking: 'ADB checking…',
      connecting: 'ADB connecting…',
      scanning: 'Scanning ports…',
      installing: 'Installing adb…',
      waiting: 'ADB needs allow · tap',
      disconnected: 'ADB offline · tap',
      noadb: 'No adb client · tap',
    },
    note: {
      connected: 'The ADB channel is ready; this machine can run adb now.',
      checking: 'Checking the adb state…',
      connecting: 'Connecting to the phone ADB port…',
      scanning: 'Scanning localhost for an ADB service…',
      installing: 'The adb client is missing; installing it…',
      waiting: 'Tap “Allow” and tick “Always allow from this computer”.',
      disconnected: 'Tap “Connect” to find the phone ADB port and link it.',
      noadb: 'No adb client on this machine; “Connect” installs it.',
    },
    key: { status: 'State', port: 'Port', device: 'Device', adb: 'Client', auto: 'Reconnect' },
    btn: { connect: 'Connect', scan: 'Scan ports', disconnect: 'Disconnect', copy: 'Copy command' },
    hint: 'First time: tap “Allow” and tick “Always allow” on the phone; then it reconnects by itself.',
    on: 'on',
    off: 'off',
    none: 'not found',
    pending: { connect: 'Connecting ADB', scan: 'Scanning ADB ports' },
    toast: {
      connected: (port) => `ADB connected · ${port}`,
      already: 'ADB is already connected',
      unauthorized: 'Tap “Allow” in the dialog on the phone',
      noPort: 'No ADB port found; check Stellar TCP debugging',
      installFailed: 'Could not install adb; install it manually',
      noAdb: 'No adb client on this machine',
      timeout: 'ADB connect timed out; try again',
      disconnected: 'ADB disconnected; auto-reconnect is off',
      copied: 'Command copied',
      cancelled: 'Cancelled',
    },
  },
}

const dict = (locale) => (String(locale ?? '').toLowerCase().startsWith('en') ? DICT.en : DICT.zh)

// ── runtime state ─────────────────────────────────────────────────────────

/** `busy` is the in-progress step shown before the device list catches up. */
const rt = { busy: null, snapshot: null, lastKnown: null, snapshotAt: 0, inflight: null, lastAutoAt: 0, lastScanAt: 0 }
const listeners = new Set()

function bump() {
  for (const callback of [...listeners]) {
    try { callback() } catch {}
  }
}

function subscribeLive(callback) {
  listeners.add(callback)
  return () => { listeners.delete(callback) }
}

function invalidate() {
  rt.snapshot = null
  rt.snapshotAt = 0
}

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

const portOf = (serial) => {
  const match = /:(\d+)$/.exec(String(serial))
  const port = match ? Number(match[1]) : NaN
  return Number.isInteger(port) && port > 0 ? port : null
}

const isTcpSerial = (serial) => /:\d+$/.test(serial) && !String(serial).startsWith('emulator-')

function pickDevice(devices, port) {
  const tcp = devices.filter((device) => isTcpSerial(device.serial))
  if (port) {
    const exact = tcp.find((device) => portOf(device.serial) === port)
    if (exact) return exact
  }
  return tcp.find((device) => device.state === 'device')
    ?? tcp.find((device) => device.state === 'unauthorized' || device.state === 'authorizing')
    ?? null
}

function clockOf(ms) {
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * One read of "what does adb look like right now". Cached briefly so the strip
 * and the panel polling do not each spawn a client.
 */
async function snapshot({ ttl = 1500 } = {}) {
  const now = Date.now()
  if (rt.snapshot !== null && now - rt.snapshotAt < ttl) return rt.snapshot
  const stored = loadState()
  const adb = resolveAdb()
  const out = {
    kind: 'disconnected',
    adb,
    port: stored.port,
    serial: null,
    device: '',
    at: now,
    auto: stored.auto !== false,
    authorized: stored.authorized === true,
    busy: rt.busy,
  }
  try {
    const devices = adb ? await adbDevices(adb) : []
    const mine = pickDevice(devices, stored.port)
    if (mine && mine.state === 'device') {
      out.kind = 'connected'
      out.serial = mine.serial
      out.port = portOf(mine.serial) ?? stored.port
      out.device = [mine.model, mine.device].filter(Boolean).join(' · ') || mine.serial
    } else if (mine && (mine.state === 'unauthorized' || mine.state === 'authorizing')) {
      out.kind = 'waiting-auth'
      out.serial = mine.serial
      out.port = portOf(mine.serial) ?? stored.port
    } else if (!adb) {
      out.kind = rt.busy ?? 'no-adb'
    } else {
      out.kind = rt.busy ?? 'disconnected'
    }
  } catch {
    if (!adb) out.kind = 'no-adb'
  }
  rt.snapshot = out
  rt.lastKnown = out
  rt.snapshotAt = now
  return out
}

// ── connecting ────────────────────────────────────────────────────────────

async function discoverPort(stored, { scan, signal }) {
  const candidates = [...new Set([stored.port, ...KNOWN_PORTS].filter((port) => Number.isInteger(port)))]
  for (const port of candidates) {
    if (signal?.aborted) return null
    if (await probeAdb(port, { timeoutMs: 700 })) return port
  }
  if (!scan) return null
  rt.busy = 'scanning'
  bump()
  invalidate()
  const found = await findAdbPorts({
    candidatePorts: candidates,
    start: SCAN_START,
    end: SCAN_END,
    concurrency: SCAN_CONCURRENCY,
    timeoutMs: SCAN_TIMEOUT_MS,
    exclude: PORT_EXCLUDE,
    signal,
  })
  return found[0] ?? null
}

/**
 * Ensure adb exists, find the phone's adbd if it does, connect, and wait for
 * the key to be authorized. Resolves to a plain result, never throws.
 */
async function doConnect({ scan = true, install = true, waitMs = CONNECT_WAIT_MS, signal } = {}) {
  let adb = resolveAdb()
  if (!adb && install) {
    rt.busy = 'installing'
    bump()
    invalidate()
    const installed = await installAdb({ signal })
    adb = resolveAdb()
    if (!adb) return { ok: false, reason: 'install-failed', detail: installed.detail }
  }
  if (!adb) return { ok: false, reason: 'no-adb' }

  const before = await snapshot({ ttl: 0 })
  if (before.kind === 'connected') {
    saveState({ port: before.port, authorized: true, lastAt: Date.now(), authWaitUntil: 0, lastError: '' })
    return { ok: true, already: true, port: before.port, device: before.device }
  }

  const stored = loadState()
  const port = await discoverPort(stored, { scan, signal })
  if (port === null) return { ok: false, reason: 'no-port' }

  rt.busy = 'connecting'
  bump()
  invalidate()
  const connected = await adbConnect(port, { signal })

  const deadline = Date.now() + waitMs
  let sawUnauthorized = false
  while (Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, reason: 'cancelled' }
    const devices = await adbDevices(adb)
    const mine = pickDevice(devices, port)
    if (mine && mine.state === 'device') {
      saveState({ port, authorized: true, auto: true, lastAt: Date.now(), authWaitUntil: 0, lastError: '' })
      invalidate()
      return {
        ok: true,
        port,
        device: [mine.model, mine.device].filter(Boolean).join(' · ') || mine.serial,
      }
    }
    if (mine && (mine.state === 'unauthorized' || mine.state === 'authorizing')) {
      sawUnauthorized = true
      if (rt.busy !== 'waiting-auth') {
        rt.busy = 'waiting-auth'
        bump()
        invalidate()
      }
    }
    await sleep(1200)
  }

  if (sawUnauthorized) {
    saveState({ port, authorized: false, lastAt: Date.now(), authWaitUntil: Date.now() + AUTH_COOLDOWN_MS, lastError: 'unauthorized' })
    return { ok: false, reason: 'unauthorized', port }
  }
  saveState({ lastAt: Date.now(), lastError: connected.ok ? 'no-device' : 'connect-failed' })
  return { ok: false, reason: 'timeout', port, detail: connected.detail }
}

/** Run one connect at a time; concurrent callers share the same attempt. */
function connectOnce(options) {
  if (rt.inflight) return rt.inflight
  rt.inflight = doConnect(options)
    .catch((error) => ({ ok: false, reason: 'error', detail: String(error?.message ?? error) }))
    .finally(() => {
      rt.inflight = null
      rt.busy = null
      invalidate()
      bump()
    })
  return rt.inflight
}

/** Record a live connection found by polling, so the next start reconnects. */
function remember(snap) {
  if (snap.kind !== 'connected' || !snap.port) return
  const stored = loadState()
  if (stored.port === snap.port && stored.authorized === true) return
  saveState({ port: snap.port, authorized: true, authWaitUntil: 0, lastError: '' })
  invalidate()
}

/** Reconnect silently after an engine start, or when a feed mounts. */
function maybeAutoConnect() {
  const now = Date.now()
  if (now - rt.lastAutoAt < AUTO_COOLDOWN_MS) return
  rt.lastAutoAt = now
  const stored = loadState()
  if (stored.auto === false) return
  if (now < stored.authWaitUntil) return
  if (rt.inflight) return
  if (!resolveAdb()) return
  connectOnce({ scan: false, install: false, waitMs: 6_000 }).then((result) => {
    // The saved port is gone but the phone was paired before: the port may have
    // moved (reboot / Stellar restart). Look for it again, at most every 10 min.
    if (result?.ok || result?.reason !== 'no-port') return
    if (loadState().authorized !== true) return
    if (Date.now() - rt.lastScanAt < SCAN_RETRY_MS) return
    rt.lastScanAt = Date.now()
    connectOnce({ scan: true, install: false, waitMs: 6_000 }).catch(() => {})
  }).catch(() => {})
}

// ── effects ───────────────────────────────────────────────────────────────

function patchFor(result, locale) {
  const d = dict(locale)
  if (result.ok) {
    return {
      note: d.note.connected,
      tone: 'good',
      status: d.status.connected,
      port: String(result.port ?? '—'),
      device: result.device || '—',
      adb: resolveAdb() || d.none,
      auto: d.on,
      checked: clockOf(Date.now()),
    }
  }
  const reason = result.reason
  const patch = { checked: clockOf(Date.now()) }
  if (reason === 'unauthorized') {
    Object.assign(patch, { note: d.note.waiting, tone: 'warn', status: d.status.waiting, port: String(result.port ?? '—') })
  } else if (reason === 'no-port') {
    Object.assign(patch, { note: d.note.disconnected, tone: 'muted', status: d.status.disconnected })
  } else if (reason === 'no-adb' || reason === 'install-failed') {
    Object.assign(patch, { note: d.note.noadb, tone: 'bad', status: d.status.noadb, adb: d.none })
  } else {
    Object.assign(patch, { note: d.note.disconnected, tone: 'muted', status: d.status.disconnected })
  }
  return patch
}

function toastFor(result, locale) {
  const t = dict(locale).toast
  switch (result.reason) {
    case 'unauthorized': return t.unauthorized
    case 'no-port': return t.noPort
    case 'no-adb': return t.noAdb
    case 'install-failed': return t.installFailed
    case 'cancelled': return t.cancelled
    default: return t.timeout
  }
}

function connectHandler(scope, event) {
  const d = dict(event?.locale)
  return {
    pending: { label: d.pending.connect, timeoutMs: 58_000 },
    result: async (signal) => {
      const result = await connectOnce({ scan: true, install: true, waitMs: CONNECT_WAIT_PENDING_MS, signal })
      if (result.ok) {
        return { toast: result.already ? d.toast.already : d.toast.connected(result.port), patch: patchFor(result, event?.locale) }
      }
      return { toast: toastFor(result, event?.locale), patch: patchFor(result, event?.locale) }
    },
  }
}

function scanHandler(scope, event) {
  const d = dict(event?.locale)
  return {
    pending: { label: d.pending.scan, timeoutMs: 58_000 },
    result: async (signal) => {
      try {
        const stored = loadState()
        rt.busy = 'scanning'
        bump()
        invalidate()
        const found = await findAdbPorts({
          candidatePorts: [stored.port, ...KNOWN_PORTS].filter(Boolean),
          start: SCAN_START,
          end: SCAN_END,
          concurrency: SCAN_CONCURRENCY,
          timeoutMs: SCAN_TIMEOUT_MS,
          exclude: PORT_EXCLUDE,
          signal,
        })
        if (found.length === 0) {
          rt.busy = null
          invalidate()
          return { toast: d.toast.noPort, patch: patchFor({ ok: false, reason: 'no-port' }, event?.locale) }
        }
        saveState({ port: found[0] })
        const result = await connectOnce({ scan: false, install: false, waitMs: 15_000, signal })
        if (result.ok) return { toast: d.toast.connected(result.port), patch: patchFor(result, event?.locale) }
        return { toast: toastFor(result, event?.locale), patch: patchFor(result, event?.locale) }
      } finally {
        rt.busy = null
        invalidate()
        bump()
      }
    },
  }
}

async function disconnectHandler(scope, event) {
  const d = dict(event?.locale)
  const stored = loadState()
  await adbDisconnect(stored.port, { timeoutMs: 2_400 })
  saveState({ auto: false, authWaitUntil: 0, lastError: '' })
  invalidate()
  const snap = await snapshot({ ttl: 0 })
  return {
    toast: d.toast.disconnected,
    patch: {
      note: d.note.disconnected,
      tone: 'muted',
      status: d.status.disconnected,
      auto: d.off,
      port: snap.port ? String(snap.port) : '—',
      checked: clockOf(Date.now()),
    },
  }
}

function copyHandler(scope, event) {
  const d = dict(event?.locale)
  const port = loadState().port ?? KNOWN_PORTS[0]
  return {
    copy: `export HOME=/root; adb connect 127.0.0.1:${port}\n`,
    toast: d.toast.copied,
  }
}

// ── views ─────────────────────────────────────────────────────────────────

function stripTextFor(snap, locale) {
  const s = dict(locale).strip
  switch (snap.kind) {
    case 'connected': return s.connected(snap.port ?? '')
    case 'waiting-auth': return s.waiting
    case 'connecting': return s.connecting
    case 'scanning': return s.scanning
    case 'installing': return s.installing
    case 'no-adb': return s.noadb
    default: return s.disconnected
  }
}

function stripToneFor(snap) {
  switch (snap.kind) {
    case 'connected': return 'good'
    case 'waiting-auth': return 'warn'
    case 'no-adb': return 'bad'
    case 'connecting':
    case 'scanning':
    case 'installing':
    case 'checking': return 'info'
    default: return 'muted'
  }
}

function stripDataFor(snap, locale) {
  return { text: stripTextFor(snap, locale), icon: 'terminal', tone: stripToneFor(snap) }
}

function statusTextFor(snap, locale) {
  const st = dict(locale).status
  switch (snap.kind) {
    case 'connected': return st.connected
    case 'waiting-auth': return st.waiting
    case 'connecting': return st.connecting
    case 'scanning': return st.scanning
    case 'installing': return st.installing
    case 'no-adb': return st.noadb
    case 'checking': return st.checking
    default: return st.disconnected
  }
}

function noteFor(snap, locale) {
  const note = dict(locale).note
  switch (snap.kind) {
    case 'connected': return note.connected
    case 'waiting-auth': return note.waiting
    case 'connecting': return note.connecting
    case 'scanning': return note.scanning
    case 'installing': return note.installing
    case 'no-adb': return note.noadb
    case 'checking': return note.checking
    default: return note.disconnected
  }
}

function panelDataFor(snap, locale) {
  const d = dict(locale)
  return {
    note: noteFor(snap, locale),
    tone: stripToneFor(snap),
    status: statusTextFor(snap, locale),
    port: snap.port ? String(snap.port) : '—',
    device: snap.device || '—',
    adb: snap.adb || d.none,
    auto: snap.auto ? d.on : d.off,
    checked: snap.at ? clockOf(snap.at) : '—',
  }
}

function buildView(locale) {
  const d = dict(locale)
  return {
    type: 'stack',
    children: [
      { type: 'callout', text: { $: 'data.note' }, tone: { $: 'data.tone' } },
      {
        type: 'keyValue',
        items: [
          [d.key.status, { $: 'data.status' }],
          [d.key.port, { $: 'data.port' }],
          [d.key.device, { $: 'data.device' }],
          [d.key.adb, { $: 'data.adb' }],
          [d.key.auto, { $: 'data.auto' }],
        ],
      },
      {
        type: 'actions',
        items: [
          { label: d.btn.connect, action: 'connect', icon: 'refresh', style: 'primary' },
          { label: d.btn.scan, action: 'scan', icon: 'search' },
          { label: d.btn.disconnect, action: 'disconnect', icon: 'link' },
          { label: d.btn.copy, action: 'copy', icon: 'copy' },
        ],
      },
      { type: 'text', text: d.hint, tone: 'muted' },
    ],
  }
}

// ── prompt injection ───────────────────────────────────────────────────────

/**
 * System-prompt section the harness shows while this plugin is loaded. It is
 * what makes the channel *proactive*: once adb is connected, the agent is told
 * which jobs are worth doing through adb instead of detouring.
 */
function adbPromptText() {
  const snap = rt.lastKnown ?? rt.snapshot
  const connected = snap !== null && snap.kind === 'connected'
  const where = connected && snap.port ? `（127.0.0.1:${snap.port}）` : ''
  const head = connected
    ? `本机是 DSH Go 手机，ADB 通道已由「ADB 自动连接」插件连好${where}，bash 里可直接运行 adb 命令。`
    : '本机是 DSH Go 手机，装有「ADB 自动连接」插件（后台保持 adb 通道）；需要系统级操作时先用 adb devices 确认，不通再让用户到插件面板点「连接」。'
  return [
    head,
    '当任务需要普通 bash 或手机操控做不到、或明显更费劲的系统级操作时，主动使用 adb，不要先问用户要不要用 adb：',
    'appops/运行时权限、安装卸载 APK、读取 /data 或受保护数据、截图录屏、模拟点击和输入、查询进程/电量/网络/温度、改系统设置、uiautomator dump。',
    '登录、支付、验证码、删除等敏感操作仍按原有规则先向用户确认。',
  ].join('\n')
}

// ── plugin ────────────────────────────────────────────────────────────────

export function apply(ctx) {
  // Not dsh-go-specific: any harness host that mounts systemPrompt gets the
  // guidance; without the bridge the plugin simply has no native surfaces.
  ctx.inject(['systemPrompt'], (scope) => {
    const bashOrder = scope.systemPrompt.getSectionOrder('TOOL_BASH')
    scope.systemPrompt.section({
      name: 'adb-link:prompt',
      order: Number.isFinite(bashOrder) ? bashOrder + 5 : 1005,
      interpolate: false,
      text: () => adbPromptText(),
    })
  })

  ctx.inject(['dshGo'], (ctx) => {
    const startData = (emit, caps, isPanel) => {
      const locale = caps?.locale ?? ''
      let alive = true
      const push = async () => {
        try {
          const snap = await snapshot()
          if (!alive) return
          remember(snap)
          if (snap.kind === 'disconnected') maybeAutoConnect()
          emit(isPanel ? panelDataFor(snap, locale) : stripDataFor(snap, locale))
        } catch {
          if (!alive) return
          emit(isPanel
            ? { note: dict(locale).note.disconnected, tone: 'muted', status: dict(locale).status.disconnected, port: '—', device: '—', adb: '—', auto: '—', checked: '—' }
            : { text: dict(locale).strip.disconnected, icon: 'terminal', tone: 'muted' })
        }
      }
      if (isPanel) {
        emit({
          note: dict(locale).note.checking,
          tone: 'info',
          status: dict(locale).status.checking,
          port: loadState().port ? String(loadState().port) : '—',
          device: '—',
          adb: resolveAdb() || dict(locale).none,
          auto: loadState().auto === false ? dict(locale).off : dict(locale).on,
          checked: clockOf(Date.now()),
        })
      }
      push()
      const timer = setInterval(push, isPanel ? PANEL_POLL_MS : STRIP_POLL_MS)
      timer.unref?.()
      const off = subscribeLive(push)
      maybeAutoConnect()
      return () => {
        alive = false
        clearInterval(timer)
        off()
      }
    }

    // Try to restore the link as soon as the engine starts, before anyone looks.
    maybeAutoConnect()

    // Status line above the composer; tapping it opens the panel.
    ctx.dshGo.strip('adb-state', (scope, emit, caps) => startData(emit, caps, false))

    ctx.dshGo.panel('adb', {
      view: (scope, caps) => buildView(caps?.locale),
      data: (scope, emit, caps) => startData(emit, caps, true),
      actions: {
        connect: connectHandler,
        scan: scanHandler,
        disconnect: disconnectHandler,
        copy: copyHandler,
      },
    })
  })
}

/** Exposed for the local test harness only. */
export const __test = { snapshot, connectOnce, discoverPort, statePath, buildView, panelDataFor, stripDataFor, adbPromptText }
