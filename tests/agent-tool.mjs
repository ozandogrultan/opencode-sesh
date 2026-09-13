#!/usr/bin/env node
// Contract regressions for opencode/tools/sesh-list.ts. The tool normally runs
// inside OpenCode's Bun runtime, so this test loads the real source with a stub
// `tool`/Bun and asserts the query it builds: global store, directory filter
// before the limit, escaped literals, validated limit, and empty results.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

async function loadTool() {
  let source = readFileSync(join(root, "opencode/tools/sesh-list.ts"), "utf8")
  const pluginImport = 'import { tool } from "@opencode-ai/plugin"'
  assert.ok(source.includes(pluginImport), "plugin import not found; update this test")
  source = source.replace(
    pluginImport,
    `const schema = () => { const opts = {}; const api = { int(){ return api }, min(v){ opts.min = v; return api }, max(v){ opts.max = v; return api }, describe(d){ opts.describe = d; return api }, optional(){ opts.optional = true; return api }, default(v){ opts.default = v; return api }, __opts: opts }; return api }
     const tool = Object.assign((config) => config, { schema: { number: schema, string: schema } })`,
  )
  // The only TypeScript-only syntax in this file; keeps the test runnable on
  // older Node releases without a type-stripping API.
  source = source.replace("(globalThis as any).Bun", "globalThis.Bun")
  const mod = await import("data:text/javascript," + encodeURIComponent(source))
  return mod.default
}

const tool = await loadTool()

let calls = []
let output = "[]"
globalThis.Bun = {
  $: (strings, ...values) => {
    calls.push(strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ""), ""))
    return { text: async () => output }
  },
}

const run = (args) => {
  calls = []
  return tool.execute(args)
}

// Schema bounds and default are declared.
assert.equal(tool.args.limit.__opts.min, 0)
assert.equal(tool.args.limit.__opts.max, 1000)
assert.equal(tool.args.limit.__opts.default, 50)

// Directory filtering happens in SQL before LIMIT, against the global store.
let result = JSON.parse(await run({ limit: 50, directory: "/tmp/one" }))
assert.deepEqual(result, [], "empty store returns []")
let sql = calls[0]
assert.match(sql, /^opencode db SELECT id, title, directory, time_updated AS updated, time_created AS created/)
assert.ok(sql.includes("FROM session WHERE parent_id IS NULL AND time_archived IS NULL AND directory = '/tmp/one'"))
assert.ok(sql.indexOf("directory =") < sql.indexOf("LIMIT"), "filter must precede the limit")
assert.match(sql, /ORDER BY time_updated DESC, id DESC LIMIT 50 --format json$/)

// Absent directory still restricts to root, non-archived sessions.
await run({ limit: 7 })
assert.ok(!calls[0].includes("directory ="), "no directory filter should be emitted")
assert.match(calls[0], /WHERE parent_id IS NULL AND time_archived IS NULL\s+ORDER BY/)
assert.match(calls[0], /LIMIT 7 --format json$/)

// Single quotes in the directory are escaped as SQL literals, not injected.
await run({ limit: 5, directory: "x'; DROP TABLE session; --" })
sql = calls[0]
assert.ok(sql.includes("AND directory = 'x''; DROP TABLE session; --'"))
assert.ok(sql.indexOf("DROP") < sql.indexOf("LIMIT"), "injection text stays in the literal")

// Limit is bounded and integral for direct callers too.
for (const bad of [-1, 1.5, 1001, Number.NaN]) {
  await assert.rejects(() => tool.execute({ limit: bad }), /limit must be an integer between 0 and 1000/)
}

// Valid rows pass through unchanged.
output = JSON.stringify([{ id: "ses_a", title: "A", directory: "/d", updated: 2, created: 1 }])
assert.deepEqual(JSON.parse(await run({ limit: 1 })), [{ id: "ses_a", title: "A", directory: "/d", updated: 2, created: 1 }])

// Whitespace-only output (older CLI) normalizes to an empty array.
output = ""
assert.equal(await run({ limit: 10 }), "[]")

// Unexpected shapes fail loudly instead of returning partial data.
output = '{"error":"nope"}'
await assert.rejects(() => run({ limit: 1 }), /expected an array/)

// The generated SQL has the intended semantics against a real SQLite store:
// roots only, non-archived, and the requested directory is filtered BEFORE the
// limit, so an older session in a second project is not hidden by newer ones.
function sqliteAvailable() {
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

if (!sqliteAvailable()) {
  console.error("sesh agent tool tests: sqlite3 not found; skipping SQL fixture checks")
} else {
  output = "[]"
  const dir = mkdtempSync(join(tmpdir(), "sesh-agent-"))
  try {
    const db = join(dir, "opencode.db")
    execFileSync("sqlite3", [db], {
      input: `
        CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT,
          time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
        INSERT INTO session VALUES ('ses_new', NULL, '/dir/a', 'Newest', 100, 100, NULL);
        INSERT INTO session VALUES ('ses_old', NULL, '/dir/b', 'Older', 1, 1, NULL);
        INSERT INTO session VALUES ('ses_child', 'ses_new', '/dir/b', 'Fork child', 200, 200, NULL);
        INSERT INTO session VALUES ('ses_arch', NULL, '/dir/b', 'Archived', 300, 300, 300);
      `,
    })
    const queryFor = async (args) => {
      calls = []
      await run(args)
      return calls[0].replace(/^opencode db /, "").replace(/ --format json$/, "")
    }
    const rows = (sql) =>
      JSON.parse(execFileSync("sqlite3", ["-json", db, sql], { encoding: "utf8" }).trim() || "[]")

    // Newest global roots exclude children/archived.
    assert.deepEqual(rows(await queryFor({ limit: 10 })).map((r) => r.id), ["ses_new", "ses_old"])
    // An older session in the requested directory survives a limit of 1.
    assert.deepEqual(rows(await queryFor({ limit: 1, directory: "/dir/b" })).map((r) => r.id), ["ses_old"])
    // Zero limit is valid and returns nothing.
    assert.deepEqual(rows(await queryFor({ limit: 0 })), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log("agent tool contract tests passed")
