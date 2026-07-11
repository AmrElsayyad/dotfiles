import { splitHookCommands } from "./plugins/worktree.smoke"

const cases: Record<string, string> = {
	// R8A: NUL-producing ANSI-C escapes (bash truncates each decoded chunk at NUL)
	"A1-oct": "cat <<$'E\\0OF'\ncat it's\nE\nprintf PWNED-A1",
	"A2-hex": "cat <<$'\\x00EOF'\ncat it's\n\nprintf PWNED-A2",
	"A3-uni": "cat <<$'\\u0000EOF'\ncat it's\n\nprintf PWNED-A3",
	"A4-U8": "cat <<$'\\U00000000EOF'\ncat it's\n\nprintf PWNED-A4",
	"A5-cc": "cat <<$'E\\c@OF'\ncat it's\nE\nprintf PWNED-A5",
	"A6-prefix": "cat <<XE$'\\0OF'\ncat it's\nXE\nprintf PWNED-A6",
	"A7-suffix": "cat <<$'E\\0OF'Y\ncat it's\nEY\nprintf PWNED-A7",
	"A8-trail": "cat <<$'EOF\\0'\ncat it's\nEOF\nprintf PWNED-A8",
	"A9-full-neg": "cat <<$'E\\0OF'\nEOF\nE\nprintf PWNED-A9",
	"A10-two": "cat <<$'E\\0\\x00OF'\ncat it's\nE\nprintf PWNED-A10",
	// R8B: chars JS \s rejects that bash keeps
	"B1-cr": "cat <<EOF\r\ncat it's\r\nEOF\r\nprintf PWNED-B1",
	"B2-vt": "cat <<E\u000bOF\ncat it's\nE\u000bOF\nprintf PWNED-B2",
	"B3-ff": "cat <<E\u000cOF\ncat it's\nE\u000cOF\nprintf PWNED-B3",
	"B4-nbsp": "cat <<E\u00a0OF\ncat it's\nE\u00a0OF\nprintf PWNED-B4",
	"B5-u2028": "cat <<E\u2028OF\ncat it's\nE\u2028OF\nprintf PWNED-B5",
	"B6-u2029": "cat <<E\u2029OF\ncat it's\nE\u2029OF\nprintf PWNED-B6",
	"B7-subshell": "(cat <<EOF)\ncat it's\nEOF\nprintf PWNED-B7",
	"B8-close-paren": "cat <<EOF)\ncat it's\nEOF\nprintf PWNED-B8",
	"B9-cr-neg": "cat <<EOF\r\ncat it's\nEOF\nprintf PWNED-B9",
	"B10-crx": "cat <<EOF\rX\ncat it's\nEOF\rX\nprintf PWNED-B10",
	"B11-cr-hash": "cat\r#; printf PWNED-B11",
	"B12-vt-hash": "cat\u000b#; printf PWNED-B12",
	"cm-plain-comment": "echo hi # c\nprintf PWNED-cm",
	// r7 core regression checks
	D9: "cat <<$'EOF'\ncat it's\nEOF\nprintf PWNED-D9",
	D10: "cat <<pwd\ncat body\\\npwd\ncat it's\npwd\nprintf PWNED-D10",
	sub1: "cat <<$(echo EOF)\ncat it's\n$(echo EOF)\nprintf PWNED-sub1",
	bt1: "cat <<`echo EOF`\ncat it's\n`echo EOF`\nprintf PWNED-bt1",
	dqnest: 'cat <<"$(echo "x")"\ncat it\'s\n$(echo x)\nprintf PWNED-dqnest',
	// bash-dead residuals (expected to keep merging only dead text)
	subnl: "cat <<$(echo\nEOF)\ncat it's\nprintf PWNED-subnl",
	innerredir: "cat <<$(echo x <<Y)\ncat it's\nprintf PWNED-innerredir",
	R8C: "cat <<$(echo <<Y )\ncat it's\n$(echo <<Y )\nprintf PWNED-R8C",
}

for (const [name, cmd] of Object.entries(cases)) {
	const pieces = splitHookCommands(cmd)
	const catPwned = pieces.some((p) => p.startsWith("cat ") && p.includes("PWNED"))
	const ownPrintf = pieces.some((p) => !p.startsWith("cat ") && p.includes("PWNED"))
	const verdict = catPwned ? "SILENT-CAT" : ownPrintf ? "SEPARATE" : "OTHER"
	console.log(name, verdict, JSON.stringify(pieces))
}
