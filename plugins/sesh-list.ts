import { Plugin } from "@opencode/plugin"
import { homedir } from "node:os"
import { join } from "node:path"

function dbPath(): string {
  return process.env.SESH_DB ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "opencode.db")
}

const input = {
  type: "object",
  properties: {
    limit: {
      type: "number",
      description: "Maximum sessions to return (0-1000; 0 returns none)",
      default: 50,
    },
    directory: {
      type: "string",
      description: "Only sessions from this directory (default: all directories)",
    },
  },
  required: [],
  additionalProperties: false,
} as const

export default Plugin.define({
  id: "sesh-list",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "sesh_list",
        description: "List opencode sessions across all project directories, newest first",
        input,
        async execute(args: any) {
          const limit = args.limit === undefined ? 50 : Number(args.limit)
          if (!Number.isInteger(limit) || limit < 0 || limit > 1000) {
            throw new Error("limit must be an integer between 0 and 1000")
          }
          if (limit === 0) return { content: "[]" }

          const specifier = "bun:sqlite"
          const sqlite: any = await import(specifier).catch(() => undefined)
          if (typeof sqlite?.Database !== "function") {
            throw new Error("sesh_list requires the Bun runtime (bun:sqlite)")
          }

          const db = new sqlite.Database(dbPath(), { readonly: true })
          try {
            const scoped = typeof args.directory === "string" && args.directory.length > 0
            const query = `SELECT id, title, directory, time_updated AS updated, time_created AS created
              FROM session_v2
              WHERE parent_id IS NULL AND COALESCE(time_archived, 0) = 0${scoped ? " AND directory = ?" : ""}
              ORDER BY time_updated DESC, id DESC
              LIMIT ${limit}`
            const rows = scoped ? db.query(query).all(args.directory) : db.query(query).all()
            return { content: JSON.stringify(rows ?? []) }
          } finally {
            db.close?.()
          }
        },
      })
    })
  },
})
