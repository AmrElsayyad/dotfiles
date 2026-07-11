/**
 * background-agents
 * Unified delegation system for OpenCode
 *
 * Replaces native `subagent` tool with persistent, async-first agent delegation.
 * All agent outputs are persisted to storage, orchestrator receives only key references.
 *
 * Based on oh-my-opencode by @code-yeongyu (MIT License)
 * https://github.com/code-yeongyu/oh-my-opencode
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Plugin } from "@opencode/plugin"
import { adjectives, animals, colors, uniqueNamesGenerator } from "unique-names-generator"
import { getProjectId } from "./kdco-primitives/get-project-id"

// ==========================================
// READABLE ID GENERATION
// ==========================================

function generateReadableId(): string {
	return uniqueNamesGenerator({
		dictionaries: [adjectives, colors, animals],
		separator: "-",
		length: 3,
		style: "lowerCase",
	})
}

// ==========================================
// METADATA GENERATION (transient metadata session)
// ==========================================

interface GeneratedMetadata {
	title: string
	description: string
}

/**
 * Generate title and description from result content in a transient session.
 * Falls back to truncation if generation fails or times out.
 */
async function generateMetadata(
	ctx: DelegationContext,
	resultContent: string,
	parentID: string,
	debugLog: (msg: string) => Promise<void>,
): Promise<GeneratedMetadata> {
	const fallbackMetadata = (): GeneratedMetadata => {
		// Fallback: truncate first line/paragraph
		const firstLine =
			resultContent.split("\n").find((l) => l.trim().length > 0) || "Delegation result"
		const title = firstLine.slice(0, 30).trim() + (firstLine.length > 30 ? "..." : "")
		const description =
			resultContent.slice(0, 150).trim() + (resultContent.length > 150 ? "..." : "")
		return { title, description }
	}

	let metadataSessionID: string | undefined

	try {
		// Create a session for metadata generation
		const session = await ctx.session.create({
			title: "Metadata Generation",
			parentID,
		})

		if (!session?.id) {
			await debugLog("generateMetadata: Failed to create session")
			return fallbackMetadata()
		}

		metadataSessionID = session.id

		// Prompt the model for metadata
		const prompt = `Generate a title and description for this research result.

RULES:
- Title: 2-5 words, max 30 characters, sentence case
- Description: 2-3 sentences, max 150 characters, summarize key findings

RESULT CONTENT:
${resultContent.slice(0, 2000)}

Respond with ONLY valid JSON in this exact format:
{"title": "Your Title Here", "description": "Your description here."}`

		// Await generation directly with timeout safety net
		const PROMPT_TIMEOUT_MS = 30000
		const result = await Promise.race([
			ctx.session.generate({ sessionID: session.id, prompt }),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("Prompt timeout after 30s")), PROMPT_TIMEOUT_MS),
			),
		])

		// Extract text from the response
		const responseText = result?.text
		if (!responseText) {
			await debugLog("generateMetadata: No text in response")
			return fallbackMetadata()
		}

		// Parse JSON response
		const jsonMatch = responseText.match(/\{[\s\S]*\}/)
		if (!jsonMatch) {
			await debugLog(`generateMetadata: No JSON found in response: ${responseText}`)
			return fallbackMetadata()
		}

		const parsed = JSON.parse(jsonMatch[0]) as { title?: string; description?: string }
		if (!parsed.title || !parsed.description) {
			await debugLog("generateMetadata: Invalid JSON structure")
			return fallbackMetadata()
		}

		await debugLog(`generateMetadata: Generated title="${parsed.title}"`)
		return {
			title: parsed.title.slice(0, 30),
			description: parsed.description.slice(0, 150),
		}
	} catch (error) {
		await debugLog(
			`generateMetadata error: ${error instanceof Error ? error.message : "Unknown error"}`,
		)
		return fallbackMetadata()
	} finally {
		if (metadataSessionID) {
			try {
				await ctx.session.remove({ sessionID: metadataSessionID })
			} catch {
				// Ignore
			}
		}
	}
}

// ==========================================
// TYPE DEFINITIONS
// ==========================================

/** Content item inside a projected V2 session context message. */
interface SessionContextContentItem {
	type?: string
	text?: string
}

/** Projected V2 session context message (session.context result item). */
interface SessionContextMessage {
	type?: string
	content?: SessionContextContentItem[]
}

/** V2 permission rule from ctx.agent.list(). */
interface AgentPermissionRule {
	action: string
	resource: string
	effect: string
}

interface AgentRecord {
	id?: string
	name?: string
	description?: string
	mode?: string
	permissions?: AgentPermissionRule[]
}

/** Subset of the V2 session context used by the delegation manager. */
interface SessionOps {
	get(input: { sessionID: string }): Promise<{ id: string; parentID?: string }>
	create(input?: { title?: string; parentID?: string; agent?: string }): Promise<{ id: string }>
	prompt(input: { sessionID: string; text: string }): Promise<unknown>
	generate(input: { sessionID: string; prompt: string }): Promise<{ text?: string }>
	synthetic(input: { sessionID: string; text: string; resume?: boolean }): Promise<unknown>
	context(input: { sessionID: string }): Promise<SessionContextMessage[]>
	remove(input: { sessionID: string }): Promise<void>
}

/** Subset of the V2 plugin context used by the delegation system. */
interface DelegationContext {
	agent: { list(): Promise<unknown> }
	session: SessionOps
}

/** Logger interface for structured logging (console-backed in V2). */
interface Logger {
	debug: (msg: string) => void
	info: (msg: string) => void
	warn: (msg: string) => void
	error: (msg: string) => void
}

type DelegationStatus = "registered" | "running" | "complete" | "error" | "cancelled" | "timeout"

type DelegationTerminalStatus = Extract<
	DelegationStatus,
	"complete" | "error" | "cancelled" | "timeout"
>

interface DelegationProgress {
	toolCalls: number
	lastUpdateAt: Date
	lastHeartbeatAt: Date
	lastMessage?: string
	lastMessageAt?: Date
}

interface DelegationNotificationState {
	terminalNotifiedAt?: Date
	terminalNotificationCount: number
}

interface ParentNotificationState {
	allCompleteNotifiedAt?: Date
	allCompleteNotificationCount: number
	allCompleteCycle: number
	allCompleteCycleToken: string
	allCompleteNotifiedCycle?: number
	allCompleteNotifiedCycleToken?: string
	allCompleteScheduledCycle?: number
	allCompleteScheduledCycleToken?: string
	allCompleteScheduledTimer?: ReturnType<typeof setTimeout>
}

interface DelegationRetrievalState {
	retrievedAt?: Date
	retrievalCount: number
	lastReaderSessionID?: string
}

interface DelegationArtifactState {
	filePath: string
	persistedAt?: Date
	byteLength?: number
	persistError?: string
}

interface DelegationRecord {
	id: string
	rootSessionID: string
	sessionID: string
	parentSessionID: string
	parentMessageID: string
	parentAgent: string
	prompt: string
	agent: string
	notificationCycle: number
	notificationCycleToken: string
	status: DelegationStatus
	createdAt: Date
	startedAt?: Date
	completedAt?: Date
	updatedAt: Date
	timeoutAt: Date
	progress: DelegationProgress
	notification: DelegationNotificationState
	retrieval: DelegationRetrievalState
	artifact: DelegationArtifactState
	error?: string
	title?: string
	description?: string
	result?: string
}

const DEFAULT_MAX_RUN_TIME_MS = 15 * 60 * 1000 // 15 minutes
const TERMINAL_WAIT_GRACE_MS = 10_000
const READ_POLL_INTERVAL_MS = 250
const ALL_COMPLETE_QUIET_PERIOD_MS = 50
const PARENT_NOTIFICATION_TIMEOUT_MS = 5_000

interface DelegateInput {
	parentSessionID: string
	parentMessageID: string
	parentAgent: string
	prompt: string
	agent: string
}

interface DelegationListItem {
	id: string
	status: DelegationStatus
	title?: string
	description?: string
	agent?: string
	unread?: boolean
}

