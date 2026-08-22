#!/usr/bin/env node
import process from 'node:process'
import { detectRuntime } from '../runtime/detect.js'
import { EXIT, main } from './run.js'
import { withInterruptSignal } from './signals.js'

const argv = process.argv.slice(2)
if (argv[0] === 'run') {
  const invocation = await withInterruptSignal(process, async (signal) => {
    const runtime = await detectRuntime(signal)
    return main(argv, runtime)
  })
  process.exitCode = invocation.interrupted ? EXIT.cancelled : invocation.result
} else {
  // Other commands keep the host's native signal behaviour. In particular, the long-lived
  // MCP server must still terminate on its first terminal Ctrl+C.
  process.exitCode = await main(argv, await detectRuntime())
}
