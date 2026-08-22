import { Buffer } from 'node:buffer'
import { mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeCachedPick, type CacheInfo, type TrialCache } from '../core/cache/types.js'

export const DEFAULT_CACHE_DIR = '.whichtool-cache'
export const MAX_CACHE_ENTRY_BYTES = 16 * 1024 * 1024

function entryPath(root: string, key: string): string {
  return join(root, 'trials', key.slice(0, 2), `${key}.json`)
}

async function readBoundedEntry(path: string): Promise<string | null> {
  const file = await open(path, 'r')
  try {
    const metadata = await file.stat()
    if (
      !metadata.isFile() ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < 0 ||
      metadata.size > MAX_CACHE_ENTRY_BYTES
    ) {
      return null
    }

    // One extra byte detects a file that grew after stat(), while the fixed-size buffer
    // prevents a raced or hostile cache entry from making readFile() allocate without bound.
    const buffer = Buffer.allocUnsafe(metadata.size + 1)
    let bytesRead = 0
    while (bytesRead < buffer.byteLength) {
      const chunk = await file.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead)
      if (chunk.bytesRead === 0) break
      bytesRead += chunk.bytesRead
    }
    if (bytesRead !== metadata.size) return null
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await file.close()
  }
}

export function createFileCache(root: string, displayLocation = root): TrialCache {
  return {
    async get(key) {
      try {
        const text = await readBoundedEntry(entryPath(root, key))
        if (text === null) return null
        return normalizeCachedPick(JSON.parse(text) as unknown)
      } catch {
        // A missing file is the common case; a corrupt one is treated the same way, since
        // re-asking the model is always safe and repairing the file is not our business.
        return null
      }
    },

    async set(key, value) {
      const path = entryPath(root, key)
      await mkdir(join(root, 'trials', key.slice(0, 2)), { recursive: true })
      // Write to a sibling and rename, so a cancelled run cannot leave a half-written entry
      // that later parses as valid JSON.
      const temporary = `${path}.${key.slice(2, 10)}.tmp`
      await writeFile(temporary, JSON.stringify(value), 'utf8')
      const { rename } = await import('node:fs/promises')
      await rename(temporary, path)
    },

    async info(): Promise<CacheInfo> {
      let entries = 0
      let bytes = 0
      const trials = join(root, 'trials')
      try {
        for (const shard of await readdir(trials)) {
          for (const name of await readdir(join(trials, shard))) {
            if (!name.endsWith('.json')) continue
            entries += 1
            bytes += (await stat(join(trials, shard, name))).size
          }
        }
      } catch {
        // No cache directory yet: zero entries is the honest answer.
      }
      return { entries, bytes, location: displayLocation }
    },

    async clear() {
      const { entries } = await this.info()
      await rm(join(root, 'trials'), { recursive: true, force: true })
      return entries
    },
  }
}
