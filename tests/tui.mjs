#!/usr/bin/env node
// Contract regressions for the TUI data layer (tui-plugins/sesh-panel/tui.tsx): global
// session pagination, full transcript-index coverage, bounded remote
// concurrency, and progress reporting. The panel is TSX, so the pure data
// functions are extracted and evaluated with stubbed client/readFile.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

let stripTypeScriptTypes
try {
  ;({ stripTypeScriptTypes } = await import("node:module"))
} catch {}
if (typeof stripTypeScriptTypes !== "function") {
  console.log("tui data-layer tests skipped: Node lacks module.stripTypeScriptTypes")
  process.exit(0)
}

function loadDataLayer(readExtraction = async () => { throw new Error("no local cache") }) {
  const source = readFileSync(join(root, "tui-plugins/sesh-panel/tui.tsx"), "utf8")
  const start = source.indexOf("function shortDir")
  const end = source.indexOf("const TRANSCRIPT_PREVIEW_TURNS")
  assert.ok(start >= 0 && end > start, "could not locate the TUI data layer; update this test")
  const js = stripTypeScriptTypes(source.slice(start, end))
  const factory = new Function(
    "readFile",
    "process",
    "setTimeout",
    `${js}
    return { fetchEntries, buildSearchIndex, buildSearchIndexRemote, SESSION_PAGE_LIMIT, SESSION_MAX, REMOTE_CONCURRENCY, TRANSCRIPT_BATCH, newestFirst, sidebarMarker, transcriptMatchExcerpt, filterPickerEntries, queryWaitingDetails, contextMenuItems, contextMenuBox, createContextMenu }`,
  )
  return factory(
    readExtraction,
    { env: { HOME: "/nonexistent", SESH_CACHE_DIR: "/nonexistent/cache" } },
    setTimeout,
  )
}

function loadPinnedSort() {
  const source = readFileSync(join(root, "tui-plugins/sesh-panel/tui.tsx"), "utf8")
  const start = source.indexOf("function pinnedFirst")
  const end = source.indexOf("// Sessions panel", start)
  assert.ok(start >= 0 && end > start, "could not locate TUI pin sorting")
  return new Function(`${stripTypeScriptTypes(source.slice(start, end))}; return pinnedFirst`)()
}

function loadAdapter(ctx) {
  const source = readFileSync(join(root, "tui-plugins/sesh-panel/tui.tsx"), "utf8")
  const start = source.indexOf("function createApi")
  const end = source.indexOf("export default Plugin.define", start)
  return new Function("createSignal", "runWithOwner", "createRoot", "hostOwner", `${stripTypeScriptTypes(source.slice(start, end))}; return createApi`)(
    (initial) => { let value = initial; return [() => value, (next) => { value = next }] },
    (_owner, fn) => fn(),
    (fn) => fn(() => {}),
    null,
  )(ctx)
}

{
  let closed
  let cleanup = 0
  let forkInput
  const requests = []
  const api = loadAdapter({
    ui: { dialog: {
      show(_render, onClose) { closed?.(); closed = onClose },
      clear() { const callback = closed; closed = undefined; callback?.() },
    } },
    client: { session: {
      async fork(input) { forkInput = input; return { id: "ses_fork" } },
      async list(input) {
        requests.push(input)
        return { data: [{ id: input.cursor ? "ses_b" : "ses_a", time: { updated: 10 } }], cursor: { next: input.cursor ? undefined : "opaque-next" } }
      },
    } },
  })
  assert.deepEqual(await api.client.session.fork({ sessionID: "ses_original", directory: "/a" }), { data: { id: "ses_fork" } })
  assert.deepEqual(forkInput, { sessionID: "ses_original" })
  api.ui.dialog.replace(() => undefined, () => cleanup++)
  const replacedClose = closed
  api.ui.dialog.replace(() => undefined, () => cleanup++)
  assert.equal(cleanup, 1)
  assert.equal(api.ui.dialog.open, true)
  replacedClose()
  assert.equal(cleanup, 1)
  assert.equal(api.ui.dialog.open, true)
  closed()
  closed()
  assert.equal(cleanup, 2)
  assert.equal(api.ui.dialog.open, false)
  api.ui.dialog.clear()
  assert.equal(cleanup, 2)
  assert.equal(api.ui.dialog.open, false)
  const first = await api.client.experimental.session.list({ limit: 200 })
  const second = await api.client.experimental.session.list({ limit: 200, cursor: first.cursor.next })
  assert.equal(second.data[0].id, "ses_b")
  assert.deepEqual(requests, [{ parentID: null, order: "desc", limit: 200, cursor: undefined }, { parentID: null, order: "desc", limit: 200, cursor: "opaque-next" }])
}

