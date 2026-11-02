#!/usr/bin/env node
// Contract regressions for the TUI data layer (tui-plugins/sesh-panel/tui.tsx): global
// session pagination, full transcript-index coverage, bounded remote
// concurrency, and progress reporting. The panel is TSX, so the pure data
// functions are extracted and evaluated with stubbed client/readFile.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
for (const entry of Object.values(manifest.exports)) {
  const source = readFileSync(join(root, entry), "utf8")
  const imports = [...source.matchAll(/^import (?!type\b).* from "([^"]+)"/gm)].map((match) => match[1])
  const jsxSource = source.match(/@jsxImportSource (\S+)/)?.[1]
  if (jsxSource) imports.push(jsxSource)
  for (const specifier of imports) {
    if (specifier.startsWith("node:") || specifier.startsWith(".")) continue
    const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]
    assert.ok(manifest.peerDependencies?.[name] || manifest.dependencies?.[name], `${entry}: runtime import ${name} must be declared`)
  }
}

let stripTypeScriptTypes
try {
  ;({ stripTypeScriptTypes } = await import("node:module"))
} catch {}
if (typeof stripTypeScriptTypes !== "function") {
  console.log("tui data-layer tests skipped: Node lacks module.stripTypeScriptTypes")
  process.exit(0)
}

