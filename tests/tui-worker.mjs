#!/usr/bin/env bun
// Start the real blob Worker + bun:sqlite from tui.tsx against a fixture DB:
// results must round-trip and a slow query must not stall this thread.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"

const source = readFileSync(new URL("../tui-plugins/sesh-panel/tui.tsx", import.meta.url), "utf8")
const start = source.indexOf("function shortDir")
const end = source.indexOf("const TRANSCRIPT_PREVIEW_TURNS")
assert.ok(start >= 0 && end > start, "could not locate the TUI data layer; update this test")
const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end))

const dir = mkdtempSync(join(tmpdir(), "sesh-tui-worker-"))
const dbPath = join(dir, "opencode.db")
const seed = new Database(dbPath)
seed.exec("CREATE TABLE t (a INTEGER, b TEXT); INSERT INTO t VALUES (1, 'x'), (2, 'y');")
seed.close()

const { createDbClient } = new Function(
  "readFile", "process", "setTimeout", "setInterval", "clearInterval", "POLL_MS", "existsSync", "spawnSync",
  `${js}; return { createDbClient }`,
)(async () => "", { env: { SESH_DB: dbPath } }, setTimeout, setInterval, clearInterval, 15_000, () => false, () => ({ status: 1 }))

const client = createDbClient()
try {
  assert.deepEqual(await client.run("SELECT b FROM t WHERE a = ?", [2]), [{ b: "y" }])
  await assert.rejects(client.run("SELECT * FROM missing"), /missing/)
  assert.deepEqual(await client.run("SELECT a FROM t ORDER BY a"), [{ a: 1 }, { a: 2 }], "worker survives a query error")

  let ticks = 0
  const timer = setInterval(() => ticks++, 5)
  const began = performance.now()
  const rows = await client.run("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30000000) SELECT COUNT(*) AS c FROM n")
  const elapsed = performance.now() - began
  clearInterval(timer)
  assert.deepEqual(rows, [{ c: 30000000 }])
  assert.ok(elapsed > 200, `fixture query must be slow enough to measure (took ${Math.round(elapsed)} ms)`)
  assert.ok(ticks >= elapsed / 5 / 3, `main thread stalled: ${ticks} ticks in ${Math.round(elapsed)} ms`)
} finally {
  client.close()
}

// Transcript indexing through the default client: text only, equal to the
// expected text, and the main thread keeps ticking while ~30 MB of tool output
// is scanned in the worker.
try {
  const heavyPath = join(dir, "heavy.db")
  const heavy = new Database(heavyPath)
  heavy.exec("CREATE TABLE session_message (session_id TEXT, seq INTEGER, type TEXT, data TEXT)")
  const insert = heavy.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?)")
  const payload = "x".repeat(100_000)
  const entries = []
  heavy.transaction(() => {
    for (let n = 0; n < 300; n++) {
      const id = `ses_heavy${n}`
      entries.push({ id, title: `T${n}`, dir: "/p", group: "p", updated: n })
      insert.run(id, 1, "user", JSON.stringify({ text: `question ${n}` }))
      insert.run(id, 2, "assistant", JSON.stringify({ content: [
        { type: "text", text: `answer ${n}` },
        { type: "tool", text: `SECRET_${n}`, state: { output: payload } },
      ] }))
    }
  })()
  heavy.close()

  const { buildSearchIndex } = new Function(
    "readFile", "process", "setTimeout", "setInterval", "clearInterval", "POLL_MS", "existsSync", "spawnSync",
    `${js}; return { buildSearchIndex }`,
  )(async () => "", { env: { SESH_DB: heavyPath } }, setTimeout, setInterval, clearInterval, 15_000, () => false, () => ({ status: 1 }))

  let last = performance.now()
  let maxGap = 0
  let ticks = 0
  const timer = setInterval(() => {
    const now = performance.now()
    maxGap = Math.max(maxGap, now - last)
    last = now
    ticks++
  }, 5)
  const began = performance.now()
  const index = await buildSearchIndex({ client: { session: { messages() { throw new Error("must stay local") } } } }, entries)
  const elapsed = performance.now() - began
  clearInterval(timer)

  for (const [n, entry] of entries.entries()) assert.equal(index.get(entry.id), `T${n} /p question ${n} answer ${n}`)
  assert.ok(![...index.values()].some((text) => text.includes("SECRET")))
  assert.ok(ticks >= elapsed / 5 / 4, `main thread stalled: ${ticks} ticks in ${Math.round(elapsed)} ms`)

  const sync = new Database(heavyPath, { readonly: true })
  const syncBegan = performance.now()
  for (const row of sync.query("SELECT data FROM session_message WHERE type IN ('user','assistant') AND session_id IN (SELECT DISTINCT session_id FROM session_message ORDER BY session_id LIMIT 64) ORDER BY seq").all()) JSON.parse(row.data)
  const syncMs = performance.now() - syncBegan
  sync.close()
  console.log(`index: ${Math.round(elapsed)} ms, ${ticks} ticks, max main-thread gap ${Math.round(maxGap)} ms; old sync query+parse of one 64-session batch: ${Math.round(syncMs)} ms`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log("tui worker tests passed")
