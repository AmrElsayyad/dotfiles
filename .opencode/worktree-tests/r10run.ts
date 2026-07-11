import { splitHookCommands } from "./plugins/worktree.smoke"

// Round-10 vectors: Family A (substitution-newline trigger), Family B (`\c` at chunk end),
// Family C (CTLESC/CTLNUL meta-quoting of quoted chunks), plus the probe-confirmed variants
// and negatives. Verdict mirrors r9-run.ts: payload text is `PWNED-<name>`.
const cases: Record<string, string> = {
	// Family A: newline inside a $(…)/backtick span must not fire the heredoc trigger.
	R9X: 'cat <<"cat x)" $(echo\ncat x)\ncat it\'s\ncat x)\nprintf PWNED-R9X',
	R9Xbt: 'cat <<"cat x)" `echo\ncat x`\ncat it\'s\ncat x)\nprintf PWNED-R9Xbt',
	R9X2: 'cat <<"pwd)" $(echo\npwd)\ncat it\'s\npwd)\nprintf PWNED-R9X2',
	// R9Xctl: no substitution — bash syntax-errors at EOF (dead text), merge stays accepted.
	R9Xctl: 'cat <<"cat x)" x\ncat x)\ncat it\'s\ncat x)\nprintf PWNED-R9Xctl',
	// Family B: `\c` right before the chunk's closing quote stays literal (`\c`).
	C1: "cat <<$'\\c'\ncat it's\n\\c\nprintf PWNED-C1",
	C1x: "cat <<$'\\c'X\ncat it's\n\\cX\nprintf PWNED-C1x",
	C1m: "cat <<$'a\\c'\ncat it's\na\\c\nprintf PWNED-C1m",
	C1cc: "cat <<$'E\\c\\c'\ncat it's\nE\u001cc\nprintf PWNED-C1cc",
	// negatives (bash-dead): BEL line / plain `c` line / empty line never terminate these words.
	C1nb: "cat <<$'\\c'\ncat it's\n\u0007\nprintf PWNED-C1nb",
	C1nc: "cat <<$'\\c'\ncat it's\nc\nprintf PWNED-C1nc",
	// `\c` followed by another escape: bash masks the literal `\` (probed cc/cq/cn are LIVE);
	// our recursion model mismatches `\c\'` / `\c\n` — tracked finding, expected to merge here.
	CQ: "cat <<$'E\\c\\''\ncat it's\nE\u001c'\nprintf PWNED-CQ",
	CQs: "cat <<$'E\\c\\''\ncat it's\nx'y\nE\u001c'\nprintf PWNED-CQs",
	// CQ2: crafted delimiter (`cat ` + 0x1c + `'`, bash-probed LIVE) whose terminator line
	// starts `cat ` — after our fallback its quote opens there and swallows the payload
	// into a `cat …` piece. Present before AND after this round's fix (unfixed finding).
	CQ2: "cat <<$'cat \\c\\''\nx\ncat \u001c'\nprintf PWNED-CQ2",
	CN: "cat <<$'E\\c\\nOF'\ncat it's\nE\u001cnOF\nprintf PWNED-CN",
	// Family C: quoted-chunk bytes are stored with bash's CTLESC/CTLNUL protection
	// (0x01 -> 01 01, 0x7f -> 01 7f). Terminator lines must carry the doubled bytes.
	X01: "cat <<$'E\\x01OF'\ncat it's\nE\u0001\u0001OF\nprintf PWNED-X01",
	X7F: "cat <<$'E\\x7fOF'\ncat it's\nE\u0001\u007fOF\nprintf PWNED-X7F",
	OCT01: "cat <<$'E\\001OF'\ncat it's\nE\u0001\u0001OF\nprintf PWNED-OCT01",
	RAW01: "cat <<$'E\u0001OF'\ncat it's\nE\u0001\u0001OF\nprintf PWNED-RAW01",
	RAW7F: "cat <<$'E\u007fOF'\ncat it's\nE\u0001\u007fOF\nprintf PWNED-RAW7F",
	DQ01: 'cat <<"E\u0001OF"\ncat it\'s\nE\u0001\u0001OF\nprintf PWNED-DQ01',
	SQ01: "cat <<'E\u0001OF'\ncat it's\nE\u0001\u0001OF\nprintf PWNED-SQ01",
	// letter matrix: `\cA` is 0x01 (protects), `\cB` is 0x02 (raw single byte), `\c@` is NUL.
	CA: "cat <<$'E\\cAOF'\ncat it's\nE\u0001\u0001OF\nprintf PWNED-CA",
	CB: "cat <<$'E\\cBOF'\ncat it's\nE\u0002OF\nprintf PWNED-CB",
	CAT: "cat <<$'E\\c@OF'\ncat it's\nE\nprintf PWNED-CAT",
	// negatives: a single 0x01 line never terminates the protected word (bash-dead), while a
	// plain (unquoted) word char is NOT protected, so its single-0x01 line does terminate.
	X01neg: "cat <<$'E\\x01OF'\ncat it's\nE\u0001OF\nprintf PWNED-X01n",
	PLAIN01: "cat <<E\u0001OF\ncat it's\nE\u0001OF\nprintf PWNED-PLAIN01",
}

for (const [name, cmd] of Object.entries(cases)) {
	const text = cmd.replace(/\u0001/g, "<01>").replace(/\u007f/g, "<7f>").replace(/\u001c/g, "<1c>").replace(/\u0007/g, "<07>")
	const pieces = splitHookCommands(cmd)
	const catPwned = pieces.some((p) => p.startsWith("cat ") && p.includes("PWNED"))
	const ownPrintf = pieces.some((p) => !p.startsWith("cat ") && p.includes("PWNED"))
	const verdict = catPwned ? "SILENT-CAT" : ownPrintf ? "SEPARATE" : "OTHER"
	console.log(
		name.padEnd(10),
		verdict.padEnd(11),
		JSON.stringify(pieces.map((p) => p.replace(/\u0001/g, "<01>").replace(/\u007f/g, "<7f>").replace(/\u001c/g, "<1c>").replace(/\u0007/g, "<07>"))),
	)
}
