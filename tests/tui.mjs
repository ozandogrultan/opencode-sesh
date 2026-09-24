#!/usr/bin/env node
// Contract regressions for the TUI data layer (tui/sesh-panel.tsx): global
// session pagination, full transcript-index coverage, bounded remote
// concurrency, and progress reporting. The panel is TSX, so the pure data
// functions are extracted and evaluated with stubbed client/readFile.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

let stripTypeScriptTypes
try {
  ;({ stripTypeScriptTypes } = await import("node:module"))
} catch {}
if (typeof stripTypeScriptTypes !== "function") {
  console.log("tui data-layer tests skipped: Node lacks module.stripTypeScriptTypes")
  process.exit(0)
}

function loadDataLayer() {
  const source = readFileSync(join(root, "tui/sesh-panel.tsx"), "utf8")
  const start = source.indexOf("function shortDir")
  const end = source.indexOf("const TRANSCRIPT_PREVIEW_TURNS")
  assert.ok(start >= 0 && end > start, "could not locate the TUI data layer; update this test")
  const js = stripTypeScriptTypes(source.slice(start, end))
  const factory = new Function(
    "readFile",
    "process",
    "setTimeout",
    `${js}
    return { fetchEntries, buildSearchIndex, buildSearchIndexRemote, SESSION_PAGE_LIMIT, SESSION_MAX, REMOTE_CONCURRENCY, TRANSCRIPT_BATCH, parsePresence }`,
  )
  return factory(
    async () => {
      throw new Error("no local cache")
    },
    { env: { HOME: "/nonexistent", SESH_CACHE_DIR: "/nonexistent/cache" } },
    setTimeout,
  )
}

function loadPinnedSort() {
  const source = readFileSync(join(root, "tui/sesh-panel.tsx"), "utf8")
  const start = source.indexOf("function pinnedFirst")
  const end = source.indexOf("// Sessions panel", start)
  assert.ok(start >= 0 && end > start, "could not locate TUI pin sorting")
  return new Function(`${stripTypeScriptTypes(source.slice(start, end))}; return pinnedFirst`)()
}

const { fetchEntries, buildSearchIndex, SESSION_PAGE_LIMIT, SESSION_MAX, REMOTE_CONCURRENCY, parsePresence } =
  loadDataLayer()

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Presence files drive click-to-focus in cmux: a fresh entry names the live
// workspace, a stale one (crashed pane) is ignored, and malformed JSON never
// throws. Absent/foreign workspaces resolve to undefined so the caller falls
// back to a local open.
{
  const now = 1_000_000
  const fresh = JSON.stringify({ workspace: "WS-1", surface: "S-1", updated: now - 1_000 })
  assert.equal(parsePresence(fresh, now), "WS-1")
  const stale = JSON.stringify({ workspace: "WS-2", updated: now - 60_000 })
  assert.equal(parsePresence(stale, now), undefined)
  assert.equal(parsePresence("not json", now), undefined)
  assert.equal(parsePresence(JSON.stringify({ updated: now }), now), undefined)
  assert.equal(parsePresence(JSON.stringify({ workspace: "", updated: now }), now), undefined)
}

// The sidebar lists every session without a row cap: all filtered entries
// reach the tree, and overflow scrolls inside the stretched scrollbox.
{
  const source = readFileSync(join(root, "tui/sesh-panel.tsx"), "utf8")
  assert.doesNotMatch(source, /slice\(0, SIDEBAR_LIMIT\)/)
  assert.doesNotMatch(source, /sidebarRowBudget/)
  assert.match(source, /const shownEntries = createMemo\(\(\) => filteredEntries\(\)\)/)
}

// The delete confirm targets the armed row wherever the pointer is: leaving
// the armed row (edge-hover flicker) must not disarm the pending delete.
{
  const source = readFileSync(join(root, "tui/sesh-panel.tsx"), "utf8")
  assert.doesNotMatch(source, /pending !== hovered\(\)/)
  assert.match(source, /const confirmArmed = /)
}

// Slash subcommands exist as separate registrations (the command API never
// passes arguments), each read-only: costs renders a digest, needs opens the
// waiting set. Destructive actions stay CLI-only.
{
  const source = readFileSync(join(root, "tui/sesh-panel.tsx"), "utf8")
  assert.match(source, /slash: \{ name: "sesh-costs" \}/)
  assert.match(source, /slash: \{ name: "sesh-needs" \}/)
  assert.match(source, /const openCosts = /)
  assert.match(source, /const openNeeds = /)
}

// The sidebar surfaces needs-input triage: a virtual group above the
// directory groups, fed by the shared NEEDS_INPUT_SQL heuristic.
{
  const source = readFileSync(join(root, "tui/sesh-panel.tsx"), "utf8")
  assert.match(source, /__needs_input__/)
  assert.match(source, /NEEDS_INPUT_SQL/)
  assert.match(source, /need input/)
}

