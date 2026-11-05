// Checks the agent-facing adb tool: it must register, run a real adb command,
// render text, and produce a dsh-go card view.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import './hooks.mjs'

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const home = process.env.DSH_HOME || path.join(process.env.HOME || '/root', '.dsh')
const kit = process.env.DSH_GO_PLUGIN_KIT || path.join(home, 'skills', 'dsh-go-plugin', 'kit', 'lib', 'testing.js')
if (!fs.existsSync(kit)) { console.error('missing kit:', kit); process.exit(2) }
const { createTestHost } = await import(pathToFileURL(kit).href)

const sections = []
const registered = []
const systemPrompt = {
  section(s) { sections.push(s); return () => {} },
  getSectionOrder(name) { return { TOOL_BASH: 1000 }[name] },
}
const tools = { register(def) { registered.push(def); return () => {} } }

const host = createTestHost({ dir, services: { systemPrompt, tools } })
const mod = await import(path.join(dir, 'lib', 'index.js'))
mod.apply(host.ctx)

let failures = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures++
}

const def = registered.find((entry) => entry.name === 'adb')
check(def !== undefined, 'adb tool registered', registered.map((entry) => entry.name).join(', ') || '(none)')
if (def === undefined) process.exit(1)
check(typeof def.description === 'string' && def.description.includes('主动'), 'description asks for proactive use')
check(def.parameters?.type === 'object', 'parameters are a JSON schema object')
check(def.output?.render instanceof Function, 'render is present')
check(def.output?.presentationMeta instanceof Function, 'presentationMeta is present')

const result = await def.execute(
  { description: 'echo through adb', args: ['shell', 'echo', 'adb-tool-ok'] },
  { signal: new AbortController().signal },
)
check(result.exitCode === 0, 'adb shell echo exit code', JSON.stringify(result.exitCode))
check(result.stdout.includes('adb-tool-ok'), 'stdout carries the command result', JSON.stringify(result.stdout))
check(result.command === 'adb shell echo adb-tool-ok', 'command is reported', result.command)

const rendered = def.output.render({}, result)
check(rendered?.[0]?.type === 'text' && rendered[0].text.includes('adb-tool-ok'), 'render produces text content')
const meta = def.output.presentationMeta({}, result)
check(meta?.['dsh-go/view']?.type === 'stack', 'presentationMeta carries a dsh-go view')

const empty = await def.execute({ description: 'noop', args: [] }, {})
check(empty.exitCode === -1 && empty.stderr.length > 0, 'empty args fail politely', JSON.stringify(empty.stderr))

const failed = await def.execute({ description: 'bad command', args: ['shell', 'false'] }, {})
check(failed.exitCode === 1, 'nonzero adb exit is reported, not thrown', JSON.stringify(failed.exitCode))

host.dispose?.()
console.log(failures === 0 ? '\nall tool checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
