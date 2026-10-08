#!/usr/bin/env node
// Contract regressions for plugins/sesh-list.ts. The tool runs inside
// OpenCode's Bun runtime, so this test loads the real source with a stub
// Plugin/Bun environment and asserts the registered tool: input schema,
// parameter validation, zero limit, directory scoping, and SQLite queries.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { DatabaseSync } from "node:sqlite"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

let stripTypeScriptTypes
try {
  ;({ stripTypeScriptTypes } = await import("node:module"))
} catch {}
if (typeof stripTypeScriptTypes !== "function") {
  console.log("agent tool tests skipped: Node lacks module.stripTypeScriptTypes")
  process.exit(0)
}

async function loadTool(sqliteWrapperPath) {
  let source = readFileSync(join(root, "plugins/sesh-list.ts"), "utf8")
  const pluginImport = 'import { Plugin } from "@opencode/plugin"'
  assert.ok(source.includes(pluginImport), "plugin import not found; update this test")
  source = source.replace(
    pluginImport,
    `const Plugin = { define: (def) => def }`,
  )
  if (sqliteWrapperPath) {
    source = source.replace('const specifier = "bun:sqlite"', `const specifier = ${JSON.stringify(pathToFileURL(sqliteWrapperPath).href)}`)
  }
  const stripped = stripTypeScriptTypes(source)
  const mod = await import("data:text/javascript," + encodeURIComponent(stripped))
  return mod.default
}

const pluginDef = await loadTool()
assert.equal(pluginDef.id, "sesh-list")

let registeredTool = null
const mockCtx = {
  tool: {
    async transform(callback) {
      await new Promise((resolve) => setImmediate(resolve))
      callback({
        add(tool) {
          registeredTool = tool
        },
      })
    },
  },
}

await pluginDef.setup(mockCtx)
assert.ok(registeredTool, "sesh_list tool was not registered")
await assert.rejects(() => pluginDef.setup({ tool: { transform: async () => { throw new Error("registration failed") } } }), /registration failed/)
assert.equal(registeredTool.name, "sesh_list")
assert.equal(registeredTool.description, "List opencode sessions across all project directories, newest first")

// Input schema validation
const input = registeredTool.input
assert.equal(input.type, "object")
assert.equal(input.properties.limit.type, "number")
assert.equal(input.properties.limit.default, 50)
assert.equal(input.properties.directory.type, "string")

// Limit bounds and validation
for (const bad of [-1, 1.5, 1001, Number.NaN, "foo"]) {
  await assert.rejects(
    () => registeredTool.execute({ limit: bad }),
    /limit must be an integer between 0 and 1000/,
  )
}

// Zero limit returns empty without querying DB
const zeroResult = await registeredTool.execute({ limit: 0 })
assert.deepEqual(zeroResult, { content: "[]" })

// SQLite database execution tests
const dir = mkdtempSync(join(tmpdir(), "sesh-agent-"))
const dbDir = join(dir, "opencode")
mkdirSync(dbDir, { recursive: true })
const dbPath = join(dbDir, "opencode.db")

try {
  const sqlite = new DatabaseSync(dbPath)
  sqlite.exec(readFileSync(join(root, "tests/fixture-v2.sql"), "utf8"))
  sqlite.exec(`
    INSERT INTO session_v2 (id, parent_id, directory, title, time_created, time_updated, time_archived) VALUES ('ses_new', NULL, '/dir/a', 'Newest', 100, 100, NULL);
    INSERT INTO session_v2 (id, parent_id, directory, title, time_created, time_updated, time_archived) VALUES ('ses_old', NULL, '/dir/b', 'Older', 1, 1, NULL);
    INSERT INTO session_v2 (id, parent_id, directory, title, time_created, time_updated, time_archived) VALUES ('ses_child', 'ses_new', '/dir/b', 'Fork child', 200, 200, NULL);
    INSERT INTO session_v2 (id, parent_id, directory, title, time_created, time_updated, time_archived) VALUES ('ses_arch', NULL, '/dir/b', 'Archived', 300, 300, 300);
  `)
  sqlite.close()

  // Create a minimal bun:sqlite compatible wrapper file
  const wrapperFile = join(dir, "sqlite-shim.mjs")
  const wrapperCode = `
    import { DatabaseSync } from "node:sqlite"
    export class Database {
      constructor(path, opts) {
        this._db = new DatabaseSync(path)
      }
      query(sql) {
        const stmt = this._db.prepare(sql)
        return {
          all: (...args) => stmt.all(...args)
        }
      }
      close() {
        this._db.close()
      }
    }
  `
  await import("node:fs/promises").then((fs) => fs.writeFile(wrapperFile, wrapperCode))

  const testPlugin = await loadTool(wrapperFile)
  let runtimeTool = null
  await testPlugin.setup({
    tool: {
      transform(cb) {
        cb({ add(t) { runtimeTool = t } })
      },
    },
  })

  process.env.XDG_DATA_HOME = dir

  // Query all roots (newest first, excluding fork child and archived)
  const resAll = await runtimeTool.execute({ limit: 10 })
  const rowsAll = JSON.parse(resAll.content)
  assert.deepEqual(rowsAll.map((r) => r.id), ["ses_new", "ses_old"])

  // Query scoped to /dir/b
  const resScoped = await runtimeTool.execute({ limit: 1, directory: "/dir/b" })
  const rowsScoped = JSON.parse(resScoped.content)
  assert.deepEqual(rowsScoped.map((r) => r.id), ["ses_old"])

  // SQL injection string in directory parameter is treated as safe literal value
  const resInjection = await runtimeTool.execute({ limit: 5, directory: "x'; DROP TABLE session_v2; --" })
  const rowsInjection = JSON.parse(resInjection.content)
  assert.deepEqual(rowsInjection, [])
} finally {
  delete process.env.XDG_DATA_HOME
  rmSync(dir, { recursive: true, force: true })
}

console.log("agent tool contract tests passed")
