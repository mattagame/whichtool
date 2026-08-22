#!/usr/bin/env node
import process from 'node:process'
import { detectRuntime } from '../runtime/detect.js'
import { main } from './run.js'

const runtime = await detectRuntime()
process.exitCode = await main(process.argv.slice(2), runtime)