interface DelegationManagerOptions {
	maxRunTimeMs?: number
	readPollIntervalMs?: number
	terminalWaitGraceMs?: number
	allCompleteQuietPeriodMs?: number
	idGenerator?: () => string
	metadataGenerator?: typeof generateMetadata
}

// ==========================================
// AGENT CAPABILITY DETECTION
// ==========================================

/** V2 agent.list() returns an envelope; accept both shapes for resilience. */
function normalizeAgentList(result: unknown): AgentRecord[] {
	if (Array.isArray(result)) return result as AgentRecord[]
	const data = (result as { data?: unknown } | undefined)?.data
	return Array.isArray(data) ? (data as AgentRecord[]) : []
}

/**
 * Parse agent mode at boundary.
 * Returns trusted type indicating if agent is a sub-agent, plus its permission rules
 * so callers don't need a second agent-list fetch.
 */
async function parseAgentMode(
	ctx: DelegationContext,
	agentName: string,
	log: Logger,
): Promise<{ isSubAgent: boolean; permissions: AgentPermissionRule[] }> {
	try {
		const agents = normalizeAgentList(await ctx.agent.list())
		const agent =
			agents.find((a) => a.id === agentName) ??
			agents.find((a) => a.name?.toLowerCase() === agentName.toLowerCase())
		return { isSubAgent: agent?.mode === "subagent", permissions: agent?.permissions ?? [] }
	} catch (error) {
		// Fail-safe: Agent list errors shouldn't block task calls
		// Fail-loud: Log for observability
		log.warn(
			`Agent list fetch failed for "${agentName}", assuming non-sub-agent: ${error instanceof Error ? error.message : String(error)}`,
		)
		return { isSubAgent: false, permissions: [] }
	}
}

/**
 * Parse agent write capability at boundary.
 * Returns trusted type indicating if agent is read-only.
 *
 * A rule denies an action when the last wildcard-resource rule matching that action
 * has effect "deny". Read-only = any of edit/write/shell denied.
 *
 * WHY any-denied (not all-denied): against the live V2 permission dump, all-denied
 * would reject the read-only sub-agents (explore/plan) that delegate() exists to
 * serve, while still allowing write-capable agents (build/general) through.
 */
function parseAgentWriteCapability(
	rules: AgentPermissionRule[],
	log: Logger,
): { isReadOnly: boolean } {
	try {
		const denied = (action: string): boolean => {
			const rule = rules.findLast(
				(r) => (r.action === action || r.action === "*") && r.resource === "*",
			)
			return rule?.effect === "deny"
		}

		return { isReadOnly: denied("edit") || denied("write") || denied("shell") }
	} catch (error) {
		// Fail-safe: Malformed rules shouldn't block task calls
		// Fail-loud: Log for observability
		log.warn(
			`Permission parse failed, assuming write-capable: ${error instanceof Error ? error.message : String(error)}`,
		)
		return { isReadOnly: false }
	}
}

/**
 * DELEGATION MANAGER
 */
function isTerminalStatus(status: DelegationStatus): status is DelegationTerminalStatus {
	return (
		status === "complete" || status === "error" || status === "cancelled" || status === "timeout"
	)
}

function isActiveStatus(status: DelegationStatus): boolean {
	return status === "registered" || status === "running"
}

const DELEGATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Validate a caller-supplied delegation id before it becomes a path segment.
 * Rejects empty values, `.`/`..`, separators, and anything outside the id
 * alphabet so an id cannot escape the per-session delegations directory.
 */
function normalizeId(value: string): string {
	const id = value.trim()
	if (!DELEGATION_ID_PATTERN.test(id)) {
		throw new Error(
			"Invalid delegation ID. Use the id printed by delegation_list() or the task notification.",
		)
	}
	return id
}

/**
 * Resolve `<id>.md` inside `dir` and refuse anything that escapes it, so a
 * future loosening of the id pattern cannot become a path traversal.
 */
function resolveInsideDir(dir: string, fileName: string): string {
	const resolvedDir = path.resolve(dir)
	const resolvedFile = path.resolve(resolvedDir, fileName)
	const relative = path.relative(resolvedDir, resolvedFile)
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error("Refusing to access a delegation path outside the delegations directory.")
	}
	return resolvedFile
}

/**
 * Escape a value before interpolating it into `<task-notification>` XML.
 * Titles, descriptions and errors originate from model output and must not be
 * able to close the notification block or inject sibling tags.
 */
function escapeXmlText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;")
}

function parsePersistedStatus(raw: string | undefined): DelegationStatus {
	if (!raw) return "complete"
	if (raw === "registered") return "registered"
	if (raw === "running") return "running"
	if (raw === "complete") return "complete"
	if (raw === "error") return "error"
	if (raw === "cancelled") return "cancelled"
	if (raw === "timeout") return "timeout"
	return "complete"
}

class DelegationManager {
	private delegations: Map<string, DelegationRecord> = new Map()
	private delegationsBySession: Map<string, string> = new Map()
	private terminalWaiters: Map<string, { promise: Promise<void>; resolve: () => void }> = new Map()
	private timeoutTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
	private ctx: DelegationContext
	private baseDir: string
	private log: Logger
	private maxRunTimeMs: number
	private readPollIntervalMs: number
	private terminalWaitGraceMs: number
	private allCompleteQuietPeriodMs: number
	private idGenerator: () => string
	private metadataGenerator: typeof generateMetadata
	private pendingByParent: Map<string, Set<string>> = new Map()
	private parentNotificationState: Map<string, ParentNotificationState> = new Map()
	private pendingNotifications: Map<string, string[]> = new Map()

	constructor(
		ctx: DelegationContext,
		baseDir: string,
		log: Logger,
		options: DelegationManagerOptions = {},
	) {
		this.ctx = ctx
		this.baseDir = baseDir
		this.log = log
		this.maxRunTimeMs = options.maxRunTimeMs ?? DEFAULT_MAX_RUN_TIME_MS
		this.readPollIntervalMs = options.readPollIntervalMs ?? READ_POLL_INTERVAL_MS
		this.terminalWaitGraceMs = options.terminalWaitGraceMs ?? TERMINAL_WAIT_GRACE_MS
		this.allCompleteQuietPeriodMs = options.allCompleteQuietPeriodMs ?? ALL_COMPLETE_QUIET_PERIOD_MS
		this.idGenerator = options.idGenerator ?? generateReadableId
		this.metadataGenerator = options.metadataGenerator ?? generateMetadata
	}

	/**
	 * Resolves the root session ID by walking up the parent chain.
	 */
	async getRootSessionID(sessionID: string): Promise<string> {
		let currentID = sessionID
		// Prevent infinite loops with max depth
		for (let depth = 0; depth < 10; depth++) {
			try {
				const session = await this.ctx.session.get({ sessionID: currentID })

				if (!session?.parentID) {
					return currentID
				}

				currentID = session.parentID
			} catch {
				// If we can't fetch the session, assume current is root or best effort
				return currentID
			}
		}
		return currentID
	}

	/**
	 * Get the delegations directory for a session scope (root session)
	 */
	private async getDelegationsDir(sessionID: string): Promise<string> {
		const rootID = await this.getRootSessionID(sessionID)
		return path.join(this.baseDir, rootID)
	}

	/**
	 * Ensure the delegations directory exists
	 */
	private async ensureDelegationsDir(sessionID: string): Promise<string> {
		const dir = await this.getDelegationsDir(sessionID)
		await fs.mkdir(dir, { recursive: true })
		return dir
	}

	private createTerminalWaiter(id: string): void {
		if (this.terminalWaiters.has(id)) return

		let resolve: (() => void) | undefined
		const promise = new Promise<void>((innerResolve) => {
			resolve = innerResolve
		})

		if (!resolve) {
			throw new Error(`Failed to initialize terminal waiter for delegation ${id}`)
		}

		this.terminalWaiters.set(id, { promise, resolve })
	}

	private resolveTerminalWaiter(id: string): void {
		const waiter = this.terminalWaiters.get(id)
		if (!waiter) return
		waiter.resolve()
	}

