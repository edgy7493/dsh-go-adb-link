// Checks the proactive-use prompt section: it must be registered with the
// systemPrompt service and say the right thing for connected / disconnected.
import './hooks.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const home = process.env.DSH_HOME || path.join(process.env.HOME || '/root', '.dsh')
const kit = process.env.DSH_GO_PLUGIN_KIT || path.join(home, 'skills', 'dsh-go-plugin', 'kit', 'lib', 'testing.js')
if (!fs.existsSync(kit)) { console.error('missing kit:', kit); process.exit(2) }
const { createTestHost } = await import(pathToFileURL(kit).href)

const sections = []
const systemPrompt = {
  section(s) { sections.push(s); return () => {} },
  getSectionOrder(name) { return { TOOL_BASH: 1000 }[name] },
}
const host = createTestHost({ dir, services: { systemPrompt } })
const mod = await import(path.join(dir, 'lib', 'index.js'))
mod.apply(host.ctx)

const prompt = sections.find((s) => s.name === 'adb-link:prompt')
if (!prompt) { console.error('FAIL prompt section was not registered'); process.exit(1) }
console.log('ok   prompt section registered at order', prompt.order)
const disconnected = prompt.text()
console.log('ok   disconnected text:', JSON.stringify(disconnected.slice(0, 60)) + '…')
if (!disconnected.includes('ADB 自动连接')) { console.error('FAIL text misses plugin name'); process.exit(1) }

// Simulate an established link, then re-read the dynamic text.
const res = await mod.__test.connectOnce({ scan: false, install: false, waitMs: 15_000 })
console.log('connect result:', JSON.stringify(res))
console.log('snapshot:', JSON.stringify(await mod.__test.snapshot({ ttl: 0 })))
const connected = prompt.text()
console.log('ok   connected text:', JSON.stringify(connected.slice(0, 80)) + '…')
if (!connected.includes('已由「ADB 自动连接」插件连好')) { console.error('FAIL connected text missing'); process.exit(1) }
if (!connected.includes('主动使用 adb')) { console.error('FAIL text does not say to use adb proactively'); process.exit(1) }

host.dispose?.()
console.log('\nall prompt checks passed')
process.exit(0)
