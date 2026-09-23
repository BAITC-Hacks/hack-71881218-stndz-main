import { copyFile, mkdir, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const frontend = resolve(here, '..')
const source = resolve(frontend, '..', 'output')
const target = resolve(frontend, 'public', 'data')
const artifacts = ['graph.json', 'nodes_roles.csv', 'clusters.csv', 'top_nodes.csv']

const missing = []
for (const artifact of artifacts) {
  try {
    if (!(await stat(resolve(source, artifact))).isFile()) missing.push(artifact)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    missing.push(artifact)
  }
}

if (missing.length) {
  console.error(`Missing official output artifacts: ${missing.join(', ')}.`)
  console.error('Run python run_pipeline.py from the repository root, then retry.')
  process.exit(1)
}

await mkdir(target, { recursive: true })
for (const artifact of artifacts) {
  await copyFile(resolve(source, artifact), resolve(target, artifact))
}
console.log(`Synced ${artifacts.length} official artifacts from output/ to frontend/public/data/`)