{
  const requests = []
  const layers = []
  const slots = []
  const toasts = []
  const api = loadAdapter({
    keymap: { layer(factory) { layers.push(factory()) } },
    ui: { slot(slot) { slots.push(slot) }, toast: { show(toast) { toasts.push(toast) } } },
    client: { message: { async list(input) {
      requests.push(input)
      const page = input.cursor ? 1 : 0
      return {
        data: input.order === "desc" ? [
          { id: "new", type: "user", text: "latest turn" },
          { id: "older", type: "assistant", content: [{ type: "text", text: "older turn" }] },
        ] : Array.from({ length: 100 }, (_, i) => ({
          id: `${page}-${i}`, type: "assistant", content: [
            { type: "text", text: `text ${page}-${i}` },
            { type: "reasoning", text: "private reasoning" },
            { type: "tool", text: "private tool" },
          ],
        })),
        cursor: { next: page ? undefined : "messages-next" },
      }
    } } },
  })
  const indexed = await api.client.session.messages({ sessionID: "ses_large" })
  assert.equal(indexed.data.length, 200)
  assert.equal(indexed.data[199].parts[0].text, "text 1-99")
  assert.ok(indexed.data.every((m) => !m.parts[0].text.includes("private")))
  assert.equal(requests[1].cursor, "messages-next")
  const preview = await api.client.session.messages({ sessionID: "ses_large", preview: true })
  assert.deepEqual(preview.data.map((m) => m.id), ["older", "new"])
  assert.equal(requests.length, 3)
  assert.equal(requests[2].order, "desc")
  api.keymap.registerLayer({ mode: "modal", bindings: [{ key: "escape", cmd() {} }] })
  api.keymap.registerLayer({ bindings: [{ key: "alt+o", cmd() {} }] })
  assert.deepEqual(layers.map((l) => l.mode), ["modal", "base"])
  assert.ok(layers.every((l) => l.commands.every((c) => c.id === undefined)))
  api.slots.register({ slots: { sidebar_content() {} } })
  assert.equal(slots[0].prepend, "sidebar.content")
  api.ui.toast({ title: "Costs", message: "Loaded" })
  api.ui.toast({ message: "Loaded" })
  assert.deepEqual(toasts.map((t) => t.title), ["Costs", "Sessions"])
}

{
  const source = readFileSync(join(root, "tui-plugins/sesh-panel/tui.tsx"), "utf8")
  for (const start of ["disposePreviewKeys = api.keymap.registerLayer", "disposeConfirm = api.keymap.registerLayer", "const disposeKeys = api.keymap.registerLayer", "const disposeNav = api.keymap.registerLayer"]) {
    for (const match of source.matchAll(new RegExp(start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))) {
      assert.match(source.slice(match.index, match.index + 90), /mode: "modal"/)
    }
  }
  assert.match(source, /void openPicker\(true\)/)
  assert.match(source, /void openCosts\(true\)/)
  assert.match(source, /void openNeeds\(true\)/)
  assert.match(source, /if \(!command && api.renderer.currentFocusedEditor === null\) return/)
}