function loadDataLayer(readExtraction = async () => { throw new Error("no local cache") }, runtime = {}) {
  const source = readFileSync(join(root, "tui-plugins/sesh-panel/tui.tsx"), "utf8")
  const start = source.indexOf("function shortDir")
  const end = source.indexOf("const TRANSCRIPT_PREVIEW_TURNS")
  assert.ok(start >= 0 && end > start, "could not locate the TUI data layer; update this test")
  const js = stripTypeScriptTypes(source.slice(start, end))
  const factory = new Function(
    "readFile",
    "process",
    "setTimeout",
    "setInterval", "clearInterval", "POLL_MS", "existsSync", "spawnSync",
    `${js}
    return { fetchEntries, buildSearchIndex, buildSearchIndexRemote, createSessionPoll, resolveDbPath, openInCmuxWorkspace, SESSION_PAGE_LIMIT, SESSION_MAX, REMOTE_CONCURRENCY, TRANSCRIPT_BATCH, newestFirst, sidebarMarker, transcriptMatchExcerpt, filterPickerEntries, queryWaitingDetails, createDbClient, DB_WORKER_SOURCE, costRowsQuery, contextMenuItems, contextMenuBox, createContextMenu, TRANSCRIPT_BATCH_BYTES, transcriptCache, clearTranscriptCache }`,
  )
  return factory(
    readExtraction,
    { env: { HOME: "/nonexistent", SESH_CACHE_DIR: "/nonexistent/cache" } },
    setTimeout,
    runtime.setInterval ?? setInterval, runtime.clearInterval ?? clearInterval, 15_000,
    runtime.existsSync ?? (() => false), runtime.spawnSync ?? (() => ({ status: 1 })),
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
  assert.equal(slots[0].append, "sidebar.content")
  api.slots.register({ slots: { home_bottom() {} } })
  assert.equal(slots.length, 2)
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

// Plugin disposal releases every slot registration so mounted components stop polling.
{
  const disposed = []
  const api = loadAdapter({ ui: { slot(slot) { const key = slot.append ?? slot.prepend; return () => disposed.push(key) } } })
  api.slots.register({ slots: { sidebar_content() {}, home_bottom() {} } })
  assert.deepEqual(disposed, [])
  api.dispose()
  assert.deepEqual(disposed, ["sidebar.content", "home.footer"])
  api.dispose()
  assert.equal(disposed.length, 2, "dispose is idempotent")
}

// Hiding the session sidebar must not register its component (and therefore
// its polling or keyboard captures), or disable the home list and commands.
{
  for (const [options, visible, placement] of [
    [undefined, true, "append"],
    [{}, true, "append"],
    [{ showSidebar: true }, true, "append"],
    [{ showSidebar: false }, false, "append"],
    [{ sidebarPlacement: "append" }, true, "append"],
    [{ sidebarPlacement: "prepend" }, true, "prepend"],
    [{ showSidebar: false, sidebarPlacement: "append" }, false, "append"],
    [{ showSidebar: false, sidebarPlacement: "prepend" }, false, "prepend"],
    [{ sidebarPlacement: "invalid" }, true, "append"],
  ]) {
    const slots = []
    const layers = []
    const api = loadAdapter({
      options,
      ui: { slot(slot) { slots.push(slot) } },
      keymap: { layer(factory) { layers.push(factory()) } },
    })
    const sidebar = () => { throw new Error("sidebar must not mount during registration") }
    const home = () => {}
    api.slots.register({ slots: { sidebar_content: sidebar, home_bottom: home } })
    assert.deepEqual(slots.map((slot) => slot.append ?? slot.prepend), visible ? ["sidebar.content", "home.footer"] : ["home.footer"])
    assert.equal(slots.at(-1).prepend, "home.footer")
    assert.equal(slots.at(-1).render, home)
    if (visible) {
      assert.equal(slots[0][placement], "sidebar.content")
      assert.equal(slots[0][placement === "append" ? "prepend" : "append"], undefined)
      assert.equal(slots[0].render, sidebar)
    }

    api.command.register(() => [
      { title: "Sessions", value: "sesh", slash: { name: "sesh" }, onSelect() {} },
      { title: "Costs", value: "sesh-costs", slash: { name: "sesh-costs" }, onSelect() {} },
      { title: "Needs input", value: "sesh-needs", slash: { name: "sesh-needs" }, onSelect() {} },
    ])
    api.keymap.registerLayer({ bindings: [{ key: "alt+o", cmd() {} }] })
    assert.deepEqual(layers[0].commands.map((command) => command.slash.name), ["sesh", "sesh-costs", "sesh-needs"])
    assert.equal(layers[1].commands[0].bind, "alt+o")
  }
}

// Custom session lists must offer the same Ctrl-P/Ctrl-N navigation as OpenCode's
// native dialogs without removing arrows or capturing keys outside the modal.
{
  const source = readFileSync(join(root, "tui-plugins/sesh-panel/tui.tsx"), "utf8")
  for (const [name, markerText, endText] of [
    ["picker", 'desc: "Toggle project scope"', "const cleanup ="],
    ["needs-input dialog", 'desc: "Open next waiting session"', "const home ="],
  ]) {
    const marker = source.indexOf(markerText)
    const start = source.lastIndexOf("const disposeNav = api.keymap.registerLayer", marker)
    const end = source.indexOf(endText, start)
    assert.ok(marker >= 0 && start >= 0 && end > marker, `could not locate ${name} navigation bindings`)
    let layer
    const moves = []
    new Function("api", "moveCursor", "togglePreview", "handleEscape", source.slice(start, end))(
      { keymap: { registerLayer(value) { layer = value; return () => {} } } },
      (delta) => moves.push(delta),
      () => {},
      () => {},
    )
    assert.equal(layer.mode, "modal")
    for (const [key, delta] of [["up", -1], ["ctrl+p", -1], ["down", 1], ["ctrl+n", 1]]) {
      const binding = layer.bindings.find((binding) => binding.key === key)
      assert.ok(binding, `${name} must bind ${key}`)
      assert.equal(binding.preventDefault, true, `${key} must be consumed by the modal`)
      binding.cmd()
      assert.equal(moves.at(-1), delta, `${key} must move in the expected direction`)
    }
    assert.deepEqual(moves, [-1, -1, 1, 1])
  }
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

const { fetchEntries, buildSearchIndex, SESSION_PAGE_LIMIT, SESSION_MAX, REMOTE_CONCURRENCY, newestFirst, sidebarMarker, transcriptMatchExcerpt, filterPickerEntries, queryWaitingDetails, createDbClient, DB_WORKER_SOURCE, costRowsQuery, contextMenuItems, contextMenuBox, createContextMenu } =
  loadDataLayer()

// Fake worker that runs DB_WORKER_SOURCE against node:sqlite, with the same
// message protocol and handler properties a Bun Worker exposes.
function fakeWorkerFactory(sqlite, log = {}) {
  return () => {
    const worker = { terminated: false }
    log.created = (log.created ?? 0) + 1
    log.workers = [...(log.workers ?? []), worker]
    const inside = { postMessage: (message) => queueMicrotask(() => worker.onmessage?.({ data: message })) }
    const loadSqlite = async () => ({ Database: class { query(sql) { return { all: (...args) => sqlite.prepare(sql).all(...args).map((row) => ({ ...row })) } } } })
    new Function("self", "loadSqlite", DB_WORKER_SOURCE)(inside, loadSqlite)
    worker.postMessage = (message) => { if (!worker.terminated && !log.hang) queueMicrotask(() => inside.onmessage({ data: message })) }
    worker.terminate = () => { worker.terminated = true }
    return worker
  }
}

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

// The needs-input query costs worker CPU on every poll, so only the sidebar
// (which renders the result) subscribes with `waiting`; the home list must not.
{
  const source = readFileSync(join(root, "tui-plugins/sesh-panel/tui.tsx"), "utf8")
  assert.equal(source.match(/props\.poll\(/g)?.length, 2)
  assert.equal(source.match(/\{ waiting: true \}/g)?.length, 1)
  const start = source.indexOf("function SidebarSessions(")
  const sidebar = source.slice(start, source.indexOf("\nfunction ", start + 1))
  assert.match(sidebar, /setWaiting\(snapshot\.waiting\)[\s\S]*\}, \{ waiting: true \}\)/)
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
  assert.match(transcriptMatchExcerpt(remote.get(entry.id), entry, "visible"), /Visible/)
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
    sqlite.exec(`CREATE TABLE session_v2 (id TEXT, time_archived INTEGER, parent_id TEXT, time_updated INTEGER, time_busy INTEGER, time_idle INTEGER, time_suspended INTEGER);
      CREATE TABLE session_message (session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`)
    const addSession = sqlite.prepare("INSERT INTO session_v2 VALUES (?, 0, NULL, ?, ?, NULL, ?)")
    const addChildSession = sqlite.prepare("INSERT INTO session_v2 VALUES (?, 0, ?, ?, 1, NULL, 1)")
    const addMessage = sqlite.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)")
    const now = Date.now()
    for (const id of ["ses_question", "ses_stuck", "ses_answered", "ses_fresh", "ses_stuck_active", "ses_stuck_parent"]) {
      addSession.run(id, now, 1, 1)
    }
    addSession.run("ses_idlequestion", now, 5, null)
    addSession.run("ses_idlestuck", now, 5, null)
    addChildSession.run("ses_stuck_child", "ses_stuck_parent", now)
    const question = (created) => JSON.stringify({
      content: [{ type: "tool", name: "question", state: { status: "running" }, time: { created } }]
    })
    const running = (created) => JSON.stringify({
      content: [{ type: "tool", name: "shell", state: { status: "running" }, time: { created } }]
    })
    const msg = (session, seq, type, created, data) => addMessage.run(session, seq, type, created, created, data)
    msg("ses_question", 1, "assistant", now - 3_600_000, question(now - 3_600_000))
    msg("ses_question", 2, "assistant", now - 1_800_000, question(now - 1_800_000))
    msg("ses_stuck", 1, "assistant", now - 7_200_000, running(now - 7_200_000))
    msg("ses_answered", 1, "assistant", now - 8_000_000, question(now - 8_000_000))
    msg("ses_answered", 2, "user", now - 100_000, JSON.stringify({}))
    msg("ses_fresh", 1, "assistant", now - 1_000, running(now - 1_000))
    msg("ses_stuck_active", 1, "assistant", now - 7_200_000, running(now - 7_200_000))
    msg("ses_stuck_active", 2, "user", now - 200_000, JSON.stringify({}))
    msg("ses_stuck_parent", 1, "assistant", now - 7_200_000, running(now - 7_200_000))
    msg("ses_stuck_child", 1, "user", now - 200_000, JSON.stringify({}))
    sqlite.prepare("INSERT INTO session_v2 VALUES (?, ?, NULL, ?, 1, NULL, 1)").run("ses_archived", now, now)
    sqlite.prepare("UPDATE session_v2 SET time_idle = 9 WHERE id = ?").run("ses_idlequestion")
    sqlite.prepare("UPDATE session_v2 SET time_idle = 9 WHERE id = ?").run("ses_idlestuck")
    msg("ses_idlequestion", 1, "assistant", now - 3_600_000, question(now - 3_600_000))
    msg("ses_idlestuck", 1, "assistant", now - 7_200_000, running(now - 7_200_000))
    msg("ses_archived", 1, "assistant", now - 3_600_000, question(now - 3_600_000))
    addChildSession.run("ses_subagent_question", "ses_fresh", now)
    msg("ses_subagent_question", 1, "assistant", now - 3_600_000, question(now - 3_600_000))
    const client = createDbClient(fakeWorkerFactory(sqlite))
    const details = await queryWaitingDetails(client.run)
    client.close()
    assert.equal(details.has("ses_idlequestion"), false)
    assert.equal(details.has("ses_idlestuck"), false)
    assert.equal(details.get("ses_question")?.reason, "question")
    assert.equal(details.get("ses_question")?.since, now - 3_600_000)
    assert.equal(details.get("ses_stuck")?.reason, "stuck")
    assert.equal(details.get("ses_stuck")?.since, now - 7_200_000)
    assert.equal(details.has("ses_answered"), false)
    assert.equal(details.has("ses_fresh"), false)
    assert.equal(details.has("ses_stuck_active"), false)
    assert.equal(details.has("ses_stuck_parent"), false)
    assert.equal(details.has("ses_archived"), false)
    assert.equal(details.has("ses_subagent_question"), false)

    // Without the in-flight columns the query scans every assistant message.
    for (const column of ["time_busy", "time_idle", "time_suspended"]) sqlite.exec(`ALTER TABLE session_v2 DROP COLUMN ${column}`)
    const legacyClient = createDbClient(fakeWorkerFactory(sqlite))
    const legacy = await queryWaitingDetails(legacyClient.run)
    legacyClient.close()
    assert.equal(legacy.get("ses_question")?.reason, "question")
    assert.equal(legacy.get("ses_stuck")?.reason, "stuck")
    assert.equal(legacy.get("ses_idlequestion")?.reason, "question")
    assert.equal(legacy.get("ses_idlestuck")?.reason, "stuck")
    assert.equal(legacy.has("ses_answered"), false)
  } finally {
    sqlite.close()
  }
}