	private clearTimeoutTimer(id: string): void {
		const timer = this.timeoutTimers.get(id)
		if (!timer) return
		clearTimeout(timer)
		this.timeoutTimers.delete(id)
	}

	private scheduleTimeout(id: string): void {
		this.clearTimeoutTimer(id)
		const timer = setTimeout(() => {
			void this.handleTimeout(id)
		}, this.maxRunTimeMs + 5_000)
		this.timeoutTimers.set(id, timer)
	}

	private updateDelegation(
		id: string,
		mutate: (delegation: DelegationRecord, now: Date) => void,
	): DelegationRecord | undefined {
		const delegation = this.delegations.get(id)
		if (!delegation) return undefined

		const now = new Date()
		mutate(delegation, now)
		delegation.updatedAt = now
		return delegation
	}

	private registerDelegation(input: {
		id: string
		rootSessionID: string
		sessionID: string
		parentSessionID: string
		parentMessageID: string
		parentAgent: string
		prompt: string
		agent: string
		artifactPath: string
	}): DelegationRecord {
		if (!this.pendingByParent.has(input.parentSessionID)) {
			this.pendingByParent.set(input.parentSessionID, new Set())
			this.resetParentAllCompleteNotificationCycle(input.parentSessionID)
		}

		const parentNotificationState = this.getParentNotificationState(input.parentSessionID)
		const notificationCycle = parentNotificationState.allCompleteCycle
		const notificationCycleToken = parentNotificationState.allCompleteCycleToken

		const now = new Date()
		const delegation: DelegationRecord = {
			id: input.id,
			rootSessionID: input.rootSessionID,
			sessionID: input.sessionID,
			parentSessionID: input.parentSessionID,
			parentMessageID: input.parentMessageID,
			parentAgent: input.parentAgent,
			prompt: input.prompt,
			agent: input.agent,
			notificationCycle,
			notificationCycleToken,
			status: "registered",
			createdAt: now,
			updatedAt: now,
			timeoutAt: new Date(now.getTime() + this.maxRunTimeMs),
			progress: {
				toolCalls: 0,
				lastUpdateAt: now,
				lastHeartbeatAt: now,
			},
			notification: {
				terminalNotificationCount: 0,
			},
			retrieval: {
				retrievalCount: 0,
			},
			artifact: {
				filePath: input.artifactPath,
			},
		}

		this.delegations.set(delegation.id, delegation)
		this.delegationsBySession.set(delegation.sessionID, delegation.id)
		this.createTerminalWaiter(delegation.id)
		this.pendingByParent.get(delegation.parentSessionID)?.add(delegation.id)

		return delegation
	}

	private markStarted(id: string): DelegationRecord | undefined {
		return this.updateDelegation(id, (delegation, now) => {
			if (isTerminalStatus(delegation.status)) return
			delegation.status = "running"
			delegation.startedAt = now
			delegation.progress.lastUpdateAt = now
			delegation.progress.lastHeartbeatAt = now
		})
	}

	private markProgress(id: string, messageText?: string): DelegationRecord | undefined {
		return this.updateDelegation(id, (delegation, now) => {
			if (isTerminalStatus(delegation.status)) return
			if (delegation.status === "registered") {
				delegation.status = "running"
				delegation.startedAt = delegation.startedAt ?? now
			}

			delegation.progress.lastUpdateAt = now
			delegation.progress.lastHeartbeatAt = now

			if (messageText) {
				delegation.progress.lastMessage = messageText
				delegation.progress.lastMessageAt = now
			}
		})
	}

	private markTerminal(
		id: string,
		status: DelegationTerminalStatus,
		error?: string,
	): { transitioned: boolean; delegation?: DelegationRecord } {
		const delegation = this.delegations.get(id)
		if (!delegation) return { transitioned: false }

		if (isTerminalStatus(delegation.status)) {
			return { transitioned: false, delegation }
		}

		const now = new Date()
		delegation.status = status
		delegation.completedAt = now
		delegation.updatedAt = now
		if (error) {
			delegation.error = error
		}

		const pending = this.pendingByParent.get(delegation.parentSessionID)
		if (pending) {
			pending.delete(delegation.id)
			if (pending.size === 0) {
				this.pendingByParent.delete(delegation.parentSessionID)
			}
		}

		this.clearTimeoutTimer(id)
		this.resolveTerminalWaiter(id)

		return { transitioned: true, delegation }
	}

	private markNotified(id: string): DelegationRecord | undefined {
		return this.updateDelegation(id, (delegation, now) => {
			delegation.notification.terminalNotifiedAt = now
			delegation.notification.terminalNotificationCount += 1
		})
	}

	private getParentNotificationState(parentSessionID: string): ParentNotificationState {
		const existing = this.parentNotificationState.get(parentSessionID)
		if (existing) return existing

		const initialized: ParentNotificationState = {
			allCompleteNotificationCount: 0,
			allCompleteCycle: 0,
			allCompleteCycleToken: this.buildAllCompleteCycleToken(parentSessionID, 0),
		}
		this.parentNotificationState.set(parentSessionID, initialized)
		return initialized
	}

	private buildAllCompleteCycleToken(parentSessionID: string, cycle: number): string {
		return `${parentSessionID}:${cycle}`
	}

	private resetParentAllCompleteNotificationCycle(parentSessionID: string): void {
		const state = this.getParentNotificationState(parentSessionID)
		this.cancelScheduledAllComplete(state)
		state.allCompleteCycle += 1
		state.allCompleteCycleToken = this.buildAllCompleteCycleToken(
			parentSessionID,
			state.allCompleteCycle,
		)
		state.allCompleteNotifiedAt = undefined
		state.allCompleteNotifiedCycle = undefined
		state.allCompleteNotifiedCycleToken = undefined
	}

	private cancelScheduledAllComplete(state: ParentNotificationState): void {
		if (state.allCompleteScheduledTimer) {
			clearTimeout(state.allCompleteScheduledTimer)
		}
		state.allCompleteScheduledTimer = undefined
		state.allCompleteScheduledCycle = undefined
		state.allCompleteScheduledCycleToken = undefined
	}

	private areCycleTerminalNotificationsComplete(
		parentSessionID: string,
		cycleToken: string,
	): boolean {
		let cycleDelegationCount = 0

		for (const delegation of this.delegations.values()) {
			if (delegation.parentSessionID !== parentSessionID) continue
			if (delegation.notificationCycleToken !== cycleToken) continue

			cycleDelegationCount += 1
			if (!delegation.notification.terminalNotifiedAt) {
				return false
			}
		}

		return cycleDelegationCount > 0
	}

	private scheduleAllCompleteForParent(parentSessionID: string): void {
		const state = this.getParentNotificationState(parentSessionID)
		const cycle = state.allCompleteCycle
		const cycleToken = state.allCompleteCycleToken
		if (!this.areCycleTerminalNotificationsComplete(parentSessionID, cycleToken)) return

		if (state.allCompleteNotifiedCycleToken === cycleToken) return
		if (state.allCompleteScheduledCycleToken === cycleToken) return

		this.cancelScheduledAllComplete(state)

		state.allCompleteScheduledCycle = cycle
		state.allCompleteScheduledCycleToken = cycleToken
		state.allCompleteScheduledTimer = setTimeout(() => {
			void this.dispatchScheduledAllComplete(parentSessionID, cycle, cycleToken)
		}, this.allCompleteQuietPeriodMs)
	}

	private async dispatchScheduledAllComplete(
		parentSessionID: string,
		cycle: number,
		cycleToken: string,
	): Promise<void> {
		const state = this.getParentNotificationState(parentSessionID)

		if (state.allCompleteScheduledCycleToken !== cycleToken) return

		this.cancelScheduledAllComplete(state)

		if (state.allCompleteCycleToken !== cycleToken) return
		if (!this.areCycleTerminalNotificationsComplete(parentSessionID, cycleToken)) return
		if (state.allCompleteNotifiedCycleToken === cycleToken) return

		const deliveryStatus = await this.sendParentNotification(
			parentSessionID,
			this.buildAllCompleteNotification(parentSessionID, cycle, cycleToken),
			false,
		)

		if (state.allCompleteCycleToken !== cycleToken) return
		if (!this.areCycleTerminalNotificationsComplete(parentSessionID, cycleToken)) return

		state.allCompleteNotifiedAt = new Date()
		state.allCompleteNotificationCount += 1
		state.allCompleteNotifiedCycle = cycle
		state.allCompleteNotifiedCycleToken = cycleToken

		await this.debugLog(
			`all-complete notification ${deliveryStatus} for ${parentSessionID} cycle=${cycleToken}`,
		)
	}

