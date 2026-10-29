/**
 * safer-install-gate — blocks risky install/download commands via skillspector scan.
 *
 * Hook: tool.execute.before on bash/shell tool.
 * Pattern: mutate output.args.command in place (never reassign output.args).
 *
 * Env flags:
 *   SAFER_INSTALL_LLM=1  → use skillspector --use-llm (default: --no-llm)
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Plugin } from "@opencode/plugin";

const TAG = "[safer-install-gate]";

/** Replaced command: prints a readable block message to stderr, exits non-zero. */
const noopCmd = (cmd: string, reason: string): string => {
  const summary = cmd.replace(/[\r\n]+/g, " ").slice(0, 200);
  return `printf '%s BLOCKED: %s | cmd=%s\\n' '[safer-install-gate]' '${reason}' '${summary}' >&2; exit 1`;
};

const RISKY_PATTERNS: RegExp[] = [
  // bunx -y @anything  |  npx -y @anything  |  npx @anything
  /\b(bunx|npx)\b[^|&;]*\b(-y\s+)?@\S/,
  // npm/pip global installs: "npm install -g", "npm i -g", "pip install", "pip3 install"
  /\bnpm\b[^|&;]*\binstall\b[^|&;]*\b-g\b/,
  /\bnpm\b[^|&;]*\bi\b[^|&;]*\b-g\b/,
  // pip install without constraints: "pip install <pkg>" (any token after "install")
  /\b(pip|pip3)\s+install\b/,
  // curl | sh / curl | bash  (remote script execution)
  /\bcurl\b[^|&]*\|\s*(ba)?sh\b/,
  // wget | sh / wget | bash
  /\bwget\b[^|&]*\|\s*(ba)?sh\b/,

  // Extra flags/runtimes that pull scoped packages without explicit -y:
  //   `npx -p @foo/bar`, `npx --package @foo/bar`, `bunx --bun @foo/bar`
  /\b(npx|bunx)\b[^|&;]*?(?:-p|--package|-y)\b[^|&;]*@\S/,
  /\b(npx|bunx)\b[^|&;]*?--bun\b[^|&;]*@\S/,
  /\b(npx|bunx)\b[^|&;]*?@\S[^|&;]*?(?:-p|--package)\b/, // alt: flag after pkg

  // xdg-style helpers: `pipx install <pkg>`, `pipx run <pkg>`
  /\bpipx\b[^|&]*\b(install|run)\b/,

  // `python -m pip install <pkg>` and friends (python3 -m pip install <pkg>)
  /\bpython\d?(?:\s+\S+)?\s+-m\s+pip\b[^|&;]*\binstall\b/,

  // Native package managers (install is an install vector)
  //   cargo install <pkg> | gem install <pkg> | brew install <pkg>
  /\b(cargo|gem|brew)\b[^|&;]*\binstall\b/,
  //   go install <pkg>@<version>
  /\bgo\b[^|&;]*\binstall\b[^|&;]*@\S/,

  // JS dlx-style runners: `pnpm dlx <pkg>`, `yarn dlx <pkg>`
  /\b(pnpm|yarn)\b[^|&;]*\bdlx\b/,
  // npm/pnpm/yarn exec/run arbitrary
  /\b(npm|pnpm|yarn)\s+(exec|run)\s+\S/,

  // fish-style variant: `fish -c "<curl | sh>"`
  /\bfish\b[^|&;]*\b-c\b[^|&;]*\bcurl\b/,
];

/** Quick heuristic: does the command look risky? (cheap, no spawn)
 * Splits compound commands at &&, ||, ;, | then scans each segment. */
function looksRisky(cmd: string): boolean {
  const segments = cmd.split(/&&|\|\||;|(?<![\w])\|/);
  return segments.some((seg) => RISKY_PATTERNS.some((rx) => rx.test(seg)));
}

/**
 * Stage the command to a temp file, run skillspector scan, return a verdict.
 * Verdict: "allow" | "caution" | "block"
 */
async function gate(cmd: string): Promise<"allow" | "caution" | "block"> {
  const stageDir = path.join(
    os.tmpdir(),
    `safer-install-scan-${crypto.randomBytes(6).toString("hex")}`,
  );
  const scratch = path.join(stageDir, "scratch.sh");

  try {
    await fs.mkdir(stageDir, { recursive: true });
    await fs.writeFile(scratch, cmd + "\n", "utf-8");

    const useLLM = process.env.SAFER_INSTALL_LLM === "1";
    const args = ["scan", stageDir, "--format", "json"];
    if (useLLM) args.push("--use-llm");
    else args.push("--no-llm");

    const result = await new Promise<{ score: number; recommendation: string }>((resolve) => {
      const child = spawn("skillspector", args, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      });

      let stdout = "";
      const MAX_STDOUT = 1_000_000;
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length >= MAX_STDOUT) {
          child.kill();
          return;
        }
        stdout += chunk.toString();
      });

      child.on("error", () => {
        resolve({ score: 100, recommendation: "DO_NOT_INSTALL" });
      });

      child.on("close", () => {
        try {
          const parsed = JSON.parse(stdout);
          const ra = parsed?.risk_assessment;
          if (ra && typeof ra.score === "number") {
            resolve({
              score: ra.score,
              recommendation: String(ra.recommendation ?? "UNKNOWN"),
            });
          } else {
            resolve({ score: 100, recommendation: "DO_NOT_INSTALL" });
          }
        } catch {
          resolve({ score: 100, recommendation: "DO_NOT_INSTALL" });
        }
      });
    });

    const { score, recommendation } = result;

    if (recommendation === "DO_NOT_INSTALL" || score > 50) {
      console.error(
        `${TAG} BLOCKED | score=${score} rec=${recommendation} | cmd=${cmd.slice(0, 120)}`,
      );
      return "block";
    }

    if (score >= 21) {
      console.error(
        `${TAG} CAUTION | score=${score} rec=${recommendation} | cmd=${cmd.slice(0, 120)}`,
      );
      return "caution";
    }

    // score <= 20 → silent allow
    return "allow";
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}

export default Plugin.define({
  id: "safer-install-gate",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", async (event) => {
      try {
        const tool = String(event.tool ?? "").toLowerCase();
        if (tool !== "bash" && tool !== "shell") return;

        const args = event.input as Record<string, unknown> | undefined;
        if (!args || typeof args.command !== "string") return;

        const cmd = args.command as string;

        if (!looksRisky(cmd)) return;

        const verdict = await gate(cmd);

        if (verdict === "block") {
          args.command = noopCmd(cmd, verdict);
        }
        // "caution" and "allow": pass through unchanged
      } catch (err) {
        console.error(`${TAG} hook error (command passed through):`, err);
        // Never throw, never reassign — just let the original command through.
      }
    });
  },
});
