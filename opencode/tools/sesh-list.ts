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
      .int()
      .min(0)
      .max(1000)
      .describe("Maximum sessions to return (0–1000; 0 returns none)")
      .default(50),
    directory: tool.schema
      .string()
      .describe("Only sessions from this directory (default: all directories)")
      .optional(),
  },
  async execute(args) {
    // Validate here as well as in the schema for direct/programmatic callers.
    if (!Number.isInteger(args.limit) || args.limit < 0 || args.limit > 1000) {
      throw new Error("limit must be an integer between 0 and 1000")
    }
    const bun = (globalThis as any).Bun
    if (!bun || typeof bun.$ !== "function") {
      throw new Error("This tool requires the Bun runtime (globalThis.Bun.$)")
    }

    // `session list` is project-scoped and hides only children of forks. The
    // global store has no project instance, so query the SQLite session table
    // directly (OpenCode 1.18.30). Match `Session.listGlobal`/the picker: roots
    // only, non-archived. Bun quotes the SQL as one shell argument; SQL string
    // literals need their own escaping as well.
    const where = args.directory === undefined
      ? ""
      : ` AND directory = '${args.directory.replaceAll("'", "''")}'`
    const query = `SELECT id, title, directory, time_updated AS updated, time_created AS created
      FROM session WHERE parent_id IS NULL AND time_archived IS NULL${where}
      ORDER BY time_updated DESC, id DESC LIMIT ${args.limit}`
    const text = await bun.$`opencode db ${query} --format json`.text()
    const sessions = JSON.parse(text.trim() || "[]")
    if (!Array.isArray(sessions)) throw new Error("Unexpected opencode db result: expected an array")
    return JSON.stringify(sessions)
  },
})
