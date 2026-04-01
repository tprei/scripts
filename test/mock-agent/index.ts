/**
 * Mock agent test infrastructure — re-exports all public API.
 *
 * Usage:
 *   import {
 *     installMockAgent,
 *     writeScenarioFile,
 *     simpleSuccess,
 *     ScenarioBuilder,
 *   } from "../mock-agent/index.js"
 */

export {
  type Scenario,
  type ScenarioStep,
  resetBuilderState,
  textMessage,
  toolRequest,
  toolResponse,
  complete,
  error,
  notification,
  simpleSuccess,
  withToolUse,
  failWithError,
  codingTask,
  ScenarioBuilder,
} from "./scenario.js"

export {
  type MockAgentInstall,
  type InstallOptions,
  installMockAgent,
  writeScenarioFile,
} from "./install.js"