// Space must remain available to both search boxes and the main prompt even
// when a session row is hovered or selected in the sidebar.
{
  const source = readFileSync(join(root, "tui/sesh-panel.tsx"), "utf8")
  const previewKeys = [...source.matchAll(/key: "([^"]+)",\s*desc: "Preview session transcript"/g)]
  assert.equal(previewKeys.length, 3, "expected hover and sidebar navigation preview bindings")
  assert.ok(previewKeys.every((match) => match[1] === "ctrl+p"), "Space must not open a preview")
  assert.match(source, /key: "space", preventDefault: true, cmd: \(\) => append\(" "\)/)
}

// An old pinned session remains visible ahead of a capped recent list, even
// when another directory is pinned as a group.
{
  const entries = [
    { id: "ses_recent", dir: "/other", updated: 300 },
    { id: "ses_directory", dir: "/pinned", updated: 200 },
    { id: "ses_old", dir: "/other", updated: 100 },
  ]
  const sorted = loadPinnedSort()(entries, { sessions: ["ses_old"], directories: ["/pinned"] })
  assert.deepEqual(sorted.map((entry) => entry.id), ["ses_old", "ses_directory", "ses_recent"])
  assert.equal(sorted[0], entries[2], "sorting must not replace session records")
}

function sessionsFor(count, { spread = 1_000_000 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    id: `ses_${String(i).padStart(5, "0")}`,
    title: `Session ${i}`,
    directory: `/dir/${i % 7}`,
    projectID: undefined,
    parentID: undefined,
    time: { updated: spread - i },
  }))
}

function makeApi(sessions, { latency = 0 } = {}) {
  const calls = { list: [], messages: 0, inFlight: 0, maxInFlight: 0 }
  return {
    calls,
    client: {
      project: { list: async () => ({ data: [] }) },
      experimental: {
        session: {
          list: async ({ limit, cursor }) => {
            calls.list.push({ limit, cursor })
            const start = cursor === undefined ? 0 : sessions.findIndex((s) => s.time.updated === cursor) + 1
            return { data: sessions.slice(start, start + limit) }
          },
        },
      },
      session: {
        messages: async ({ sessionID }) => {
          calls.messages += 1
          calls.inFlight += 1
          calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight)
          if (latency) await delay(latency)
          calls.inFlight -= 1
          return { data: [{ parts: [{ type: "text", text: `needle ${sessionID}` }] }] }
        },
      },
    },
  }
}

// Paginates past the old fixed 500-row window and keeps the tail.
{
  const api = makeApi(sessionsFor(501))
  const { entries, truncated } = await fetchEntries(api)
  assert.equal(entries.length, 501)
  assert.equal(truncated, false)
  assert.equal(api.calls.list.length, 3, "expected three pages")
  assert.equal(api.calls.list[0].limit, SESSION_PAGE_LIMIT)
  assert.equal(api.calls.list[0].cursor, undefined)
  assert.equal(api.calls.list[1].cursor, 1_000_000 - (SESSION_PAGE_LIMIT - 1))
  assert.equal(api.calls.list[2].cursor, 1_000_000 - (2 * SESSION_PAGE_LIMIT - 1))
  assert.ok(entries.some((entry) => entry.id === "ses_00500"), "the 501st session must survive")
}

// Indexes transcripts beyond the old 150-session window.
{
  const api = makeApi(sessionsFor(200))
  const progress = []
  const snapshots = []
  const index = await buildSearchIndex(api, (await fetchEntries(api)).entries, (p, current) => {
    progress.push(p)
    snapshots.push(new Map(current))
  })
  for (const id of ["ses_00150", "ses_00199"]) {
    assert.ok(index.has(id), `${id} must be indexed`)
    assert.match(index.get(id), new RegExp(`needle ${id}`))
  }
  assert.equal(progress.at(-1).complete, true)
  assert.equal(progress.at(-1).indexed, progress.at(-1).total)
  assert.equal(progress.at(-1).total, 200)
  assert.ok(progress.some((p) => p.indexed > 0 && !p.complete), "publish partial transcript coverage")
  assert.ok(snapshots.some((snapshot) => snapshot.get("ses_00000")?.includes("needle ses_00000")))
  assert.ok(!snapshots[0].get("ses_00000")?.includes("needle"), "initial snapshot contains metadata only")
}

// Remote transcript fetches run in a bounded pool, not all at once.
{
  const api = makeApi(sessionsFor(64), { latency: 2 })
  await buildSearchIndex(api, (await fetchEntries(api)).entries)
  assert.ok(api.calls.messages >= 64, "every session should be fetched")
  assert.ok(
    api.calls.maxInFlight <= REMOTE_CONCURRENCY,
    `concurrency ${api.calls.maxInFlight} exceeded ${REMOTE_CONCURRENCY}`,
  )
}

// The metadata walk stops at its cap and reports the result as truncated.
{
  const huge = sessionsFor(SESSION_MAX + 10_000, { spread: 10_000_000 })
  const api = makeApi(huge)
  const { entries, truncated } = await fetchEntries(api)
  assert.equal(entries.length, SESSION_MAX)
  assert.equal(truncated, true)
}

console.log("tui data-layer tests passed")
