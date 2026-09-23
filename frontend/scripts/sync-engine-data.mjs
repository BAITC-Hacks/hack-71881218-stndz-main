import { copyFile, mkdir, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const frontend = resolve(here, '..')
const source = resolve(frontend, '..', 'output', 'graph.json')
const target = resolve(frontend, 'public', 'data', 'graph.json')

try {
  await stat(source)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
  console.log('Synced official output/graph.json to frontend/public/data/graph.json')
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
  console.log('No output/graph.json found; keeping the existing frontend dataset')
}
