import { createNodeRuntime } from './node.js'
import type { Runtime } from './types.js'

declare const Bun: {
  file(path: string): { text(): Promise<string>; exists(): Promise<boolean> }
  write(path: string, data: string): Promise<number>
}

export function createBunRuntime(): Runtime {
  const base = createNodeRuntime('bun')
  return {
    ...base,
    async readTextFile(path) {
      return Bun.file(path).text()
    },
    async writeTextFile(path, content) {
      await Bun.write(path, content)
    },
    async fileExists(path) {
      return Bun.file(path).exists()
    },
  }
}
