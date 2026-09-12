// Custom tool: list opencode sessions for the agent.
// Install: copy to ~/.config/opencode/tools/sesh-list.ts (global) or
// .opencode/tools/sesh-list.ts (project). Requires the @opencode-ai/plugin
// package next to it — see https://opencode.ai/docs/custom-tools/
//
// Lets the agent browse previous work across ALL project directories and
// offer to resume one, without depending on the external fzf picker.
import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "List opencode sessions across all project directories, newest first",
  args: {
    limit: tool.schema
      .number()
      .describe("Maximum sessions to return")
      .default(50),
    directory: tool.schema
      .string()
      .describe("Only sessions from this directory (default: all directories)")
      .optional(),
  },
  async execute(args) {
    const bun = (globalThis as any).Bun
    if (!bun || typeof bun.$ !== "function") {
      throw new Error("This tool requires the Bun runtime (globalThis.Bun.$)")
    }

    const out = await bun.$`opencode session list -n ${args.limit} --format json`.json()
    const sessions = (Array.isArray(out) ? out : []).filter(
      (s) => !args.directory || s.directory === args.directory,
    )
    return JSON.stringify(
      sessions.map((s) => ({
        id: s.id,
        title: s.title,
        directory: s.directory,
        updated: s.updated,
        created: s.created,
      })),
    )
  },
})