	private queuePendingNotification(parentSessionID: string, notification: string): void {
		const pending = this.pendingNotifications.get(parentSessionID) ?? []
		pending.push(notification)
		this.pendingNotifications.set(parentSessionID, pending)
	}

	private async sendParentNotification(
		parentSessionID: string,
		notification: string,
		noReply: boolean,
	): Promise<"sent" | "queued" | "timed-out"> {
		let timeout: ReturnType<typeof setTimeout> | undefined

		try {
			await this.debugLog(`parent notification sending for ${parentSessionID} noReply=${noReply}`)

			const result = await Promise.race<"sent" | "timed-out">([
				this.ctx.session
					.synthetic({
						sessionID: parentSessionID,
						text: notification,
						resume: !noReply,
					})
					.then(() => "sent" as const),
				new Promise<"timed-out">((resolve) => {
					timeout = setTimeout(() => resolve("timed-out"), PARENT_NOTIFICATION_TIMEOUT_MS)
				}),
			])

			if (result === "timed-out") {
				await this.debugLog(
					`parent notification timed out for ${parentSessionID} after ${PARENT_NOTIFICATION_TIMEOUT_MS}ms`,
				)
			}

			return result
		} catch (error) {
			this.queuePendingNotification(parentSessionID, notification)
			await this.debugLog(
				`parent notification queued for ${parentSessionID}: ${
					error instanceof Error ? error.message : "Unknown error"
				}`,
			)
			return "queued"
		} finally {
			if (timeout) clearTimeout(timeout)
		}
	}

	injectPendingNotificationsIntoPrompt(prompt: { text?: string }, sessionID: string): void {
		const pending = this.pendingNotifications.get(sessionID)
		if (!pending || pending.length === 0) return

		this.pendingNotifications.delete(sessionID)
		const notificationText = pending.join("\n\n")
		prompt.text = `${notificationText}\n\n${prompt.text ?? ""}`
	}

	private markRetrieved(id: string, readerSessionID: string): DelegationRecord | undefined {
		return this.updateDelegation(id, (delegation, now) => {
			delegation.retrieval.retrievedAt = now
			delegation.retrieval.retrievalCount += 1
			delegation.retrieval.lastReaderSessionID = readerSessionID
		})
	}

	private hasUnreadCompletion(delegation: DelegationRecord): boolean {
		if (!isTerminalStatus(delegation.status)) return false
		if (!delegation.notification.terminalNotifiedAt) return false
		if (!delegation.completedAt) return false

		if (!delegation.retrieval.retrievedAt) return true
		return delegation.retrieval.retrievedAt.getTime() < delegation.completedAt.getTime()
	}

