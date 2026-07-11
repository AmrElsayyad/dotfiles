# Worktree plugin — open gaps and follow-ups

Companion to `worktree.ts` in this directory (post-review revision, sha256
`fd53c4706c7b29c05ee4f3ca10e7a762d404848b73ca156e495db78df5ae5009`, 2129 lines).
Reproduce/verify material lives in `/home/amr/.opencode/worktree-tests/` (smoke suite,
differential runners, bash marker probes, before/after outputs). The round-10 adversarial
verification of this revision is recorded in section 3 (blocker-class span-tracker findings),
with status updates in sections 1–2; the fix-round cap is reached, so those findings are
accepted residual risk — unaddressed, not accepted-by-design.

## 1. Accepted dead residuals (fallback merge only over text bash never executes)

These shapes still fall back to the line-wise scan and can leave the payload inside a
`cat …` piece, but `touch`-marker probes confirm bash itself never terminates the heredoc
either — the merged text is never executed by bash. Do not "fix" these by weakening the
splitter; the residual is cosmetic (an extra/missed prompt, never a bypass).

| vector | shape | why bash is dead |
|---|---|---|
| `subnl`, `innerredir`, `R8C` | `<<$(echo⏎EOF)`, `<<$(echo x <<Y)`, `<<$(echo <<Y )` | bash fails parsing inside the substitution and runs nothing after it (round 7–8 probes) |
| `R9Xctl` | `<<"cat x)" x⏎cat x)⏎cat it's⏎…` | no substitution; `cat it's` opens an unterminated quote, bash syntax-errors at EOF and runs nothing (r10probes) |
| `C1nb`, `C1nc` | `<<$'\c'` with a BEL (0x07) / plain `c` terminator line | bash's word is literally `\c`; neither line matches, the body runs to EOF (r10probes) |
| `X01neg` | `<<$'E\x01OF'` with a single-0x01 terminator line | the stored word carries the doubled `01 01`; a single-0x01 line never matches (r10probes) |
| `B9-cr-neg` | `<<EOF` + CR before the newline: bash's word is `EOF\r` | the `EOF` line never matches (round 9 probes) |
| `A7E`, `NULAB-0` | round 8–9 negatives | marker probes DEAD (`worktree-tests/probes/bv9f/`) |
| `a-case`, `a-parm`, `c1empty`, `x7fs`, `x7fd`, `cas`, `cbd`, `plain01d`, `dq017f2`, `dqesc01s`, `esc01d`, `src01b`, `srcbt01b`, `sq7fs` | round-10 adversarial re-probes (`bvT/`) | DEAD — rc=2/syntax error or no marker |

Also dead, same reason (bash can never match a terminator line-wise):

- a delimiter that contains a newline byte (raw newline inside a quoted chunk, `$'\n'`);
- a delimiter made of bytes the UTF-8 command string cannot carry (raw high bytes from
  `\xHH`/`\nnn` ≥ 0x80: the stored byte is unprotected, but no command line can reproduce
  it — probed `r10probes5.py`).

Round-10 adversarial markers for the new table row and the section-3 findings live in the
verification workspace `/tmp/user/1000/opencode/typecheck/bvT/` (not yet copied into
`worktree-tests/probes/`).

Over-split only (safe): a `<<` inside arithmetic that is not refused can pick up a bogus
heredoc word; the worst case asserts bash-live text line by line instead of merging.

## 2. Note-only live findings (NOT fixed this round)

### 2a. `\c` whose target starts another escape — real silent shapes exist

bash's `\c` masks the **literal** next character and continues — `$'E\c\''` → `E` 0x1c `'`,
`$'E\c\nOF'` → `E` 0x1c `nOF`, `$'E\c\cX'` → `E` 0x1c `cX` (all probed LIVE, r10probes3/4).
This model instead decodes the escape and reuses its first char (`\'` → 0x07, `\n` → 0x0a,
`\cX` → `X & 0x1f`), so a real terminator line can be missed:

