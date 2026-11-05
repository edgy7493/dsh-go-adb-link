// Run the dsh-go plugin kit checker that ships with the DSH Go app's
// dsh-go-plugin skill. Works when run on a phone with that skill installed.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const home = process.env.DSH_HOME || path.join(process.env.HOME || '/root', '.dsh')
const checker = process.env.DSH_GO_PLUGIN_KIT_CHECK
  || path.join(home, 'skills', 'dsh-go-plugin', 'kit', 'bin', 'check.mjs')

const result = spawnSync(process.execPath, [checker, root, '--load'], { stdio: 'inherit' })
process.exit(result.status ?? 1)