{
  const source = readFileSync(join(root, "tui-plugins/sesh-panel/tui.tsx"), "utf8")
  const start = source.indexOf("const rootMouseHandlers")
  const end = source.indexOf("type Entry =", start)
  const createMouse = new Function(`${stripTypeScriptTypes(source.slice(start, end))}; return { ensureRootMouse, subscribe: (fn) => rootMouseHandlers.add(fn), dispose: () => removeRootMouse?.() }`)
  let native = 0
  let first = 0
  let second = 0
  let installs = 0
  let down
  const mouseRoot = { _mouseListeners: { down() { native++ } }, set onMouseDown(handler) { down = handler; installs++ } }
  const old = createMouse()
  old.ensureRootMouse({ root: mouseRoot })
  old.subscribe(() => first++)
  down({})
  old.dispose()
  const current = createMouse()
  current.ensureRootMouse({ root: mouseRoot })
  current.subscribe(() => second++)
  down({})
  assert.deepEqual([native, first, second, installs], [2, 1, 1, 1])
  current.dispose()
}

{
  const source = readFileSync(join(root, "tui-plugins/sesh-panel/tui.tsx"), "utf8")
  const start = source.indexOf("function adaptTheme")
  const end = source.indexOf("function createApi", start)
  assert.ok(start >= 0 && end > start, "could not locate V2 theme adapter")
  const rgba = (r, g, b, a = 1) => ({ r, g, b, a })
  const adapt = new Function("RGBA", `${stripTypeScriptTypes(source.slice(start, end))}; return adaptTheme`)({ fromValues: rgba })
  for (const value of [0.1, 0.9]) {
    const text = rgba(value, value, value)
    const accent = rgba(0.2, 0.7, 0.8)
    const string = rgba(0.3, 0.8, 0.2)
    const theme = {
      text: { base: text, muted: text, action: { secondary: { base: text } }, feedback: Object.fromEntries(["error", "warning", "success", "info"].map((key) => [key, { base: accent }])) },
      background: { base: rgba(0, 0, 0, 0), raised: { base: rgba(value, value, value, 0), high: rgba(value, value, value, 0.5) } },
      border: { base: text },
      hue: { accent: { 200: accent } },
      syntax: Object.fromEntries(["comment", "keyword", "function", "variable", "string", "number", "type", "operator", "punctuation"].map((key) => [key, key === "string" ? string : accent])),
      markdown: { link: accent, linkText: accent, blockQuote: accent },
    }
    const mapped = adapt(theme)
    assert.equal(mapped.backgroundPanel.a, 1)
    assert.equal(mapped.backgroundElement.a, 1)
    assert.equal(mapped.backgroundPanel.r, value)
    assert.equal(theme.background.base.a, 0)
    assert.equal(theme.background.raised.base.a, 0)
    assert.equal(mapped.text, text)
    assert.equal(mapped.accent, accent)
    assert.equal(mapped.syntaxString, string)
    assert.notEqual(mapped.syntaxString, mapped.text)
    assert.ok(Object.values(mapped).every((color) => color !== undefined))
  }
}

function loadPickerWindow() {
  const source = readFileSync(join(root, "tui-plugins/sesh-panel/tui.tsx"), "utf8")
  const start = source.indexOf("type PickerRow =")
  const end = source.indexOf("type PinProps =", start)
  assert.ok(start >= 0 && end > start, "could not locate picker viewport logic")
  return new Function(`${stripTypeScriptTypes(source.slice(start, end))}; return { pickerWindow, pickerLastStart }`)()
}

// A wheel step moves a stable window through a directory tree; sticky headings,
// group spacing and excerpts must fit the line budget without dropping rows.
{
  const { pickerWindow, pickerLastStart } = loadPickerWindow()
  const a = { kind: "group", dir: "/a", label: "a", count: 3, pinned: false }
  const b = { kind: "group", dir: "/b", label: "b", count: 1, pinned: false }
  const item = (id, last = false) => ({ kind: "item", entry: { id }, last })
  const rows = [a, item("a1"), item("a2"), item("a3", true), b, item("b1", true)]
  const names = (window) => window.map((row) => row.kind === "group" ? `${row.dir}${row.continued ? "+" : ""}` : row.entry.id)
  assert.deepEqual(names(pickerWindow(rows, 0, 5, () => false)), ["/a", "a1", "a2", "a3"])
  assert.deepEqual(names(pickerWindow(rows, 2, 5, () => false)), ["/a+", "a2", "a3", "/b"])
  assert.deepEqual(names(pickerWindow(rows, 2, 5, (entry) => entry.id === "a2")), ["/a+", "a2", "a3"])
  assert.equal(pickerLastStart(rows, 5, () => false), 3)
  assert.deepEqual(names(pickerWindow(rows, 3, 5, () => false)), ["/a+", "a3", "/b", "b1"])
}