	private async waitForTerminal(id: string, timeoutMs: number): Promise<"terminal" | "timeout"> {
		const delegation = this.delegations.get(id)
		if (!delegation) return "timeout"
		if (isTerminalStatus(delegation.status)) return "terminal"

		const waiter = this.terminalWaiters.get(id)
		if (!waiter) return "timeout"

		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			const result = await Promise.race<"terminal" | "timeout">([
				waiter.promise.then(() => "terminal"),
				new Promise<"timeout">((resolve) => {
					timer = setTimeout(() => resolve("timeout"), timeoutMs)
				}),
			])
			return result
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	private async generateUniqueDelegationId(artifactDir: string): Promise<string> {
		for (let attempt = 0; attempt < 20; attempt++) {
			const candidate = this.idGenerator()
			if (this.delegations.has(candidate)) continue

			const candidatePath = path.join(artifactDir, `${candidate}.md`)
			try {
				await fs.access(candidatePath)
			} catch {
				return candidate
			}
		}

		throw new Error("Failed to generate unique delegation ID after 20 attempts")
	}

	private getDelegationBySession(sessionID: string): DelegationRecord | undefined {
		const delegationId = this.delegationsBySession.get(sessionID)
		if (!delegationId) return undefined
		return this.delegations.get(delegationId)
	}

	private isVisibleToSession(delegation: DelegationRecord, rootSessionID: string): boolean {
		return delegation.rootSessionID === rootSessionID
	}

	private buildTerminalNotification(delegation: DelegationRecord, remainingCount: number): string {
		const esc = escapeXmlText
		const lines = [
			"<task-notification>",
			`<task-id>${esc(delegation.id)}</task-id>`,
			`<status>${esc(delegation.status)}</status>`,
			`<summary>Background agent ${esc(delegation.status)}: ${esc(delegation.title || delegation.id)}</summary>`,
			delegation.title ? `<title>${esc(delegation.title)}</title>` : "",
			delegation.description ? `<description>${esc(delegation.description)}</description>` : "",
			delegation.error ? `<error>${esc(delegation.error)}</error>` : "",
			`<artifact>${esc(delegation.artifact.filePath)}</artifact>`,
			`<retrieval>Use delegation_read("${esc(delegation.id)}") for full output.</retrieval>`,
			remainingCount > 0 ? `<remaining>${remainingCount}</remaining>` : "",
			"</task-notification>",
		]

		return lines.filter((line) => line.length > 0).join("\n")
	}

	private buildAllCompleteNotification(
		parentSessionID: string,
		cycle: number,
		cycleToken: string,
	): string {
		const esc = DelegationManager.escapeXmlText
		// cycle-token is a boundary watermark.
		// Receivers should ignore all-complete payloads whose token is older than
		// the latest known registration cycle for this parent session.
		return [
			"<task-notification>",
			"<type>all-complete</type>",
			"<status>completed</status>",
			"<summary>All delegations complete.</summary>",
			`<parent-session-id>${esc(parentSessionID)}</parent-session-id>`,
			`<cycle>${cycle}</cycle>`,
			`<cycle-token>${esc(cycleToken)}</cycle-token>`,
			"</task-notification>",
		].join("\n")
	}

	private buildDeterministicTerminalReadResponse(delegation: DelegationRecord): string {
		const lines = [
			`Delegation ID: ${delegation.id}`,
			`Status: ${delegation.status}`,
			`Agent: ${delegation.agent}`,
			`Started: ${delegation.startedAt?.toISOString() || delegation.createdAt.toISOString()}`,
			`Completed: ${delegation.completedAt?.toISOString() || "N/A"}`,
			`Artifact: ${delegation.artifact.filePath}`,
		]

		if (delegation.title) lines.push(`Title: ${delegation.title}`)
		if (delegation.description) lines.push(`Description: ${delegation.description}`)
		if (delegation.error) lines.push(`Error: ${delegation.error}`)

		lines.push(`\nUse delegation_read("${delegation.id}") again after persistence completes.`)
		return lines.join("\n")
	}

	private async readPersistedArtifact(filePath: string): Promise<string | null> {
		try {
			return await fs.readFile(filePath, "utf8")
		} catch {
			return null
		}
	}

	private async waitForPersistedArtifact(
		filePath: string,
		maxWaitMs: number,
	): Promise<string | null> {
		const start = Date.now()
		while (Date.now() - start < maxWaitMs) {
			const content = await this.readPersistedArtifact(filePath)
			if (content !== null) return content
			await new Promise((resolve) => setTimeout(resolve, this.readPollIntervalMs))
		}

		return null
	}

	private async resolveDelegationResult(delegation: DelegationRecord): Promise<string> {
		if (delegation.status === "error") {
			return `Error: ${delegation.error || "Delegation failed."}`
		}

		if (delegation.status === "cancelled") {
			return "Delegation was cancelled before completion."
		}

		if (delegation.status === "timeout") {
			const partial = await this.getResult(delegation)
			return `${partial}\n\n[TIMEOUT REACHED]`
		}

		return await this.getResult(delegation)
	}

	private async finalizeDelegation(
		delegationId: string,
		status: DelegationTerminalStatus,
		error?: string,
	): Promise<void> {
		const { transitioned, delegation } = this.markTerminal(delegationId, status, error)
		if (!transitioned || !delegation) return

		await this.debugLog(`finalizeDelegation(${delegation.id}, ${status}) started`)

		const resolvedResult = await this.resolveDelegationResult(delegation)
		delegation.result = resolvedResult

		if (resolvedResult.trim().length > 0) {
			const metadata = await this.metadataGenerator(
				this.ctx,
				resolvedResult,
				delegation.sessionID,
				(msg) => this.debugLog(msg),
			)
			delegation.title = metadata.title
			delegation.description = metadata.description
		}

		await this.persistOutput(delegation, resolvedResult)
		await this.notifyParent(delegation.id)
	}

	private async notifyParent(delegationId: string): Promise<void> {
		try {
			const delegation = this.delegations.get(delegationId)
			if (!delegation) return
			if (!isTerminalStatus(delegation.status)) return
			if (delegation.notification.terminalNotifiedAt) {
				await this.debugLog(`notifyParent skipped for ${delegation.id}; already notified`)
				return
			}

			const remainingCount = this.getPendingCount(delegation.parentSessionID)
			const terminalNotification = this.buildTerminalNotification(delegation, remainingCount)

			const deliveryStatus = await this.sendParentNotification(
				delegation.parentSessionID,
				terminalNotification,
				true,
			)

			this.markNotified(delegation.id)
			this.scheduleAllCompleteForParent(delegation.parentSessionID)

			await this.debugLog(
				`notifyParent ${deliveryStatus} for ${delegation.id} (remaining=${remainingCount}, status=${delegation.status})`,
			)
		} catch (error) {
			await this.debugLog(
				`notifyParent failed for ${delegationId}: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
		}
	}

	/**
	 * Delegate a task to an agent
	 */
	async delegate(input: DelegateInput): Promise<DelegationRecord> {
		// Validate agent exists before creating session
		const agents = normalizeAgentList(await this.ctx.agent.list())
		// WHY id-first: V2 identity is the id ("explore"), while name is the display
		// label ("Explore"); delegating by name alone would miss valid agents.
		const validAgent =
			agents.find((a) => a.id === input.agent) ??
			agents.find((a) => a.name?.toLowerCase() === input.agent.toLowerCase())

		if (!validAgent) {
			const available = agents
				.filter((a) => a.mode === "subagent" || a.mode === "all" || !a.mode)
				.map((a) => `• ${a.name}${a.description ? ` - ${a.description}` : ""}`)
				.join("\n")

			throw new Error(
				`Agent "${input.agent}" not found.\n\nAvailable agents:\n${available || "(none)"}`,
			)
		}

		// Check if agent is read-only (Early Exit + Fail Fast)
		const { isReadOnly } = parseAgentWriteCapability(validAgent.permissions ?? [], this.log)
		if (!isReadOnly) {
			throw new Error(
				`Agent "${input.agent}" is write-capable and requires the native \`subagent\` tool for proper undo/branching support.\n\n` +
					`Use \`subagent\` instead of \`delegate\` for write-capable agents.\n\n` +
					`Read-only sub-agents (edit/write/shell denied) use \`delegate\`.\n` +
					`Write-capable sub-agents (any write permission) use \`subagent\`.`,
			)
		}

		const artifactDir = await this.ensureDelegationsDir(input.parentSessionID)
		const rootSessionID = await this.getRootSessionID(input.parentSessionID)
		const stableId = await this.generateUniqueDelegationId(artifactDir)
		const artifactPath = path.join(artifactDir, `${stableId}.md`)

		await this.debugLog(`delegate() called, generated stable ID: ${stableId}`)

		// Create isolated session for delegation
		const session = await this.ctx.session.create({
			title: `Delegation: ${stableId}`,
			parentID: input.parentSessionID,
			// WHY agent on create: V2 has no per-prompt agent override; the session's
			// agent decides which agent config (and thus permissions) the run uses.
			agent: input.agent,
		})

		await this.debugLog(`session.create result: ${JSON.stringify(session)}`)

		if (!session?.id) {
			throw new Error("Failed to create delegation session")
		}

		const delegation = this.registerDelegation({
			id: stableId,
			rootSessionID,
			sessionID: session.id,
			parentSessionID: input.parentSessionID,
			parentMessageID: input.parentMessageID,
			parentAgent: input.parentAgent,
			prompt: input.prompt,
			agent: input.agent,
			artifactPath,
		})

		await this.debugLog(`Registered delegation ${delegation.id} before execution`)
		this.scheduleTimeout(delegation.id)
		this.markStarted(delegation.id)

		// Fire the prompt. In V2, session.prompt() durably admits the input and
		// schedules the agent loop, so it resolves at admission, not completion —
		// completion is handled by session events (see handleSessionIdle).
		// The V1 `tools` override has no V2 equivalent; anti-recursion relies on
		// the delegated agent's own permissions.
		this.ctx.session
			.prompt({
				sessionID: delegation.sessionID,
				text: input.prompt,
			})
			.catch((error: Error) => {
				void this.finalizeDelegation(delegation.id, "error", error.message)
			})

		return delegation
	}

	/**
	 * Handle delegation timeout
	 */
	private async handleTimeout(delegationId: string): Promise<void> {
		const delegation = this.delegations.get(delegationId)
		if (!delegation || isTerminalStatus(delegation.status)) return

		await this.debugLog(`handleTimeout for delegation ${delegation.id}`)

		// Try to cancel the session
		try {
			await this.ctx.session.remove({ sessionID: delegation.sessionID })
		} catch {
			// Ignore
		}

		await this.finalizeDelegation(
			delegation.id,
			"timeout",
			`Delegation timed out after ${this.maxRunTimeMs / 1000}s`,
		)
	}

	/**
	 * Handle session.idle event - called when a session becomes idle
	 */
	async handleSessionIdle(sessionID: string): Promise<void> {
		const delegation = this.findBySession(sessionID)
		if (!delegation || isTerminalStatus(delegation.status)) return

		await this.debugLog(`handleSessionIdle for delegation ${delegation.id}`)
		await this.finalizeDelegation(delegation.id, "complete")
	}

	/**
	 * Handle session.execution.failed / session.execution.interrupted events
	 */
	async handleSessionExecutionError(sessionID: string, message: string): Promise<void> {
		const delegation = this.findBySession(sessionID)
		if (!delegation || isTerminalStatus(delegation.status)) return

		await this.debugLog(`handleSessionExecutionError for delegation ${delegation.id}: ${message}`)
		await this.finalizeDelegation(delegation.id, "error", message)
	}

	/**
	 * Get the result from a delegation's session
	 */
	private async getResult(delegation: DelegationRecord): Promise<string> {
		try {
			const messages = await this.ctx.session.context({ sessionID: delegation.sessionID })

			if (!messages || messages.length === 0) {
				await this.debugLog(`getResult: No messages found for session ${delegation.sessionID}`)
				return `Delegation "${delegation.description}" completed but produced no output.`
			}

			await this.debugLog(
				`getResult: Found ${messages.length} messages. Types: ${messages.map((m) => m.type).join(", ")}`,
			)

			// Find the last message from the assistant/model
			const assistantMessages = messages.filter((m) => m.type === "assistant")

			if (assistantMessages.length === 0) {
				await this.debugLog(
					`getResult: No assistant messages found in ${JSON.stringify(messages.map((m) => ({ type: m.type, keys: Object.keys(m) })))}`,
				)
				return `Delegation "${delegation.description}" completed but produced no assistant response.`
			}

			const lastMessage = assistantMessages[assistantMessages.length - 1]

			// Extract text items from the message
			const textItems = (lastMessage.content ?? []).filter(
				(item) => item.type === "text" && typeof item.text === "string",
			)

			if (textItems.length === 0) {
				await this.debugLog(
					`getResult: No text content found in message: ${JSON.stringify(lastMessage)}`,
				)
				return `Delegation "${delegation.description}" completed but produced no text content.`
			}

			return textItems.map((item) => item.text).join("\n")
		} catch (error) {
			await this.debugLog(
				`getResult error: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
			return `Delegation "${delegation.description}" completed but result could not be retrieved: ${
				error instanceof Error ? error.message : "Unknown error"
			}`
		}
	}

	/**
	 * Persist delegation output to storage
	 */
	private async persistOutput(delegation: DelegationRecord, content: string): Promise<void> {
		try {
			// Use title/description if available (generated by small model), otherwise fallback
			const title = delegation.title || delegation.id
			const description = delegation.description || "(No description generated)"

			const header = `# ${title}

${description}

**ID:** ${delegation.id}
**Agent:** ${delegation.agent}
**Status:** ${delegation.status}
**Session:** ${delegation.sessionID}
**Started:** ${(delegation.startedAt || delegation.createdAt).toISOString()}
**Completed:** ${delegation.completedAt?.toISOString() || "N/A"}

---

`
			await fs.writeFile(delegation.artifact.filePath, header + content, "utf8")

			const stats = await fs.stat(delegation.artifact.filePath)
			this.updateDelegation(delegation.id, (record, now) => {
				record.artifact.persistedAt = now
				record.artifact.byteLength = stats.size
				record.artifact.persistError = undefined
			})

			await this.debugLog(`Persisted output to ${delegation.artifact.filePath}`)
		} catch (error) {
			this.updateDelegation(delegation.id, (record) => {
				record.artifact.persistError =
					error instanceof Error ? error.message : "Unknown persistence error"
			})
			await this.debugLog(
				`Failed to persist output: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
		}
	}

	/**
	 * Read a delegation's output by ID. Blocks if the delegation is still running.
	 */
	async readOutput(sessionID: string, id: string): Promise<string> {
		const normalizedId = normalizeId(id)

		const rootSessionID = await this.getRootSessionID(sessionID)
		let delegation = this.delegations.get(normalizedId)
		if (delegation && !this.isVisibleToSession(delegation, rootSessionID)) {
			delegation = undefined
		}

		const fallbackFilePath = resolveInsideDir(
			await this.getDelegationsDir(sessionID),
			`${normalizedId}.md`,
		)

		const immediateArtifactPath = delegation?.artifact.filePath || fallbackFilePath
		const immediateRead = await this.readPersistedArtifact(immediateArtifactPath)
		if (immediateRead !== null) {
			if (delegation) this.markRetrieved(delegation.id, sessionID)
			return immediateRead
		}

		if (!delegation) {
			throw new Error(
				`Delegation "${normalizedId}" not found.\n\nUse delegation_list() to see available delegations.`,
			)
		}

		if (isActiveStatus(delegation.status)) {
			const remainingMs = Math.max(
				delegation.timeoutAt.getTime() - Date.now() + this.terminalWaitGraceMs,
				this.readPollIntervalMs,
			)

			await this.debugLog(
				`readOutput: waiting up to ${remainingMs}ms for delegation ${delegation.id} to reach terminal state`,
			)

			const waitResult = await this.waitForTerminal(delegation.id, remainingMs)
			if (waitResult === "timeout" && isActiveStatus(delegation.status)) {
				await this.handleTimeout(delegation.id)
			}
		}

		if (isTerminalStatus(delegation.status)) {
			const delayedPersisted = await this.waitForPersistedArtifact(
				delegation.artifact.filePath,
				Math.max(this.readPollIntervalMs * 8, 500),
			)
			if (delayedPersisted !== null) {
				this.markRetrieved(delegation.id, sessionID)
				return delayedPersisted
			}
		}

		const persisted = await this.readPersistedArtifact(delegation.artifact.filePath)
		if (persisted !== null) {
			this.markRetrieved(delegation.id, sessionID)
			return persisted
		}

		if (isTerminalStatus(delegation.status)) {
			return this.buildDeterministicTerminalReadResponse(delegation)
		}

		return `Delegation "${delegation.id}" is still running. You will receive a <task-notification> when it reaches a terminal state.`
	}

	/**
	 * List all delegations for a session
	 */
	async listDelegations(sessionID: string): Promise<DelegationListItem[]> {
		const rootSessionID = await this.getRootSessionID(sessionID)
		const results: DelegationListItem[] = []

		// Add in-memory delegations in this root session scope
		for (const delegation of this.delegations.values()) {
			if (!this.isVisibleToSession(delegation, rootSessionID)) continue

			results.push({
				id: delegation.id,
				status: delegation.status,
				title: delegation.title || delegation.id,
				description:
					delegation.description ||
					(delegation.status === "running" || delegation.status === "registered"
						? "(running)"
						: "(no description)"),
				agent: delegation.agent,
				unread: this.hasUnreadCompletion(delegation),
			})
		}

		// Check filesystem for persisted delegations
		try {
			const dir = await this.getDelegationsDir(rootSessionID)
			const files = await fs.readdir(dir)

			for (const file of files) {
				if (file.endsWith(".md")) {
					const id = file.replace(".md", "")
					// Deduplicate: prioritize in-memory status
					if (!results.find((r) => r.id === id)) {
						// Try to read title, agent, description from file
						let title = "(loaded from storage)"
						let description = ""
						let agent: string | undefined
						let status: DelegationStatus = "complete"
						try {
							const filePath = path.join(dir, file)
							const content = await fs.readFile(filePath, "utf8")
							const titleMatch = content.match(/^# (.+)$/m)
							if (titleMatch) title = titleMatch[1]
							const agentMatch = content.match(/^\*\*Agent:\*\* (.+)$/m)
							if (agentMatch) agent = agentMatch[1]
							const statusMatch = content.match(/^\*\*Status:\*\* (.+)$/m)
							status = parsePersistedStatus(statusMatch?.[1]?.trim())
							// Get first paragraph after title as description
							const lines = content.split("\n")
							if (lines.length > 2 && lines[2]) {
								description = lines[2].slice(0, 150)
							}
						} catch {
							// Ignore read errors
						}
						results.push({
							id,
							status,
							title,
							description,
							agent,
							unread: false,
						})
					}
				}
			}
		} catch {
			// Directory may not exist yet
		}

		results.sort((a, b) => a.id.localeCompare(b.id))
		return results
	}

	/**
	 * Delete a delegation by id (cancels if running, removes from storage)
	 * Used internally for cleanup (timeout, etc.)
	 */
	async deleteDelegation(sessionID: string, id: string): Promise<boolean> {
		const normalizedId = normalizeId(id)
		const delegation = this.delegations.get(normalizedId)

		if (delegation) {
			if (isActiveStatus(delegation.status)) {
				try {
					await this.ctx.session.remove({ sessionID: delegation.sessionID })
				} catch {
					// Session may already be deleted
				}
				this.markTerminal(delegation.id, "cancelled", "Delegation deleted by cleanup")
			}

			this.clearTimeoutTimer(delegation.id)
			this.terminalWaiters.delete(delegation.id)
			this.delegationsBySession.delete(delegation.sessionID)
			this.delegations.delete(delegation.id)
		}

		// Remove from filesystem
		try {
			const dir = await this.getDelegationsDir(sessionID)
			const filePath = resolveInsideDir(dir, `${normalizedId}.md`)
			await fs.unlink(filePath)
			return true
		} catch {
			return false
		}
	}

	/**
	 * Find a delegation by its session ID
	 */
	findBySession(sessionID: string): DelegationRecord | undefined {
		return this.getDelegationBySession(sessionID)
	}

	/**
	 * Handle message events for progress tracking
	 */
	handleMessageEvent(sessionID: string, messageText?: string): void {
		const delegation = this.findBySession(sessionID)
		if (!delegation) return
		this.markProgress(delegation.id, messageText)
	}

	/**
	 * Get count of pending delegations for a parent session
	 */
	getPendingCount(parentSessionID: string): number {
		const pendingSet = this.pendingByParent.get(parentSessionID)
		if (!pendingSet) return 0
		return Array.from(pendingSet).filter((id) => {
			const delegation = this.delegations.get(id)
			return delegation ? isActiveStatus(delegation.status) : false
		}).length
	}

	/**
	 * Get all currently running delegations (in-memory only)
	 */
	getRunningDelegations(rootSessionID?: string): DelegationRecord[] {
		return Array.from(this.delegations.values()).filter((delegation) => {
			if (rootSessionID && delegation.rootSessionID !== rootSessionID) return false
			return isActiveStatus(delegation.status)
		})
	}

	getUnreadCompletedDelegations(rootSessionID: string, limit = 10): DelegationRecord[] {
		return Array.from(this.delegations.values())
			.filter((delegation) => delegation.rootSessionID === rootSessionID)
			.filter((delegation) => this.hasUnreadCompletion(delegation))
			.sort((a, b) => {
				const aTime = a.completedAt?.getTime() || 0
				const bTime = b.completedAt?.getTime() || 0
				return bTime - aTime
			})
			.slice(0, limit)
	}

	/**
	 * Get recent completed delegations for compaction injection
	 */
	async getRecentCompletedDelegations(
		sessionID: string,
		limit: number = 10,
	): Promise<DelegationListItem[]> {
		const all = await this.listDelegations(sessionID)
		return all.filter((d) => isTerminalStatus(d.status)).slice(-limit)
	}

	/**
	 * Log debug messages
	 */
	async debugLog(msg: string): Promise<void> {
		// Only log if debug is enabled (could be env var or static const)
		// For now, mirroring previous behavior but writing to the new baseDir/debug.log
		const timestamp = new Date().toISOString()
		const line = `${timestamp}: ${msg}\n`
		const debugFile = path.join(this.baseDir, "background-agents-debug.log")

		try {
			await fs.appendFile(debugFile, line, "utf8")
		} catch {
			// Ignore errors, try to ensure dir once if it fails?
			// Simpler to just ignore for debug logs
		}
	}
}

// ==========================================
// TOOL CREATORS
// ==========================================

interface DelegateArgs {
	prompt: string
	agent: string
}

/** V2 tool execute context (subset used here). */
interface ToolExecuteContext {
	sessionID?: string
	messageID?: string
	agent?: string
	id?: string
}

/** V2 tool registration shape expected by ctx.tool.transform editor.add(). */
interface ToolRegistration {
	name: string
	description: string
	input: Record<string, unknown>
	execute: (args: never, context: ToolExecuteContext) => Promise<{ content: string }>
}

function createDelegate(manager: DelegationManager): ToolRegistration {
	const registration: ToolRegistration = {
		name: "delegate",
		description: `Delegate a task to an agent. Returns immediately with a readable ID.

Use this for:
- Research tasks (will be auto-saved)
- Parallel work that can run in background
- Any task where you want persistent, retrievable output

On completion, a notification will arrive with the ID and terminal summary.
Use \`delegation_read\` with the ID to retrieve full persisted output (including after compaction).`,
		input: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description: "The full detailed prompt for the agent. Must be in English.",
				},
				agent: {
					type: "string",
					description:
						'Agent to delegate to. Must be a read-only sub-agent (edit/write/shell denied), such as "researcher" or "explore".',
				},
			},
			required: ["prompt", "agent"],
			additionalProperties: false,
		},
		async execute(args: DelegateArgs, context: ToolExecuteContext): Promise<{ content: string }> {
			if (!context?.sessionID) {
				return { content: "❌ delegate requires sessionID. This is a system error." }
			}
			if (!context?.messageID) {
				return { content: "❌ delegate requires messageID. This is a system error." }
			}

			try {
				const delegation = await manager.delegate({
					parentSessionID: context.sessionID,
					parentMessageID: context.messageID,
					parentAgent: context.agent ?? "",
					prompt: args.prompt,
					agent: args.agent,
				})

				// Get total active count for this parent session
				const totalActive = manager.getPendingCount(context.sessionID)

				let response = `Delegation started: ${delegation.id}\nAgent: ${args.agent}`
				if (totalActive > 1) {
					response += `\n\n${totalActive} delegations now active.`
				}
				response += `\nYou WILL be notified when ${totalActive > 1 ? "ALL complete" : "complete"}. Do NOT poll.`

				return { content: response }
			} catch (error) {
				// Return validation errors as guidance, not exceptions
				return {
					content: `❌ Delegation failed:\n\n${error instanceof Error ? error.message : "Unknown error"}`,
				}
			}
		},
	}
	return registration
}

