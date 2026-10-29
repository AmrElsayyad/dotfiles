/**
 * Shared primitives for kdco registry plugins.
 *
 * This module provides common utilities extracted from multiple plugin files
 * to eliminate duplication and ensure consistent behavior across plugins.
 *
 * @module kdco-primitives
 */

// Project identification
export { getProjectId } from "./get-project-id.js"

// Logging
export { logWarn } from "./log-warn.js"
// Concurrency
export { Mutex } from "./mutex.js"
// Shell escaping
export { assertShellSafe, escapeAppleScript, escapeBash, escapeBatch } from "./shell.js"
// Temp directory
export { getTempDir } from "./temp.js"
// Terminal detection
export {
	canUseCmuxWorkflow,
	detectCmuxContext,
	type CmuxContext,
	type CmuxEnvironment,
	type ResolveExecutable,
} from "./cmux.js"
export { isInsideTmux } from "./terminal-detect.js"
// Types
export type { OpencodeClient } from "./types.js"
// Timeout handling
export { TimeoutError, withTimeout } from "./with-timeout.js"