const { fetchEntries, buildSearchIndex, SESSION_PAGE_LIMIT, SESSION_MAX, REMOTE_CONCURRENCY, newestFirst, sidebarMarker, transcriptMatchExcerpt, filterPickerEntries, queryWaitingDetails, contextMenuItems, contextMenuBox, createContextMenu } =
  loadDataLayer()

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

{
  const sessions = sessionsFor(401).map((s) => ({ ...s, time: { updated: 42 } }))
  const { entries, truncated } = await fetchEntries(makeApi(sessions))
  assert.equal(entries.length, 401)
  assert.equal(new Set(entries.map((e) => e.id)).size, 401)
  assert.equal(truncated, false)
}

// The sidebar lists every session without a row cap: all filtered entries
// reach the tree, and overflow scrolls inside the stretched scrollbox.
{
  const source = readFileSync(join(root, "tui-plugins/sesh-panel/tui.tsx"), "utf8")
  assert.doesNotMatch(source, /slice\(0, SIDEBAR_LIMIT\)/)
  assert.doesNotMatch(source, /sidebarRowBudget/)
  assert.match(source, /const shownEntries = createMemo\(\(\) => filteredEntries\(\)\)/)
}

// The delete confirm targets the armed row wherever the pointer is: leaving
// the armed row (edge-hover flicker) must not disarm the pending delete.
{
  const source = readFileSync(join(root, "tui-plugins/sesh-panel/tui.tsx"), "utf8")
  assert.doesNotMatch(source, /pending !== hovered\(\)/)
  assert.match(source, /const confirmArmed = /)
  assert.match(source, /if \(pendingDelete\(\)\) return\s+setQuery\(value\)/)
}

// Slash subcommands exist as separate registrations (the command API never
// passes arguments), each read-only: costs renders a digest, needs opens the
// waiting set. Destructive actions stay CLI-only.
{
  const source = readFileSync(join(root, "tui-plugins/sesh-panel/tui.tsx"), "utf8")
  assert.match(source, /slash: \{ name: "sesh-costs" \}/)
  assert.match(source, /slash: \{ name: "sesh-needs" \}/)
  assert.match(source, /const openCosts = /)
  assert.match(source, /const openNeeds = /)
}

// The sidebar surfaces needs-input triage: a virtual group above the
// directory groups, fed by the shared NEEDS_INPUT_SQL heuristic.
{
  const source = readFileSync(join(root, "tui-plugins/sesh-panel/tui.tsx"), "utf8")
  assert.match(source, /__needs_input__/)
  assert.match(source, /NEEDS_INPUT_SQL/)
  assert.match(source, /need input/)
}

// Space must remain available to both search boxes and the main prompt even
// when a session row is hovered or selected in the sidebar.
{
  const source = readFileSync(join(root, "tui-plugins/sesh-panel/tui.tsx"), "utf8")
  const previewKeys = [...source.matchAll(/key: "([^"]+)",\s*desc: "Preview session transcript"/g)]
  assert.equal(previewKeys.length, 3, "expected hover and sidebar navigation preview bindings")
  assert.ok(previewKeys.every((match) => match[1] === "alt+p"), "Sidebar preview uses Alt/Option-P without stealing Space")
  assert.match(source, /key: "space", preventDefault: true, cmd: \(\) => append\(" "\)/)
}