// createDbClient: round trip, errors, worker failure, timeout recovery, close.
{
  const sqlite = new DatabaseSync(":memory:")
  try {
    sqlite.exec("CREATE TABLE t (a INTEGER, b TEXT); INSERT INTO t VALUES (1, 'x'), (2, 'y');")
    const log = {}
    const client = createDbClient(fakeWorkerFactory(sqlite, log))
    assert.equal(log.created, undefined, "worker starts lazily")
    assert.deepEqual(await client.run("SELECT b FROM t WHERE a = ?", [2]), [{ b: "y" }])
    assert.deepEqual(await Promise.all([client.run("SELECT 1 AS n"), client.run("SELECT 2 AS n")]), [[{ n: 1 }], [{ n: 2 }]])
    assert.equal(log.created, 1, "one worker serves every request")
    await assert.rejects(client.run("SELECT * FROM missing"), /missing/)
    assert.deepEqual(await client.run("SELECT 3 AS n"), [{ n: 3 }], "query errors keep the worker")
    client.close()
    assert.equal(log.workers[0].terminated, true)
    await assert.rejects(client.run("SELECT 4 AS n"), /local store closed/)
    assert.equal(log.created, 1, "a closed client never starts another worker")
    client.close()
    await assert.rejects(client.run("SELECT 5 AS n"), /local store closed/)
    assert.equal(log.created, 1)

    const failing = createDbClient(() => { throw new Error("no worker") })
    await assert.rejects(failing.run("SELECT 1"), /no worker/)

    const hungLog = { hang: true }
    const hung = createDbClient(fakeWorkerFactory(sqlite, hungLog))
    const pendingA = hung.run("SELECT 1")
    const pendingB = hung.run("SELECT 2")
    hungLog.workers[0].onerror({ message: "boom", preventDefault() {} })
    await assert.rejects(pendingA, /boom/)
    await assert.rejects(pendingB, /boom/)
    assert.equal(hungLog.workers[0].terminated, true)
    hungLog.hang = false
    assert.deepEqual(await hung.run("SELECT 5 AS n"), [{ n: 5 }])
    assert.equal(hungLog.created, 2)
    hung.close()

    const slowLog = { hang: true }
    const slow = createDbClient(fakeWorkerFactory(sqlite, slowLog), 20)
    const keepAlive = setInterval(() => {}, 5) // the client's timer is unref'd
    await assert.rejects(slow.run("SELECT 1"), /timed out/)
    clearInterval(keepAlive)
    assert.equal(slowLog.workers[0].terminated, true)
    slowLog.hang = false
    assert.deepEqual(await slow.run("SELECT 6 AS n"), [{ n: 6 }])
    assert.equal(slowLog.created, 2, "a timeout recreates the worker")
    slow.close()
  } finally {
    sqlite.close()
  }
}