- **`CN` — silent by default (confirmed).** `cat <<$'E\c\nOF'` … terminator `E` 0x1c `nOF` …
  `printf PWNED`. Our word decodes to `E` 0x0a `OF`, never matches; the fallback opens the `'`
  in `cat it's` and swallows the payload into a `cat …` piece while bash runs it. Vector `CN`
  in `r10run.ts` shows SILENT-CAT today; probe `cn-1cn` is LIVE; the round-10 adversarial
  verification confirms the silent merge with bash live (marker present).
- **`CQ2`/`CQ2c` — crafted variant silent.** `cat <<$'cat \c\''` makes bash's delimiter
  `cat ` 0x1c `'`; the terminator line then *starts with* `cat `, and after our fallback its
  `'` opens a quote and swallows the payload into a `cat …` piece. Probe `cq2` LIVE. Round-10
  adversarial verification: the shipped shape prompts; the crafted variant `CQ2c` is SILENT +
  bash-LIVE (marker present) — vector `CQ2` in `r10run.ts` reproduces the silent verdict.
- Prompt-only today (no payload capture found): `CQ`/`CQs` (`$'E\c\''` with ordinary text) —
  the fallback merges `cat it's` with the terminator line, but the payload printf still
  surfaces as its own piece.
- `ccx` (`$'E\c\cX'`): ours 0x18 vs bash `0x1c` + `cX`; no silent shape found, the mismatch
  can only mis-place terminators.