// Home still floats pinned sessions. Within sidebar/picker directory groups,
// updated time wins even over an older pinned session.
{
  const entries = [
    { id: "ses_recent", dir: "/other", updated: 300 },
    { id: "ses_directory", dir: "/pinned", updated: 200 },
    { id: "ses_old", dir: "/other", updated: 100 },
  ]
  const sorted = loadPinnedSort()(entries, { sessions: ["ses_old"], directories: ["/pinned"] })
  assert.deepEqual(sorted.map((entry) => entry.id), ["ses_old", "ses_directory", "ses_recent"])
  assert.equal(sorted[0], entries[2], "sorting must not replace session records")
  const inDirectory = newestFirst(sorted.filter((entry) => entry.dir === "/other"))
  assert.deepEqual(inDirectory.map((entry) => entry.id), ["ses_recent", "ses_old"])
  assert.deepEqual(sorted.map((entry) => entry.id), ["ses_old", "ses_directory", "ses_recent"], "group sorting must not mutate the pinned list")
}

// Sidebar markers: a working agent spins (even when it is the open session),
// the open session keeps its own dot and every other idle row stays neutral.
{
  assert.equal(sidebarMarker(false, "running"), "running")
  assert.equal(sidebarMarker(false, "busy"), "running")
  assert.equal(sidebarMarker(false, "retry"), "running")
  assert.equal(sidebarMarker(true, "running"), "running")
  assert.equal(sidebarMarker(true, "busy"), "running")
  assert.equal(sidebarMarker(true, "idle"), "current")
  assert.equal(sidebarMarker(false, "idle"), "idle")
  assert.equal(sidebarMarker(false, undefined), "idle")
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
            const start = cursor === undefined ? 0 : Number(cursor)
            return { data: sessions.slice(start, start + limit), cursor: { next: start + limit < sessions.length ? String(start + limit) : undefined } }
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
  assert.equal(api.calls.list[1].cursor, String(SESSION_PAGE_LIMIT))
  assert.equal(api.calls.list[2].cursor, String(2 * SESSION_PAGE_LIMIT))
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

// Picker excerpts come only from text parts, never a repeated cached title or
// unrelated metadata. Filters compose rather than discarding transcript hits.
{
  const entry = { id: "ses_excerpt", title: "Title Only", dir: "/project", group: "project", updated: 1 }
  const cached = loadDataLayer(async () => JSON.stringify({
    title: "Title Only", fulltextLower: "title only A genuine transcript mention of widgets here",
  }))
  const index = await cached.buildSearchIndex(
    { client: { session: { messages: async () => { throw new Error("cache was ignored") } } } }, [entry],
  )
  assert.equal(cached.transcriptMatchExcerpt(index.get(entry.id), entry, "title only"), undefined)
  assert.match(cached.transcriptMatchExcerpt(index.get(entry.id), entry, "widgets"), /widgets/)
  assert.equal(transcriptMatchExcerpt("title only /project tool secret", entry, "absent"), undefined)
  const remote = await buildSearchIndex({ client: { session: { messages: async () => ({ data: [{ parts: [
    { type: "tool", text: "SECRET_TOOL" }, { type: "reasoning", text: "SECRET_REASONING" },
    { type: "text", text: "Visible transcript match" },
  ] }] }) } } }, [entry])
  assert.match(transcriptMatchExcerpt(remote.get(entry.id), entry, "visible"), /visible/)
  assert.equal(transcriptMatchExcerpt(remote.get(entry.id), entry, "SECRET_TOOL"), undefined)
  assert.equal(transcriptMatchExcerpt(remote.get(entry.id), entry, "SECRET_REASONING"), undefined)
  const other = { ...entry, id: "ses_other", group: "elsewhere", title: "Other" }
  const filters = { query: "widgets", scope: "project", waitingOnly: true, pinnedOnly: true }
  assert.deepEqual(filterPickerEntries([entry, other], filters, index, new Set([entry.id]), [entry.id]), [entry])
  assert.deepEqual(filterPickerEntries([entry, other], filters, index, new Set(), [entry.id]), [])
  assert.deepEqual(filterPickerEntries([entry, other], filters, index, new Set([entry.id]), []), [])
}

// Triage timestamps come from the oldest unresolved question/running tool,
// not the last update of a session or a question already answered by a user.
{
  const sqlite = new DatabaseSync(":memory:")
  try {
    sqlite.exec(`CREATE TABLE session_v2 (id TEXT, time_archived INTEGER, parent_id TEXT, time_updated INTEGER);
      CREATE TABLE session_message (session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, data TEXT);`)
    const addSession = sqlite.prepare("INSERT INTO session_v2 VALUES (?, 0, NULL, ?)")
    const addMessage = sqlite.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)")
    const now = Date.now()
    for (const id of ["ses_question", "ses_stuck", "ses_answered", "ses_fresh"]) addSession.run(id, now)
    const question = (created) => JSON.stringify({
      content: [{ type: "tool", name: "question", state: { status: "pending" }, time: { created } }]
    })
    const running = (created) => JSON.stringify({
      content: [{ type: "tool", name: "shell", state: { status: "running" }, time: { created } }]
    })
    addMessage.run("ses_question", 1, "assistant", now - 3_600_000, question(now - 3_600_000))
    addMessage.run("ses_question", 2, "assistant", now - 1_800_000, question(now - 1_800_000))
    addMessage.run("ses_stuck", 1, "assistant", now - 7_200_000, running(now - 7_200_000))
    addMessage.run("ses_answered", 1, "assistant", now - 8_000_000, question(now - 8_000_000))
    addMessage.run("ses_answered", 2, "user", now - 100_000, JSON.stringify({}))
    addMessage.run("ses_fresh", 1, "assistant", now - 1_000, running(now - 1_000))
    const details = await queryWaitingDetails({ query: (sql) => ({ all: (...args) => sqlite.prepare(sql).all(...args) }) })
    assert.equal(details.get("ses_question")?.reason, "question")
    assert.equal(details.get("ses_question")?.since, now - 3_600_000)
    assert.equal(details.get("ses_stuck")?.reason, "stuck")
    assert.equal(details.get("ses_stuck")?.since, now - 7_200_000)
    assert.equal(details.has("ses_answered"), false)
    assert.equal(details.has("ses_fresh"), false)
  } finally {
    sqlite.close()
  }
}

