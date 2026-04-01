#!/usr/bin/env node
/**
 * Mock agent binary — simulates Claude/Goose CLI for integration tests.
 *
 * Reads a scenario JSON file from MOCK_SCENARIO_PATH env var, then emits
 * NDJSON events to stdout with configured delays. Designed to be symlinked
 * as both `claude` and `goose` in a test PATH directory.
 *
 * Usage:
 *   MOCK_SCENARIO_PATH=/path/to/scenario.json node mock-agent.ts [args...]
 *
 * The binary accepts (and ignores) any CLI args, so it's compatible with
 * both claude and goose argument patterns.
 *
 * Additional env vars:
 *   MOCK_CALLBACK_PORT — if set, POSTs { argv, env, cwd } to this port on
 *                         localhost before starting playback, allowing tests
 *                         to inspect how the binary was invoked.
 */

import { readFileSync } from "node:fs"
import { request } from "node:http"
import type { Scenario } from "./scenario.js"

async function main(): Promise<void> {
  const scenarioPath = process.env["MOCK_SCENARIO_PATH"]
  if (!scenarioPath) {
    process.stderr.write("mock-agent: MOCK_SCENARIO_PATH not set\n")
    process.exit(2)
  }

  let scenario: Scenario
  try {
    const raw = readFileSync(scenarioPath, "utf-8")
    scenario = JSON.parse(raw) as Scenario
  } catch (err) {
    process.stderr.write(`mock-agent: failed to read scenario: ${err}\n`)
    process.exit(2)
  }

  // Optionally notify the test harness about our invocation
  const callbackPort = process.env["MOCK_CALLBACK_PORT"]
  if (callbackPort) {
    await notifyCallback(Number(callbackPort))
  }

  // Emit stderr lines if configured
  if (scenario.stderr) {
    for (const line of scenario.stderr) {
      process.stderr.write(line + "\n")
    }
  }

  // Play back events with delays
  for (const step of scenario.steps) {
    if (step.delay && step.delay > 0) {
      await sleep(step.delay)
    }
    const line = JSON.stringify(step.event)
    process.stdout.write(line + "\n")
  }

  process.exit(scenario.exitCode ?? 0)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function notifyCallback(port: number): Promise<void> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      argv: process.argv,
      cwd: process.cwd(),
      env: {
        MOCK_SCENARIO_PATH: process.env["MOCK_SCENARIO_PATH"],
        HOME: process.env["HOME"],
        PATH: process.env["PATH"],
      },
    })

    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/invocation",
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      () => resolve(),
    )
    req.on("error", () => resolve()) // don't fail if callback server is down
    req.write(payload)
    req.end()
  })
}

main().catch((err) => {
  process.stderr.write(`mock-agent: unexpected error: ${err}\n`)
  process.exit(2)
})