function createDelegationRead(manager: DelegationManager): ToolRegistration {
	return {
		name: "delegation_read",
		description: `Read the output of a delegation by its ID.
Use this to retrieve results from delegated tasks if the inline notification was lost during compaction.`,
		input: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "The delegation ID (e.g., 'elegant-blue-tiger')",
				},
			},
			required: ["id"],
			additionalProperties: false,
		},
		async execute(args: { id: string }, context: ToolExecuteContext): Promise<{ content: string }> {
			if (!context?.sessionID) {
				return { content: "❌ delegation_read requires sessionID. This is a system error." }
			}

			return { content: await manager.readOutput(context.sessionID, args.id) }
		},
	}
}

function createDelegationList(manager: DelegationManager): ToolRegistration {
	return {
		name: "delegation_list",
		description: `List all delegations for the current session.
Shows both running and completed delegations.`,
		input: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		async execute(_args: Record<string, never>, context: ToolExecuteContext): Promise<{ content: string }> {
			if (!context?.sessionID) {
				return { content: "❌ delegation_list requires sessionID. This is a system error." }
			}

			const delegations = await manager.listDelegations(context.sessionID)

			if (delegations.length === 0) {
				return { content: "No delegations found for this session." }
			}

			const lines = delegations.map((d) => {
				const titlePart = d.title ? ` | ${d.title}` : ""
				const unreadPart = d.unread ? " [unread]" : ""
				const descPart = d.description ? `\n  → ${d.description}` : ""
				return `- **${d.id}**${titlePart} [${d.status}]${unreadPart}${descPart}`
			})

			return { content: `## Delegations\n\n${lines.join("\n")}` }
		},
	}
}