{
  const labels = (items) => items.map((item) => item.label)
  assert.deepEqual(labels(contextMenuItems(false, false)), ["Open", "Preview transcript", "Fork", "Pin", "Delete"])
  assert.deepEqual(labels(contextMenuItems(true, true)), [
    "Open", "Preview transcript", "Open in new cmux workspace", "Fork", "Unpin", "Delete",
  ])

  const box = (x, y, width, height, cols = 80, rows = 24) => contextMenuBox({ x, y, width, height }, cols, rows)
  assert.deepEqual(box(10, 5, 20, 7), { left: 10, top: 6, width: 20, height: 7 })
  assert.deepEqual(box(70, 5, 20, 7), { left: 60, top: 6, width: 20, height: 7 })
  assert.deepEqual(box(10, 22, 20, 7), { left: 10, top: 15, width: 20, height: 7 })
  assert.deepEqual(box(0, 0, 200, 7), { left: 0, top: 1, width: 80, height: 7 })
  assert.deepEqual(box(3, 2, 20, 40), { left: 3, top: 0, width: 20, height: 24 })

  const entry = { id: "ses_menu", title: "Menu", dir: "/p", group: "p", updated: 1 }
  const harness = ({ pinned = false, cmux = false } = {}) => {
    const block = { on: false }
    const layers = new Set()
    const calls = []
    const states = []
    let registered = 0
    const actions = Object.fromEntries(
      ["open", "preview", "fork", "pin", "workspace", "delete"].map((name) => [name, (e) => calls.push([name, e.id])]),
    )
    const menu = createContextMenu({
      registerLayer: (layer) => {
        registered += 1
        layers.add(layer)
        return () => layers.delete(layer)
      },
      actions,
      pinned: () => pinned,
      cmux: () => cmux,
      blocked: () => block.on,
      onChange: (state) => states.push(state),
    })
    const press = (key) => {
      assert.equal(layers.size, 1, `keymap layer must be live to receive ${key}`)
      const [layer] = layers
      layer.bindings.find((binding) => binding.key === key).cmd()
    }
    return { menu, layers, calls, states, press, block, registered: () => registered }
  }

  {
    const h = harness()
    assert.equal(h.layers.size, 0, "no keymap layer before the menu opens")
    h.menu.open(entry, 12, 4)
    assert.equal(h.layers.size, 1)
    assert.deepEqual([h.menu.current().x, h.menu.current().y, h.menu.current().index], [12, 4, 0])
    h.press("down")
    h.press("down")
    assert.equal(h.menu.current().items[h.menu.current().index].id, "fork")
    h.press("up")
    assert.equal(h.menu.current().items[h.menu.current().index].id, "preview")
    h.press("up")
    h.press("up")
    assert.equal(h.menu.current().items[h.menu.current().index].id, "delete", "navigation wraps")
    h.press("down")
    h.press("down")
    h.press("enter")
    assert.deepEqual(h.calls, [["preview", "ses_menu"]])
    assert.equal(h.menu.current(), undefined)
    assert.equal(h.layers.size, 0, "activating an action releases the keymap layer")
    assert.equal(h.states.at(-1), undefined)
  }

  {
    const h = harness()
    h.menu.open(entry, 1, 1)
    h.press("escape")
    assert.equal(h.menu.current(), undefined)
    assert.equal(h.layers.size, 0)
    assert.deepEqual(h.calls, [])
    h.menu.close()
    h.menu.open(entry, 1, 1)
    h.menu.open(entry, 5, 5)
    assert.equal(h.layers.size, 1, "reopening never stacks keymap layers")
    assert.equal(h.registered(), 2)
    assert.deepEqual([h.menu.current().x, h.menu.current().y], [5, 5])
    h.menu.close()
    h.menu.close()
    assert.equal(h.layers.size, 0)
  }

  {
    const h = harness({ pinned: true, cmux: true })
    h.menu.open(entry, 1, 1)
    h.menu.select(2)
    assert.equal(h.menu.current().index, 2)
    h.menu.activate()
    h.menu.open(entry, 1, 1)
    h.menu.select(4)
    h.menu.activate()
    h.menu.open(entry, 1, 1)
    h.menu.activate(0)
    assert.deepEqual(h.calls, [["workspace", "ses_menu"], ["pin", "ses_menu"], ["open", "ses_menu"]])
    assert.equal(h.layers.size, 0)
  }

  {
    const h = harness()
    h.menu.open(entry, 1, 1)
    h.menu.click(0, 2)
    h.menu.click(0, 1)
    assert.deepEqual(h.calls, [], "only the left button activates an item")
    assert.ok(h.menu.current(), "ignored buttons leave the menu open")
    h.menu.click(1, 0)
    assert.deepEqual(h.calls, [["preview", "ses_menu"]])
    assert.equal(h.layers.size, 0)
    h.menu.open(entry, 1, 1)
    h.menu.click(0)
    assert.deepEqual(h.calls.at(-1), ["open", "ses_menu"])
  }

  {
    const h = harness()
    h.block.on = true
    h.menu.open(entry, 1, 1)
    assert.equal(h.menu.current(), undefined, "no menu while a dialog is open")
    assert.equal(h.layers.size, 0)
    h.block.on = false
    h.menu.open(entry, 1, 1)
    h.block.on = true
    const [layer] = h.layers
    layer.bindings.find((binding) => binding.key === "enter").cmd()
    assert.deepEqual(h.calls, [], "a blocked menu never runs an action")
    assert.equal(h.menu.current(), undefined)
    assert.equal(h.layers.size, 0, "a dialog opening releases the menu layer")
    h.block.on = false
    h.menu.open(entry, 1, 1)
    h.block.on = true
    ;[...h.layers][0].bindings.find((binding) => binding.key === "down").cmd()
    assert.equal(h.layers.size, 0)
  }

  {
    const h = harness()
    h.menu.open(entry, 1, 1)
    h.menu.select(4)
    h.menu.activate()
    assert.equal(h.menu.current().confirming, true)
    assert.deepEqual(h.calls, [], "delete waits for confirmation")
    assert.equal(h.layers.size, 1)
    h.press("enter")
    assert.deepEqual(h.calls, [], "the confirmation defaults to cancel")
    assert.equal(h.menu.current(), undefined)
    assert.equal(h.layers.size, 0)

    h.menu.open(entry, 1, 1)
    h.menu.select(4)
    h.menu.activate()
    h.press("escape")
    assert.deepEqual(h.calls, [])
    assert.equal(h.layers.size, 0)

    h.menu.open(entry, 1, 1)
    h.menu.select(4)
    h.menu.activate()
    h.press("up")
    h.press("enter")
    assert.deepEqual(h.calls, [["delete", "ses_menu"]])
    assert.equal(h.layers.size, 0)
  }
}

