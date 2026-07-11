import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

// RTK OpenCode plugin — rewrites commands to use rtk for token savings.
// Requires: rtk >= 0.23.0 in PATH.
//
// This is a thin delegating plugin: all rewrite logic lives in `rtk rewrite`,
// which is the single source of truth (src/discover/registry.rs).
// To add or change rewrite rules, edit the Rust registry — not this file.

const execFileAsync = promisify(execFile)

export default Plugin.define({
  id: "rtk",
  async setup(ctx) {
    if (!Bun.which("rtk")) {
      console.warn("[rtk] rtk binary not found in PATH — plugin disabled")
      return
    }

    await ctx.tool.hook("execute.before", async (event) => {
      const tool = String(event.tool ?? "").toLowerCase()
      if (tool !== "bash" && tool !== "shell") return
      const input = event.input as Record<string, unknown> | undefined
      if (!input || typeof input !== "object") return

      const command = input.command
      if (typeof command !== "string" || !command) return

      try {
        const result = await execFileAsync("rtk", ["rewrite", command], { timeout: 2000 })
        const rewritten = String(result.stdout).trim()
        if (rewritten && rewritten !== command) input.command = rewritten
      } catch {
        // rtk rewrite failed — pass through unchanged
      }
    })
  },
})