// ==========================================
// DELEGATION RULES (injected into system prompt)
// ==========================================

const DELEGATION_RULES = `<task-notification>
<delegation-system>

## Async Delegation

You have tools for parallel background work:
- \`delegate(prompt, agent)\` - Launch task, returns ID immediately
- \`delegation_read(id)\` - Retrieve completed result
- \`delegation_list()\` - List delegations (use sparingly)

## Delegation Routing

Agents route based on their permissions:

| Agent Type | Tool | Why |
|------------|------|-----|
| Read-only sub-agents (edit/write/shell denied) | \`delegate\` | Background session, async |
| Write-capable sub-agents (any write permission) | \`subagent\` | Native subagent, preserves undo/branching |

**Read-only sub-agents** have edit="deny", write="deny", shell={"*":"deny"}.
**Write-capable sub-agents** have any write tool enabled.

## How It Works

1. For read-only sub-agents: Call \`delegate\` with detailed prompt
2. For write-capable sub-agents: Call \`subagent\` with detailed prompt
3. Continue productive work while it runs
4. Receive notification when complete
5. Call \`delegation_read(id)\` to retrieve results

## Critical Constraints

**NEVER poll \`delegation_list\` to check completion.**
You WILL be notified via \`<task-notification>\`. Polling wastes tokens.

**NEVER wait idle.** Always have productive work while delegations run.

**Using wrong tool will fail fast with guidance.**

</delegation-system>
</task-notification>`

// ==========================================
// COMPACTION CONTEXT FORMATTING
// ==========================================

interface DelegationForContext {
	id: string
	agent?: string
	title?: string
	description?: string
	status: DelegationStatus
	startedAt?: Date
	completedAt?: Date
	lastHeartbeatAt?: Date
	prompt?: string
}

/**
 * Format delegation context for injection during compaction.
 * Includes running delegations with notification reminder (only when running exist),
 * and recent completed delegations with full descriptions.
 */
