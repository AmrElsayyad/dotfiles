type CmuxSessionLogicalState = "animated-busy" | "needs-input" | "error" | "idle"

export type CmuxSessionStatusTransition = {
	readonly sessionID: string
	readonly logicalState: CmuxSessionLogicalState
}

function toNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") return null

	const normalized = value.trim()
	if (!normalized) return null

	return normalized
}

export function buildCmuxSessionStatusTransitionForEvent(
	eventType: string,
	properties: Record<string, unknown>,
): CmuxSessionStatusTransition | null {
	const sessionID = toNonEmptyString(properties.sessionID)
	if (!sessionID) return null

	if (eventType === "permission.asked") {
		return { sessionID, logicalState: "needs-input" }
	}

	switch (eventType) {
		case "session.idle":
		case "session.execution.succeeded":
		case "session.execution.interrupted":
			return { sessionID, logicalState: "idle" }
		case "session.execution.started":
			return { sessionID, logicalState: "animated-busy" }
		case "session.execution.failed":
			return { sessionID, logicalState: "error" }
		default:
			return null
	}
}

export function buildCmuxSessionStatusTransitionForQuestionTool(
	sessionID: unknown,
): CmuxSessionStatusTransition | null {
	const normalizedSessionID = toNonEmptyString(sessionID)
	if (!normalizedSessionID) return null

	return {
		sessionID: normalizedSessionID,
		logicalState: "needs-input",
	}
}

export function getCmuxSessionStatusText(
	logicalState: Exclude<CmuxSessionLogicalState, "idle" | "animated-busy">,
): string {
	if (logicalState === "needs-input") return "Needs input"
	return "Error"
}
