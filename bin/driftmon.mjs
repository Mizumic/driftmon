#!/usr/bin/env node
// driftmon CLI 入口。只做参数转发，逻辑在 src/cli.mjs。

import { main } from '../src/cli.mjs'

process.exitCode = await main(process.argv.slice(2))
