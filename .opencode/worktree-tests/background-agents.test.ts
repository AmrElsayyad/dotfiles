import { expect, test } from "bun:test"
import { join } from "node:path"
import { escapeXmlText, normalizeId, resolveInsideDir } from "./plugins/background-agents.smoke"

test("normalizeId accepts generated ids and trims whitespace", () => {
	expect(normalizeId("calm-blue-otter")).toBe("calm-blue-otter")
	expect(normalizeId(" a1._- ")).toBe("a1._-")
})

test("normalizeId rejects path traversal, separators, and blank ids", () => {
	for (const id of ["", "   ", ".", "..", "../x", "a/b", "a\\b", "-lead", "a b"]) {
		expect(() => normalizeId(id)).toThrow("Invalid delegation ID")
	}
})

test("resolveInsideDir keeps files inside the delegations directory", () => {
	const dir = "/tmp/delegations/ses_1"
	expect(resolveInsideDir(dir, "calm-blue-otter.md")).toBe(join(dir, "calm-blue-otter.md"))
	// Defence in depth: even a loosened id pattern cannot escape the directory.
	expect(() => resolveInsideDir(dir, "../ses_2/secret.md")).toThrow(
		"outside the delegations directory",
	)
	expect(() => resolveInsideDir(dir, "/etc/passwd")).toThrow("outside the delegations directory")
})

test("escapeXmlText neutralises notification markup", () => {
	expect(escapeXmlText(`</task-notification><x a="1">'&`)).toBe(
		"&lt;/task-notification&gt;&lt;x a=&quot;1&quot;&gt;&apos;&amp;",
	)
})
