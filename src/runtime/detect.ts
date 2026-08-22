import { createNodeRuntime } from './node.js'
import type { Runtime } from './types.js'

export function isBun(): boolean {
  return (globalThis as { Bun?: unknown }).Bun !== undefined
}

export async function detectRuntime(): Promise<Runtime> {
  if (isBun()) {
    const { createBunRuntime } = await import('./bun.js')
    return createBunRuntime()
  }
  return createNodeRuntime('node')
}
