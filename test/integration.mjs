// Local integration test for dsh-go-adb-link, using the dsh-go plugin kit's test
// host (the same fake bridge `check --load` uses). It talks to the real adb on
// this machine, so run it on a phone whose ADB channel is already authorized.
//
//   node test/integration.mjs
//
// The kit path can be overridden with DSH_GO_PLUGIN_KIT.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const home = process.env.DSH_HOME || path.join(process.env.HOME || '/root', '.dsh')
const kit = process.env.DSH_GO_PLUGIN_KIT
  || path.join(home, 'skills', 'dsh-go-plugin', 'kit', 'lib', 'testing.js')
if (!fs.existsSync(kit)) {
  console.error(`找不到 dsh-go 插件工具包：${kit}`)
  console.error('先安装 DSH Go（或其 dsh-go-plugin 技能），或用 DSH_GO_PLUGIN_KIT 指定 testing.js')
  process.exit(2)
}
const { createTestHost } = await import(pathToFileURL(kit).href)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const keepalive = setInterval(() => {}, 1000)

const host = createTestHost({ dir })
const mod = await import(path.join(dir, 'lib', 'index.js'))
mod.apply(host.ctx)

let failures = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures++
}

// 1. strip: auto-connect should make it green.
const strip = host.subscribe('adb-state', { sessionId: 'test-session' })
await wait(3000)
check(strip.data?.text?.startsWith('ADB'), 'strip text', JSON.stringify(strip.data))
check(/已连接|待授权|未连接/.test(strip.data?.text ?? ''), 'strip text is a known state')
strip.stop()

// 2. panel data + view.
const panel = host.subscribe('adb', { sessionId: 'test-session' })
await wait(2000)
check(typeof panel.data?.status === 'string', 'panel data status', JSON.stringify(panel.data))
const view = await host.view('adb', { sessionId: 'test-session' })
check(view.stats.bytes > 0 && view.stats.nodes > 3, 'panel view renders', `${view.stats.bytes} bytes / ${view.stats.nodes} nodes`)

// 3. connect action: pending, then a toast + patch.
const call = await host.invoke('adb', { action: 'connect', scope: { sessionId: 'test-session' } })
check(call.pending !== undefined, 'connect returns a pending result', JSON.stringify(call.pending))
if (call.pending) {
  const settled = await call.settled
  const toast = settled.effects?.find((effect) => effect.type === 'toast')
  const patch = settled.effects?.find((effect) => effect.type === 'patch')
  check(toast !== undefined, 'connect settles with a toast', JSON.stringify(toast))
  check(patch !== undefined, 'connect settles with a patch', JSON.stringify(patch))
  if (patch) check(patch.data.tone === 'good' || patch.data.status !== undefined, 'patch carries state fields')
}

// 4. copy action.
const copied = await host.invoke('adb', { action: 'copy', scope: { sessionId: 'test-session' } })
check(copied.effects.some((effect) => effect.type === 'copy'), 'copy action copies the command', JSON.stringify(copied.effects))

// 5. disconnect action, then connect again (leave the machine connected).
const off = await host.invoke('adb', { action: 'disconnect', scope: { sessionId: 'test-session' } })
check(off.effects.some((effect) => effect.type === 'toast'), 'disconnect action returns a toast', JSON.stringify(off.effects))
const again = await host.invoke('adb', { action: 'connect', scope: { sessionId: 'test-session' } })
if (again.pending) {
  const settled = await again.settled
  check(settled.t === 'done', 'reconnect after disconnect', JSON.stringify(settled.effects?.map((e) => e.type)))
}
panel.stop()
host.dispose?.()
clearInterval(keepalive)
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