{
  const db = new DatabaseSync(":memory:")
  try {
    db.exec(`CREATE TABLE session_v2 (id TEXT, directory TEXT);
      CREATE TABLE session_message (session_id TEXT, type TEXT, time_created INTEGER, data TEXT);
      INSERT INTO session_v2 VALUES ('ses_new', '/project');
      INSERT INTO session_message VALUES ('ses_new', 'assistant', 2000, '{"cost":3}');`)
    const row = (legacy) => db.prepare(costRowsQuery(1000, legacy)).get()
    assert.equal(row(false).lifetime_cost, 3)
    db.exec(`CREATE TABLE session (id TEXT, directory TEXT);
      CREATE TABLE message (session_id TEXT, time_created INTEGER, data TEXT);
      INSERT INTO session VALUES ('ses_new', '/project'), ('ses_old', '/project');
      INSERT INTO message VALUES ('ses_old', 2000, '{"role":"assistant","cost":4}'),
        ('ses_old', 500, '{"role":"assistant","cost":6}'),
        ('ses_new', 2000, '{"role":"assistant","cost":100}'),
        ('ses_old', 2000, '{"role":"user","cost":100}');`)
    assert.equal(row(true).lifetime_cost, 13)
    assert.equal(row(true).window_cost, 7)
    assert.equal(row(true).sessions, 2)
  } finally {
    db.close()
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
    // A still pointer re-fires hover; republishing an identical selection
    // would rebuild the keyed menu every frame until clicks fall through it.
    const h = harness()
    h.menu.open(entry, 1, 1)
    const published = h.states.length
    h.menu.select(0)
    h.menu.select(0)
    assert.equal(h.states.length, published, "redundant hover must not republish")
    assert.equal(h.menu.current().index, 0)
    h.menu.select(2)
    assert.equal(h.states.length, published + 1, "genuine hover moves still publish")
    assert.equal(h.menu.current().index, 2)
    h.menu.select(2)
    assert.equal(h.states.length, published + 1)
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
  assert.match(sidebar, /const menuView = createMemo\(\(\) => \{/)
  assert.match(sidebar, /event\.button === RIGHT_BUTTON[\s\S]{0,120}menu\.open\(row\.entry, event\.x, event\.y\)/)
  assert.match(
    sidebar,
    /onMouseDown=\{\(event: \{ button\?: number; stopPropagation: \(\) => void \}\) => \{\s*event\.stopPropagation\(\)\s*if \(event\.button === RIGHT_BUTTON\) return\s*toggleGroup\(row\.dir\)/,
    "right-clicking a group header must not collapse the group",
  )
  assert.doesNotMatch(sidebar, /openInCmuxWorkspace\(props\.api, row\.entry\)/)
  assert.match(sidebar, /const onRootMouseDown = \(\) => \{\s+menu\.close\(\)/)
  assert.match(sidebar, /preview\.closeIfOpen\(\)/, "one outside press must close an open preview")
  assert.match(sidebar, /<Portal\s+mount=/)
  assert.match(sidebar, /<Portal[\s\S]*?<Show when=\{menuView\(\)\} keyed>[\s\S]*?<\/Show>\s*<\/Portal>/)
  assert.doesNotMatch(sidebar, /<Show when=\{menuView\(\)\} keyed>\s*<Portal/)
  assert.doesNotMatch(sidebar, /<Show when=\{menuState\(\)\}/)
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

// Cancellation stops new pages/workers, including message pagination inside a
// single remote transcript. Search must still walk all pages while active.
{
  let active = true
  const requests = []
  const api = loadAdapter({ client: { message: { async list(input) {
    requests.push(input)
    active = false
    return { data: [{ id: "one", type: "user", text: "Original Case" }], cursor: { next: "next" } }
  } } } })
  await api.client.session.messages({ sessionID: "ses_cancel", active: () => active })
  assert.equal(requests.length, 1)

  active = true
  const sessions = makeApi(sessionsFor(401))
  const list = sessions.client.experimental.session.list
  sessions.client.experimental.session.list = async (input) => {
    const page = await list(input)
    active = false
    return page
  }
  await fetchEntries(sessions, () => active)
  assert.equal(sessions.calls.list.length, 1)

  active = true
  const entries = (await fetchEntries(makeApi(sessionsFor(64)))).entries
  let remoteCalls = 0
  const progress = []
  await buildSearchIndex({ client: { session: { async messages(input) {
    assert.equal(input.preview, undefined, "transcript search must not request a truncated preview")
    assert.equal(typeof input.active, "function")
    remoteCalls++
    active = false
    return { data: [] }
  } } } }, entries, (value) => progress.push(value), () => active)
  assert.equal(remoteCalls, 1, "cancelled workers must not claim more sessions")
  assert.ok(progress.every((value) => !value.complete))
  const cancelled = loadDataLayer(async () => { active = false; throw new Error("cache unavailable") })
  active = true
  await cancelled.buildSearchIndex({ client: { session: { messages() { throw new Error("must not request after cancellation") } } } }, entries, undefined, () => active)
}

// Original text survives both local extraction and remote indexing; matching
// remains case-insensitive and ignores metadata when selecting an excerpt.
{
  const data = loadDataLayer()
  const entry = { id: "ses_case", title: "Original Title", dir: "/Case", group: "Case" }
  const sqlite = new DatabaseSync(":memory:")
  sqlite.exec("CREATE TABLE session_message (session_id TEXT, seq INTEGER, type TEXT, data TEXT, time_updated INTEGER DEFAULT 0)")
  sqlite.prepare("INSERT INTO session_message (session_id, seq, type, data) VALUES (?, 1, 'user', ?)").run(entry.id, JSON.stringify({ text: "Read README.md and Use GitHub" }))
  const index = await data.buildSearchIndex({}, [entry], undefined, undefined, async (sql, params = []) => sqlite.prepare(sql).all(...params), new Map())
  sqlite.close()
  assert.match(data.transcriptMatchExcerpt(index.get(entry.id), entry, "readme"), /README\.md/)
  assert.deepEqual(data.filterPickerEntries([entry], { query: "GITHUB" }, index, new Set(), []), [entry])
  const toasts = []
  data.openInCmuxWorkspace({ ui: { toast: (value) => toasts.push(value) } }, { ...entry, id: "ses_bad;touch injected" })
  assert.equal(toasts[0].message, "Invalid session ID")
}

// Local extraction returns text only, equals the old JSON.parse extraction, and
// survives malformed rows. The oracle below is the pre-SQL reference.
{
  const data = loadDataLayer()
  const sqlite = new DatabaseSync(":memory:")
  sqlite.exec("CREATE TABLE session_message (session_id TEXT, seq INTEGER, type TEXT, data TEXT, time_updated INTEGER DEFAULT 0)")
  const add = sqlite.prepare("INSERT INTO session_message (session_id, seq, type, data) VALUES (?, ?, ?, ?)")
  const j = JSON.stringify
  const total = data.TRANSCRIPT_BATCH * 2 + 3
  const entries = Array.from({ length: total }, (_, n) => ({
    id: `ses_idx${String(n).padStart(4, "0")}`, title: `Title ${n}`, dir: "/proj", group: "proj", updated: n,
  }))
  for (const [n, entry] of entries.entries()) {
    add.run(entry.id, 3, "assistant", j({ content: [
      { type: "text", text: `answer-a ${n}` }, { type: "tool", text: `SECRET_TOOL_${n}`, state: { output: "SECRET_OUT" } },
      { type: "reasoning", text: `SECRET_REASONING_${n}` }, { type: "text", text: `answer-b ${n}` },
    ] }))
    add.run(entry.id, 1, "user", j({ text: `question ${n}` }))
    add.run(entry.id, 2, "tool", j({ text: "SECRET_TOOL_MESSAGE" }))
    add.run(entry.id, 4, "assistant", "{ not json")
    add.run(entry.id, 5, "assistant", j({ content: "SECRET_STRING_CONTENT", text: 42 }))
    add.run(entry.id, 6, "assistant", j({ content: { type: "text", text: "SECRET_OBJECT_CONTENT" } }))
    add.run(entry.id, 7, "assistant", j({ content: ["bare string", 7, null, { type: "text", text: 9 }, { type: "text", text: `tail ${n}` }] }))
    add.run(entry.id, 8, "assistant", j("scalar json string"))
  }
  const run = async (sql, params = []) => sqlite.prepare(sql).all(...params)
  const oracle = (sid, base) => {
    let value = base
    const rows = sqlite.prepare("SELECT data FROM session_message WHERE session_id = ? AND type IN ('user','assistant') ORDER BY seq").all(sid)
    for (const row of rows) {
      try {
        const message = JSON.parse(row.data)
        const texts = []
        if (typeof message?.text === "string") texts.push(message.text)
        if (Array.isArray(message?.content)) for (const part of message.content) if (part?.type === "text" && typeof part.text === "string") texts.push(part.text)
        for (const text of texts) value = `${value} ${text}`.trim()
      } catch {}
    }
    return value
  }

  const progress = []
  const index = await data.buildSearchIndex({}, entries, (p) => progress.push({ ...p }), undefined, run, new Map())
  for (const [n, entry] of entries.entries()) {
    assert.equal(index.get(entry.id), oracle(entry.id, `${entry.title} ${entry.dir}`), entry.id)
    assert.equal(index.get(entry.id), `Title ${n} /proj question ${n} answer-a ${n} answer-b ${n} tail ${n}`)
  }
  assert.ok(![...index.values()].some((text) => text.includes("SECRET")), "tool/reasoning/non-text payloads must not be indexed")
  assert.equal(progress.at(-1).total, total)
  assert.equal(progress.at(-1).indexed, total)
  assert.equal(progress.at(-1).complete, true)
  assert.deepEqual(progress.filter((p) => !p.complete).map((p) => p.indexed), [0, data.TRANSCRIPT_BATCH, data.TRANSCRIPT_BATCH * 2, total])

  // Cancellation after the first batch stops further queries.
  let active = true
  let queries = 0
  const cancelled = await data.buildSearchIndex({ client: { session: { messages() { throw new Error("must not go remote") } } } }, entries, undefined, () => active, async (sql, params) => {
    const rows = await run(sql, params)
    if (sql.startsWith("WITH msg")) { queries++; active = false }
    return rows
  }, new Map())
  assert.equal(queries, 1)
  assert.equal(cancelled.get(entries[0].id), `${entries[0].title} ${entries[0].dir}`, "a cancelled batch must not publish")

  // A rejecting run mid-walk sends only the unindexed sessions to the remote path.
  let calls = 0
  const remoteIds = []
  const partial = await data.buildSearchIndex({ client: { session: { async messages(input) {
    remoteIds.push(input.sessionID)
    return { data: [{ parts: [{ type: "text", text: "from remote" }] }] }
  } } } }, entries, undefined, undefined, async (sql, params) => {
    if (++calls === 3) throw new Error("worker died")
    return run(sql, params)
  }, new Map())
  assert.equal(calls, 3)
  assert.deepEqual(remoteIds.sort(), entries.slice(data.TRANSCRIPT_BATCH).map((entry) => entry.id))
  assert.match(partial.get(entries[0].id), /answer-a 0/)
  assert.doesNotMatch(partial.get(entries[0].id), /from remote/)
  assert.match(partial.get(entries.at(-1).id), /from remote/)
  sqlite.close()
}

// Unchanged sessions reuse in-memory transcript text; changed ones re-extract,
// vanished ones are pruned, and batches are bounded by payload bytes.
{
  const data = loadDataLayer()
  const sqlite = new DatabaseSync(":memory:")
  sqlite.exec("CREATE TABLE session_message (session_id TEXT, seq INTEGER, type TEXT, data TEXT, time_updated INTEGER DEFAULT 0)")
  const add = (sid, seq, text, updated = 1) =>
    sqlite.prepare("INSERT INTO session_message (session_id, seq, type, data, time_updated) VALUES (?, ?, 'user', ?, ?)").run(sid, seq, JSON.stringify({ text }), updated)
  const entries = ["ses_c1", "ses_c2", "ses_c3"].map((id, n) => ({ id, title: `T${n}`, dir: "/p", group: "p", updated: 5 }))
  for (const entry of entries) add(entry.id, 1, `hello ${entry.id}`)
  const calls = { signature: 0, extract: 0 }
  const run = async (sql, params = []) => {
    calls[sql.startsWith("WITH msg") ? "extract" : "signature"]++
    return sqlite.prepare(sql).all(...params)
  }
  const never = { client: { session: { messages() { throw new Error("must stay local") } } } }
  const cache = new Map()

  const first = await data.buildSearchIndex(never, entries, undefined, undefined, run, cache)
  assert.deepEqual(calls, { signature: 1, extract: 1 })
  assert.equal(first.get("ses_c2"), "T1 /p hello ses_c2")

  const progress = []
  const second = await data.buildSearchIndex(never, entries, (p) => progress.push({ ...p }), undefined, run, cache)
  assert.deepEqual(calls, { signature: 2, extract: 1 }, "unchanged sessions issue no extraction query")
  assert.deepEqual([...second], [...first])
  assert.deepEqual(progress.map((p) => p.indexed), [0, 3, 3])
  assert.equal(progress.at(-1).complete, true)

  add("ses_c2", 2, "appended", 2)
  const third = await data.buildSearchIndex(never, entries, undefined, undefined, run, cache)
  assert.equal(calls.extract, 2)
  assert.equal(third.get("ses_c2"), "T1 /p hello ses_c2 appended")
  assert.equal(third.get("ses_c1"), first.get("ses_c1"))

  const bumped = entries.map((entry) => entry.id === "ses_c3" ? { ...entry, updated: 6 } : entry)
  await data.buildSearchIndex(never, bumped, undefined, undefined, run, cache)
  assert.equal(calls.extract, 3, "a newer session timestamp re-extracts")

  await data.buildSearchIndex(never, entries.slice(0, 1), undefined, undefined, run, cache)
  assert.deepEqual([...cache.keys()], ["ses_c1"], "deleted sessions are pruned")

  // Remote fallback results are never cached.
  const remoteCache = new Map()
  await data.buildSearchIndex({ client: { session: { async messages() { return { data: [{ parts: [{ type: "text", text: "r" }] }] } } } } },
    entries, undefined, undefined, async () => { throw new Error("no store") }, remoteCache)
  assert.equal(remoteCache.size, 0)

  // A failing signature query (SQLite without octet_length) still extracts
  // locally, but caches nothing.
  const noSigCache = new Map()
  const noSig = await data.buildSearchIndex(never, entries, undefined, undefined, async (sql, params = []) => {
    if (!sql.startsWith("WITH msg")) throw new Error("no such function: octet_length")
    return sqlite.prepare(sql).all(...params)
  }, noSigCache)
  assert.equal(noSig.get("ses_c2"), third.get("ses_c2"))
  assert.equal(noSigCache.size, 0)

  // Cancellation during signature lookup issues no extraction.
  let active = true
  const before = calls.extract
  await data.buildSearchIndex(never, entries, undefined, () => active, async (sql, params) => { active = false; return run(sql, params) }, new Map())
  assert.equal(calls.extract, before)

  // The plugin-lifetime cache can be cleared.
  data.transcriptCache.set("ses_x", { sig: "s", text: "t" })
  data.clearTranscriptCache()
  assert.equal(data.transcriptCache.size, 0)

  // Batches are bounded by bytes; one oversized session forms its own batch.
  const big = (n) => "x".repeat(Math.floor(data.TRANSCRIPT_BATCH_BYTES * n))
  const sizes = [["ses_b1", 0.6], ["ses_b2", 0.6], ["ses_b3", 1.5], ["ses_b4", 0.01], ["ses_b5", 0.01]]
  const bigEntries = sizes.map(([id]) => ({ id, title: id, dir: "/p", group: "p", updated: 1 }))
  for (const [id, n] of sizes) add(id, 1, big(n))
  const batches = []
  const index = await data.buildSearchIndex(never, bigEntries, undefined, undefined, async (sql, params = []) => {
    if (sql.startsWith("WITH msg")) batches.push(params)
    return sqlite.prepare(sql).all(...params)
  }, new Map())
  assert.deepEqual(batches, [["ses_b1"], ["ses_b2"], ["ses_b3"], ["ses_b4", "ses_b5"]])
  assert.equal(index.get("ses_b3").length, "ses_b3 /p ".length + big(1.5).length)
  sqlite.close()
}

// A successful fallback path is resolved once; unsuccessful resolution retries.
{
  let calls = 0
  const data = loadDataLayer(undefined, {
    existsSync: (path) => path === "/resolved/opencode.db",
    spawnSync: () => { calls++; return { status: 0, stdout: "db /resolved/opencode.db\n" } },
  })
  assert.equal(data.resolveDbPath(), "/resolved/opencode.db")
  assert.equal(data.resolveDbPath(), "/resolved/opencode.db")
  assert.equal(calls, 1)
}

// Sidebar/home share a single flight and timer. Unchanged rows retain identity,
// and the last unsubscribe stops polling without affecting other subscribers.
{
  let tick
  let timers = 0
  let clears = 0
  const data = loadDataLayer(undefined, {
    setInterval: (callback) => { tick = callback; timers++; return 1 },
    clearInterval: () => { clears++ },
  })
  const api = makeApi(sessionsFor(2))
  const list = api.client.experimental.session.list
  let release
  api.client.experimental.session.list = async (input) => {
    await new Promise((resolve) => { release = resolve })
    return list(input)
  }
  let refreshes = 0
  const subscribe = data.createSessionPoll(api, () => refreshes++)
  const seen = []
  const first = subscribe((snapshot) => seen.push(snapshot))
  const second = subscribe(() => {})
  await delay(0)
  tick()
  assert.equal(refreshes, 1)
  assert.equal(timers, 1)
  release()
  await delay(10)
  const entries = seen.at(-1).entries
  assert.equal(entries.length, 2)
  tick()
  await delay(0)
  release()
  await delay(10)
  assert.equal(seen.at(-1).entries, entries)
  first()
  assert.equal(clears, 0)
  second()
  assert.equal(clears, 1)
  tick()
  assert.equal(refreshes, 2)
}

// A running poll reloads for a new `waiting` subscriber that has no needs-input
// result yet, never for a subscriber that does not read it.
{
  let tick
  const data = loadDataLayer(undefined, { setInterval: (callback) => { tick = callback; return 1 }, clearInterval: () => {} })
  let refreshes = 0
  const subscribe = data.createSessionPoll(makeApi(sessionsFor(1)), () => refreshes++)
  const home = subscribe(() => {})
  await delay(10)
  assert.equal(refreshes, 1)
  subscribe(() => {})
  await delay(10)
  assert.equal(refreshes, 1)
  subscribe(() => {}, { waiting: true })
  await delay(10)
  assert.equal(refreshes, 2)
  home()
  tick()
  await delay(10)
  assert.equal(refreshes, 3)
}

// Mutation fails closed for corrupt/unreadable existing pins; only an absent
// file starts empty. Use real files so failed toggles prove bytes are preserved.
{
  const dir = await fs.mkdtemp(join(tmpdir(), "sesh-tui-pins-"))
  const file = join(dir, "pins.json")
  try {
    const source = readFileSync(join(root, "tui-plugins/sesh-panel/tui.tsx"), "utf8")
    const code = source.slice(source.indexOf("type Pins ="), source.indexOf("function pinnedFirst"))
    const names = ["lstat", "mkdir", "readFile", "rename", "rmdir", "unlink", "writeFile"]
    const pins = new Function(...names, "join", "dirname", "process", `${stripTypeScriptTypes(code)}; return { readPins, togglePin }`)(
      ...names.map((name) => fs[name]), join, dirname, { env: { SESH_PINS_FILE: file }, pid: process.pid, kill: process.kill.bind(process) },
    )
    assert.deepEqual(await pins.togglePin("sessions", "ses_first"), { sessions: ["ses_first"], directories: [] })
    for (const malformed of ["not json", "null", "[]", '{}', '{"sessions":null,"directories":[]}', '{"sessions":[]}', '{"sessions":[7],"directories":[]}', '{"sessions":[],"directories":"bad"}']) {
      await fs.writeFile(file, malformed)
      assert.deepEqual(await pins.readPins(), { sessions: [], directories: [] })
      await assert.rejects(pins.togglePin("sessions", "ses_second"))
      assert.equal(await fs.readFile(file, "utf8"), malformed)
      await assert.rejects(fs.stat(`${file}.lock`), { code: "ENOENT" })
    }
    await fs.unlink(file)
    await fs.symlink(join(dir, "missing"), file)
    await assert.rejects(pins.togglePin("sessions", "ses_second"))
    assert.ok((await fs.lstat(file)).isSymbolicLink())
    await fs.unlink(file)
    await fs.writeFile(file, '{"sessions":[],"directories":[]}\n')
    await fs.mkdir(`${file}.lock`)
    await fs.writeFile(`${file}.lock/pid`, "99999999\n")
    const contenders = await Promise.allSettled([
      pins.togglePin("sessions", "ses_second"), pins.togglePin("sessions", "ses_third"),
    ])
    assert.ok(contenders.every((result) => result.status === "rejected" && /stop all sesh/.test(result.reason.message)))
    assert.equal(await fs.readFile(`${file}.lock/pid`, "utf8"), "99999999\n")
    assert.deepEqual(await pins.readPins(true), { sessions: [], directories: [] })
    await fs.unlink(`${file}.lock/pid`)
    await fs.rmdir(`${file}.lock`)
    await Promise.all([pins.togglePin("sessions", "ses_second"), pins.togglePin("sessions", "ses_third")])
    assert.deepEqual((await pins.readPins(true)).sessions.sort(), ["ses_second", "ses_third"])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

// Fractional wheel deltas accumulate instead of disappearing. Internal search
// clicks stop propagation, so no stale flag may swallow the next outside click.
{
  const source = readFileSync(join(root, "tui-plugins/sesh-panel/tui.tsx"), "utf8")
  const start = source.indexOf("let scrollRemainder =")
  const end = source.indexOf("// Delete confirmation lives", start)
  let viewport = 10
  const scroll = new Function("showPreview", "setViewportStart", "maxViewportStart", `${stripTypeScriptTypes(source.slice(start, end))}; return scrollPicker`)(
    () => false, (update) => { viewport = update(viewport) }, () => 100,
  )
  for (let i = 0; i < 4; i++) scroll({ direction: "down", delta: 0.25 })
  assert.equal(viewport, 11)
  scroll({ direction: "up", delta: 1.5 })
  scroll({ direction: "up", delta: 0.5 })
  assert.equal(viewport, 9)
  assert.doesNotMatch(source, /insideSearchBox|remaining\(\)/)
  const sidebar = source.slice(source.indexOf("function SidebarSessions"), source.indexOf("const HOME_SESSION_LIMIT"))
  const nav = sidebar.slice(sidebar.indexOf("if (!navActive()) return"))
  assert.doesNotMatch(nav.slice(0, nav.indexOf("onCleanup")), /key: "[yn]"/)
  assert.match(sidebar, /if \(navActive\(\)\) return\s+const entry = hoveredEntry\(\)/)
  for (const [from, to] of [["function SidebarSessions", "const HOME_SESSION_LIMIT"], ["function HomeSessions", "const tui:"], ["const cleanup = () => {\n      if (!alive)", "api.ui.dialog.replace"]]) {
    const segment = source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)))
    assert.match(segment, /if \(confirmTimer\) clearTimeout\(confirmTimer\)/)
  }
  assert.match(source, /onCleanup\(disposePickerKey\)/)
}

console.log("tui data-layer tests passed")
