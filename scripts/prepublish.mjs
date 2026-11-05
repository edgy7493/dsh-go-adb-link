// `npm publish` runs this. It refuses to ship while the repo still has
// placeholders, has no OSI license, or its metadata is inconsistent with the
// DSH Go manifest / market entry.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const problems = []
const has = (file) => fs.existsSync(path.join(root, file))
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

const repoText = JSON.stringify({
  repository: pkg.repository,
  homepage: pkg.homepage,
  bugs: pkg.bugs,
})
if (repoText.includes('OWNER')) {
  problems.push('package.json 的 repository/homepage/bugs 还是 OWNER 占位，先换成你的 GitHub 用户名')
}
if (!has('LICENSE')) problems.push('缺少 LICENSE 文件')
if (pkg.license !== 'MIT') problems.push('package.json 的 license 应为 MIT（DSH Go 市场要求 OSI 许可）')
for (const file of ['lib/index.js', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
  if (!has(file)) problems.push(`缺少文件 ${file}`)
}
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') {
  problems.push('package.json 的 dsh.bundle.patch 应指向 ./cordis.patch.yml')
}
if (pkg.dshGo?.v !== 1) problems.push('package.json 的 dshGo.v 应为 1')
if (typeof pkg.dshGo?.minApp !== 'string') problems.push('package.json 的 dshGo.minApp 缺失')

if (has('cordis.patch.yml')) {
  const patch = read('cordis.patch.yml')
  if (!patch.includes(`id: ${pkg.name}`) || !patch.includes(`name: ${pkg.name}`)) {
    problems.push('cordis.patch.yml 的 id/name 与 package.json 的 name 不一致')
  }
}

if (has('lib/index.js')) {
  const mod = await import(path.join(root, 'lib', 'index.js'))
  if (mod.name !== pkg.name) problems.push(`lib/index.js 导出的 name (${mod.name}) 与包名不一致`)
}

if (!has('market-entry.json')) {
  problems.push('缺少 market-entry.json（DSH Go 官方市场上架文件）')
} else {
  const entry = JSON.parse(read('market-entry.json'))
  if (entry.name !== pkg.name) problems.push('market-entry.json 的 name 与包名不一致')
  if (entry.version !== pkg.version) {
    problems.push(`market-entry.json 的 version (${entry.version}) 与 package.json (${pkg.version}) 不一致`)
  }
  if (!entry.title?.en || !entry.summary?.en) problems.push('market-entry.json 的 title/summary 必须有英文 en')
  if (!['tools', 'media', 'productivity', 'communication', 'other'].includes(entry.category)) {
    problems.push('market-entry.json 的 category 必须是 tools/media/productivity/communication/other')
  }
  if (JSON.stringify(entry).includes('OWNER')) problems.push('market-entry.json 里还有 OWNER 占位')
}

if (problems.length > 0) {
  console.error('发布前检查未通过：')
  for (const problem of problems) console.error(' -', problem)
  process.exit(1)
}
console.log(`发布前检查通过：${pkg.name}@${pkg.version}`)
console.log('下一步：npm publish，然后到 DSH Go 市场仓库提 PR')
