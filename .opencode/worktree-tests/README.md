# worktree-tests — round-10 verification bundle

Snapshot of the verification material for the round-10 fixes (Family A substitution-newline
trigger, Family B bare `\c` at chunk end, Family C bash control-byte protection of quoted
heredoc words) in `/home/amr/.opencode/plugins/worktree.ts`.

Live revision pinned here: sha256 `c5a3491db5f51bc634649395605ee801239d9dc105e2cc7fd02e95cf456e92fc`
(2110 lines). `plugins/worktree.smoke.ts` is that file plus one appended export line:

    export { runHooks, bindHookConsent, splitHookCommands, isPermissionDenial, WorktreeError }

## Run

```
bun test                                  # 37 smoke tests, 0 fail
bun run r10run.ts                         # compare with outputs/r10-after-new.out
bun run r9-run.ts                         # gate: exactly 4 SILENT-CAT, byte-identical to outputs/r10-after-r9.out
bun run r6check.ts && bun run r7check.ts  # gate: byte-identical to the before baselines
python3 probes/r10probes.py               # etc. — bash marker-file ground truth (touches markers under probes/)
```

Regenerate the smoke copy after any live edit:

```
cp /home/amr/.opencode/plugins/worktree.ts plugins/worktree.smoke.ts
printf '\nexport { runHooks, bindHookConsent, splitHookCommands, isPermissionDenial, WorktreeError }\n' >> plugins/worktree.smoke.ts
```

## Layout

- `plugins/worktree.smoke.ts` — live plugin snapshot + export line (import target for all runners).
- `plugins/worktree/`, `plugins/kdco-primitives/` — companion modules the plugin imports (copied so the bundle runs standalone).
- `node_modules/` — minimal runtime deps: a stub `@opencode/plugin` (at runtime only `Plugin.define` is used, which is `(plugin) => plugin` — verified against `@opencode/plugin@2.0.32` `dist/promise/plugin.js`), plus `zod` and `jsonc-parser`.
- `smoke.test.ts` — unit suite; rounds 4–10 vectors at the bottom.
- `r10run.ts` — round-10 vectors (28) + verdict logic (`cat …` piece containing the payload = SILENT-CAT, own payload piece = SEPARATE).
- `r9-run.ts` — round-9 regression differential; the 4 remaining SILENT-CAT (B9-cr-neg, subnl, innerredir, R8C) are the accepted bash-dead set.
- `r6check.ts`, `r7check.ts` — earlier regression differentials (byte-identical gate).
- `outputs/` — before/after captures: `r10-before-*.out` (pre-fix), `r10-after-*.out` (post-fix).
- `probes/` — bash `touch`-marker probes for the ground truth (round-10 batches 1–5 + round-9 `bv9f/`).

## Accepted results (round 10)

- Family A: R9X/R9Xbt/R9X2 now SEPARATE (were SILENT-CAT); `backtickEnd` keeps the closing backtick from re-opening the span. R9Xctl stays merged (bash syntax-errors at EOF — dead text).
- Family B: C1/C1x/C1m/C1cc now SEPARATE (were SILENT-CAT). C1nb/C1nc stay merged (bash-dead lines).
- Family C: X01/X7F/OCT01/RAW01/RAW7F/DQ01/SQ01/CA now SEPARATE (were SILENT-CAT). X01neg stays merged (single-0x01 line, bash-dead); PLAIN01 (unquoted word) still terminates on a single-0x01 line, as bash does.
- r9 differential unchanged (exactly 4 accepted SILENT-CAT); r6/r7 byte-identical.
- Unfixed live findings (`CN`, `CQ2`, `\c\<escape>` family) are documented in `/home/amr/.opencode/plugins/FOLLOWUPS.md` with repros and a recommended fix shape.

## Known non-baseline typecheck noise

`bunx tsc` against the plugin reports exactly two pre-existing TS2322 errors at the tool
`execute` signatures (OpenCode's generic `input: unknown` vs the handlers' typed args);
everything else is clean. The smoke/test tsconfig is clean.
