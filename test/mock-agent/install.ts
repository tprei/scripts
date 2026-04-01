/**
 * Install helper — creates mock `claude` and `goose` binaries in a temp
 * directory and returns a modified PATH that resolves them first.
 *
 * Usage in tests:
 *   const mock = await installMockAgent(scenarioPath)
 *   // mock.binDir  — temp dir containing claude + goose scripts
 *   // mock.env     — { PATH, MOCK_SCENARIO_PATH } to spread into spawn env
 *   // mock.cleanup — removes the temp dir
 */

import { mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const MOCK_AGENT_PATH = resolve(
  import.meta.dirname,
  "mock-agent.ts",
)

const TSX_PATH = resolve(
  import.meta.dirname,
  "../../node_modules/.bin/tsx",
)

export interface MockAgentInstall {
  /** Directory containing the mock `claude` and `goose` binaries */
  binDir: string
  /** Environment vars to pass to spawned processes */
  env: {
    PATH: string
    MOCK_SCENARIO_PATH: string
    MOCK_CALLBACK_PORT?: string
  }
  /** Update the scenario path (e.g., to switch scenarios mid-test) */
  setScenario(path: string): void
  /** Remove the temp directory */
  cleanup(): void
}

export interface InstallOptions {
  /** Path to the scenario JSON file */
  scenarioPath: string
  /** Optional callback port for invocation inspection */
  callbackPort?: number
}

/**
 * Install mock agent binaries into a fresh temp directory.
 * The returned `env` object contains PATH (with binDir prepended)
 * and MOCK_SCENARIO_PATH, ready to spread into a spawn environment.
 */
export function installMockAgent(opts: InstallOptions): MockAgentInstall {
  const binDir = mkdtempSync(join(tmpdir(), "mock-agent-"))

  // Create shell wrapper scripts for both `claude` and `goose`
  const wrapperScript = [
    "#!/bin/sh",
    `exec "${TSX_PATH}" "${MOCK_AGENT_PATH}" "$@"`,
    "",
  ].join("\n")

  for (const name of ["claude", "goose"]) {
    const binPath = join(binDir, name)
    writeFileSync(binPath, wrapperScript, "utf-8")
    chmodSync(binPath, 0o755)
  }

  const currentPath = process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"

  const env: MockAgentInstall["env"] = {
    PATH: `${binDir}:${currentPath}`,
    MOCK_SCENARIO_PATH: opts.scenarioPath,
    ...(opts.callbackPort ? { MOCK_CALLBACK_PORT: String(opts.callbackPort) } : {}),
  }

  return {
    binDir,
    env,
    setScenario(path: string) {
      env.MOCK_SCENARIO_PATH = path
    },
    cleanup() {
      try {
        rmSync(binDir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    },
  }
}

/**
 * Write a scenario object to a JSON file in a temp directory.
 * Returns the path to the written file.
 */
export function writeScenarioFile(
  scenario: unknown,
  dir?: string,
): string {
  const targetDir = dir ?? mkdtempSync(join(tmpdir(), "mock-scenario-"))
  mkdirSync(targetDir, { recursive: true })
  const filePath = join(targetDir, "scenario.json")
  writeFileSync(filePath, JSON.stringify(scenario, null, 2), "utf-8")
  return filePath
}