**Recommended fix (own round):** make the `$'…'` reader lexer-first — scan for the closing
quote with `\`-pair skipping (a `\`-escaped quote never closes the chunk), then decode the
bounded content with bash's literal-target `\c` model (`\c` + next byte `& 0x1f`, remainder
kept). This changes every `\c\…` decoded byte, so it needs its own probe + differential
round; do not fold it into a maintenance change. The narrow `\c`-before-closing-quote fix
(round 10) is independent and already landed.

### 2b. Case-pattern parens inside spans

Round 7–9 review note: `(` handling in `case` patterns and similar positions is not
re-parsed inside `$(…)` spans (span text is still scanned char-wise for piece splitting).
No live silent shape demonstrated; re-check alongside 2a.

## 3. Blocker-class live findings (round-10 adversarial verification; unaddressed — fix-round cap reached)

Three new families, all bash-LIVE (marker present, rc=0) and silent under the real engine
semantics: the splitter emits one multiline piece starting `cat ` that the payload ends up in,
stock `cat *` matches it (`*` crosses newlines via dotAll), so zero prompts fire while
`bash -c` runs the command. One shared root cause across the three: the span tracker models
fewer substitution forms than bash, so a heredoc-body trigger fires at a newline bash treats
as command text, a live line "terminates" the heredoc, and the real body's unbalanced quote
merges through to EOF.

- **V1 — `#` comment inside `$(…)`.** `consumeCommandSubstitution` does not model comments,
  so the span closes at a `)` inside one. Repro (5 lines): `cat <<"cat x)" $(echo #)` /
  `cat x)` / `cat it's` / `cat x)` / `printf PWNED-ACMT` — SILENT-CAT, bash runs the payload.
  Variant **V1b**: same opener with a quote in the comment (`$(echo # 'a)`) — also SILENT-CAT.
  Evidence: `bvT/a-cmt.sh` + `mark-a-cmt`, `a-cmt3`.
- **V2 — process substitution.** `<(`/`>(` open no span at all. Repro opener
  `cat <<"cat x)" <(echo` (same trailing 4 lines) — SILENT-CAT (evidence `bvT/a-psub` +
  `mark-a-psub`). Note: `>(echo` shows the same splitter verdict, but bash blocks on the fifo
  (no marker within 5 s) — same mechanism, usability nuance only.
- **V3 — ANSI-C chunk inside `$(…)`.** The scanner reads `$'\''` as a plain `'…'` chunk and
  the naive `indexOf("'")` stops at the escaped quote. Repro opener
  `cat <<"cat x)" $(echo $'\''` (same trailing 4 lines) — SILENT-CAT (evidence `bvT/a-ansi1` +
  `mark-a-ansi1`).

**Suggested fix (dedicated round):** model `#` comments, `<(`/`>(` spans and ANSI-C chunks
inside substitution scanning — the same restructure as the 2a lexer-first `$'…'` reader;
optionally add a liveness/span guard so the body-mode fallback cannot merge across a
live-newline boundary.

**worktree.ts doc claims falsified by V1/V2/V3** (record only — correct together with the
V1/V2/V3 fix): L890-893, L894-904, L906-908, L999-1008 (e.g. the "a newline inside a `$(…)`/
backtick span never engages body mode … probed" claim — true only for the span forms the
tracker models, not the V1–V3 forms).

### Status confirmations (same verification run)

- `CN`: silent-by-default confirmed (bash live) — see 2a.
- `CQ2`/`CQ2c`: shipped shape prompts; crafted `CQ2c` SILENT + bash-LIVE (marker present) — see 2a.
- Prompting-only, no bypass: `a-v4` (`${x:-` + newline + payload), `a-esc`, shipped `CQ2`.
- New DEAD vectors folded into section 1: `a-case`, `a-parm`, `c1empty`, `x7fs`, `x7fd`,
  `cas`, `cbd`, `plain01d`, `dq017f2`, `dqesc01s`, `esc01d`, `src01b`, `srcbt01b`, `sq7fs`
  (rc=2/syntax error or no marker).
- Evidence: bash probes and markers under `/tmp/user/1000/opencode/typecheck/bvT/`
  (verification workspace; not yet copied into `worktree-tests/probes/`).

## 4. Non-blocker: fail-closed fallback redesign

The line-wise fallback (engaged when no terminator is found) is what turns any word-model
mismatch into a merge. A fail-closed redesign would, on an unmatched heredoc word, treat the
remaining text as one opaque asserted piece instead of re-scanning it line-wise — equal or
stronger safety, fewer merge shapes; cost: extra prompts for legitimate dead-text shapes
(the `subnl`-family vectors). Not required for any accepted residual; schedule only with a
fresh acceptance matrix.

## 5. Verify

```
cd /home/amr/.opencode/worktree-tests
bun test                                  # 43 tests (worktree.smoke.ts + smoke.test.ts + background-agents.test.ts)
bun run r10run.ts                         # round-10 vectors; diff against outputs/r10-after-new.out
bun run r9-run.ts                         # must stay byte-identical; exactly 4 SILENT (accepted set)
bun run r6check.ts && bun run r7check.ts  # byte-identical baselines
python3 probes/r10probes*.py              # bash marker ground truth (writes only under probes/)
```

## 6. Applied in the security review pass (2026-10-21)

- **Repo hooks are opt-in.** `runHooks` refuses to run any repo-controlled hook unless
  `OPENCODE_WORKTREE_ALLOW_REPO_HOOKS=1`. This neutralizes the V1/V2/V3, `CN`, and `CQ2c`
  vectors in sections 2–3 for the default configuration: they need a repo hook to execute, and
  repo hooks now require an explicit environment opt-in. The splitter is still an approximation
  and must not be treated as a security boundary once the gate is opened; the section 4
  redesign is still the principled fix.
- **Delegation ids and paths (background-agents.ts).** Ids must match
  `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`; resolved paths must stay inside the delegations directory
  (`resolveInsideDir`), covering the fallback output path and deletion.
- **Notification escaping (background-agents.ts).** Every dynamic value in terminal and
  all-complete notifications passes through `escapeXmlText`.
- **Session-scoped deferred delete (worktree/state.ts).** `pending_operations` rows carry
  `session_id`; `worktree_delete` writes it and the `session.idle` consumer only consumes its
  own session's row. Legacy rows with NULL `session_id` match nothing.
- **`git worktree remove` no longer passes `--force`.** A pending delete now first commits
  (`--allow-empty`) then removes; untracked or ignored files make removal fail and the worktree
  is kept (logged via `log.warn`). Deliberate: this path used to discard uncommitted work
  without consent.