function formatDelegationContext(
	running: DelegationForContext[],
	unreadCompleted: DelegationForContext[],
): string {
	const sections: string[] = ["<delegation-context>"]

	// Running delegations (if any)
	if (running.length > 0) {
		sections.push("## Running Delegations")
		sections.push("")
		for (const d of running) {
			sections.push(`### \`${d.id}\`${d.agent ? ` (${d.agent})` : ""}`)
			if (d.startedAt) {
				sections.push(`**Started:** ${d.startedAt.toISOString()}`)
			}
			if (d.lastHeartbeatAt) {
				sections.push(`**Last heartbeat:** ${d.lastHeartbeatAt.toISOString()}`)
			}
			if (d.prompt) {
				const truncatedPrompt = d.prompt.length > 200 ? `${d.prompt.slice(0, 200)}...` : d.prompt
				sections.push(`**Prompt:** ${truncatedPrompt}`)
			}
			sections.push("")
		}

		// Only include reminder when there ARE running delegations
		sections.push(
			"> **Note:** You WILL be notified via `<task-notification>` when delegations complete.",
		)
		sections.push("> Do NOT poll `delegation_list` - continue productive work.")
		sections.push("")
	}

	// Unread completed delegations (recent)
	if (unreadCompleted.length > 0) {
		sections.push("## Unread Completed Delegations")
		sections.push("")
		for (const d of unreadCompleted) {
			const statusEmoji =
				d.status === "complete"
					? "✅"
					: d.status === "error"
						? "❌"
						: d.status === "timeout"
							? "⏱️"
							: "🚫"
			sections.push(`### ${statusEmoji} \`${d.id}\``)
			sections.push(`**Title:** ${d.title || "(no title)"}`)
			sections.push(`**Status:** ${d.status}`)
			sections.push(`**Description:** ${d.description || "(no description)"}`)
			if (d.completedAt) {
				sections.push(`**Completed:** ${d.completedAt.toISOString()}`)
			}
			sections.push(`**Retrieve:** \`delegation_read("${d.id}")\``)
			sections.push("")
		}
		sections.push("> These are unread terminal delegations carried forward through compaction.")
		sections.push("")
	}

	sections.push("## Retrieval")
	sections.push('Use `delegation_read("id")` to access full delegation output.')
	sections.push("Do not poll delegation_list for completion; rely on task notifications.")
	sections.push("</delegation-context>")

	return sections.join("\n")
}

// ==========================================
// PLUGIN EXPORT
// ==========================================

const BackgroundAgentsPluginWithInternals = Object.assign(
	Plugin.define({
		id: "background-agents",
		async setup(ctx) {
			const directory = ctx.location.directory

			// Console-backed logger (V1 logged through the client SDK; V2 plugins log locally)
			const log: Logger = {
				debug: (msg: string) => console.debug(msg),
				info: (msg: string) => console.info(msg),
				warn: (msg: string) => console.warn(msg),
				error: (msg: string) => console.error(msg),
			}

			// Project-level storage directory (shared across sessions)
			// Uses git root commit hash for cross-worktree consistency
			const projectId = await getProjectId(directory)
			const baseDir = path.join(
				os.homedir(),
				".local",
				"share",
				"opencode",
				"delegations",
				projectId,
			)

			// Ensure base directory exists (for debug logs etc)
			await fs.mkdir(baseDir, { recursive: true })

			const manager = new DelegationManager(ctx, baseDir, log)

			await manager.debugLog("BackgroundAgentsPlugin initialized with delegation system")

			await ctx.tool.transform((editor) => {
				editor.add(createDelegate(manager))
				editor.add(createDelegationRead(manager))
				editor.add(createDelegationList(manager))
			})

			// Prevent read-only agents from using the native subagent tool (symmetric to delegate enforcement)
			await ctx.tool.hook("execute.before", async (event) => {
				// Guard: Only intercept the native subagent tool ("task" is the legacy name)
				if (event.tool !== "subagent" && event.tool !== "task") return

				// Guard: Require agent name
				const args = event.input as { subagent_type?: string; agent?: string } | undefined
				const agentName = args?.subagent_type ?? args?.agent
				if (!agentName) return

				// Parse boundary 1: Check agent mode
				const { isSubAgent, permissions } = await parseAgentMode(ctx, agentName, log)

				// Guard: Allow non-sub-agents (main/built-in)
				if (!isSubAgent) return

				// Parse boundary 2: Check write capability (only for sub-agents)
				const { isReadOnly } = parseAgentWriteCapability(permissions, log)

				// Guard: Allow write-capable agents
				if (!isReadOnly) return

				// Fail fast: Read-only sub-agent via subagent tool is invalid
				throw new Error(
					`❌ Agent '${agentName}' is read-only and should use the delegate tool for async background execution.\n\n` +
						`Read-only agents have: edit="deny", write="deny", shell={"*":"deny"}\n` +
						`Use delegate for read-only sub-agents.\n` +
						`Use subagent for write-capable sub-agents.`,
				)
			})

			// Inject delegation rules into the system prompt
			await ctx.session.hook("context", (event) => {
				event.system.push({ type: "text", text: DELEGATION_RULES })
			})

			// Deliver queued parent notifications on the next user turn if direct delivery failed.
			await ctx.session.hook("prompt", (event) => {
				if (!event?.sessionID || !event.prompt) return
				manager.injectPendingNotificationsIntoPrompt(event.prompt, event.sessionID)
			})

			// Compaction hook - inject delegation context for context recovery
			await ctx.session.hook("compaction", async (event) => {
				const rootSessionID = await manager.getRootSessionID(event.sessionID)

				// Running delegations in this root session tree
				const running = manager.getRunningDelegations(rootSessionID).map((d) => ({
					id: d.id,
					agent: d.agent,
					title: d.title,
					description: d.description,
					status: d.status,
					startedAt: d.startedAt,
					lastHeartbeatAt: d.progress.lastHeartbeatAt,
					prompt: d.prompt,
				}))

				// Unread completed delegations to carry forward through compaction
				const unreadCompleted = manager
					.getUnreadCompletedDelegations(rootSessionID, 10)
					.map((d) => ({
						id: d.id,
						agent: d.agent,
						title: d.title,
						description: d.description,
						status: d.status,
						completedAt: d.completedAt,
					}))

				// Early exit if nothing to inject
				if (running.length === 0 && unreadCompleted.length === 0) return

				event.system.push({
					type: "text",
					text: formatDelegationContext(running, unreadCompleted),
				})
			})

			// Event subscription (V2 replacement for the V1 `event` handler)
			const controller = new AbortController()
			void (async () => {
				for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
					const runtimeEvent = event as { type: string; data?: Record<string, unknown> }
					const data = runtimeEvent.data ?? {}

					switch (runtimeEvent.type) {
						case "session.idle":
						case "session.execution.succeeded": {
							const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
							if (sessionID) await manager.handleSessionIdle(sessionID)
							break
						}
						case "session.execution.failed": {
							const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
							const error = data.error as { message?: unknown } | undefined
							const message =
								typeof error?.message === "string" ? error.message : "Session execution failed"
							if (sessionID) await manager.handleSessionExecutionError(sessionID, message)
							break
						}
						case "session.execution.interrupted": {
							const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
							if (sessionID)
								await manager.handleSessionExecutionError(sessionID, "Session interrupted")
							break
						}
						case "session.step.started": {
							const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
							if (sessionID) manager.handleMessageEvent(sessionID)
							break
						}
						case "session.text.ended": {
							const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
							const text = typeof data.text === "string" ? data.text : undefined
							if (sessionID) manager.handleMessageEvent(sessionID, text)
							break
						}
					}
				}
			})().catch((error) => {
				console.error("[background-agents] event subscription failed", error)
			})

			return () => controller.abort()
		},
	}),
	{
		testInternals: {
			DelegationManager,
			formatDelegationContext,
			normalizeId,
			escapeXmlText,
			resolveInsideDir,
		},
	} as const,
)

export default BackgroundAgentsPluginWithInternals

export { normalizeId, escapeXmlText, resolveInsideDir }