{
  const source = readFileSync(join(root, "tui-plugins/sesh-panel/tui.tsx"), "utf8")
  const sidebar = source.slice(source.indexOf("function SidebarSessions"), source.indexOf("function HomeSessions"))
  assert.ok(sidebar.length > 1000, "could not locate the sidebar component")
  assert.match(sidebar, /event\.button === RIGHT_BUTTON[\s\S]{0,120}menu\.open\(row\.entry, event\.x, event\.y\)/)
  assert.doesNotMatch(sidebar, /openInCmuxWorkspace\(props\.api, row\.entry\)/)
  assert.match(sidebar, /const onRootMouseDown = \(\) => \{\s+menu\.close\(\)/)
  assert.match(sidebar, /<Portal\s+mount=/)
  assert.match(sidebar, /<Portal[\s\S]*?<Show when=\{menuState\(\)\}>[\s\S]*?<\/Show>\s*<\/Portal>/)
  assert.doesNotMatch(sidebar, /<Show when=\{menuState\(\)\}>\s*<Portal/)
  assert.match(sidebar, /process\.nextTick\(\(\) => container\?\.destroyRecursively\?\.\(\)\)/)
  assert.match(sidebar, /on\(routeKey, \(\) => menu\.close\(\), \{ defer: true \}\)/)
  assert.match(sidebar, /itemRows\(\)\.some\(\(entry\) => entry\.id === state\.entry\.id\)\) menu\.close\(\)/)
  assert.match(sidebar, /if \(props\.api\.ui\.dialog\.open\) menu\.close\(\)/)
  assert.match(sidebar, /blocked: \(\) => props\.api\.ui\.dialog\.open/)
  assert.match(sidebar, /renderer\.on\("resize", closeMenu\)[\s\S]*renderer\.off\("resize", closeMenu\)/)
  assert.match(sidebar, /onMouseScroll=\{\(\) => menu\.close\(\)\}/)
  assert.match(sidebar, /menu\.click\(index\(\), event\.button\)/)
  assert.match(
    sidebar,
    /onMouseUp=\{\(event: \{ button\?: number; stopPropagation: \(\) => void \}\) => \{\s*event\.stopPropagation\(\)\s*menu\.click\(index\(\), event\.button\)/,
    "context menu items must activate on mouseUp so the trailing mouse release does not hit the dialog backdrop",
  )
  assert.doesNotMatch(sidebar, /menu\.activate\(index\(\)\)/)
  assert.match(sidebar, /onCleanup\(\(\) => \{[\s\S]{0,120}menu\.close\(\)/)
}

// Transcript preview esc label allows closing on click
{
  const source = readFileSync(join(root, "tui-plugins/sesh-panel/tui.tsx"), "utf8")
  assert.match(source, /<text style=\{\{ fg: api\.theme\.current\.textMuted \}\} onMouseUp=\{close\}>esc<\/text>/)
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
