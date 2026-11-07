#!/usr/bin/env bun
// Shared harness: render the real picker, /sesh-needs and /sesh-costs dialogs (and the sidebar
// section) through tui() with a mock host API: layout regressions on small
// terminals cannot be caught by the data-layer tests.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { transformSync } from "@babel/core"
import { createRoot, createSignal } from "solid-js"
import { RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { render } from "@opentui/solid"

export const sourcePath = new URL("../tui-plugins/sesh-panel/tui.tsx", import.meta.url)

// Tests must never exec the real cmux CLI, even when the suite itself runs
// inside a cmux terminal. The panel's child_process import is replaced by a
// recorder (globalThis.__seshSpawns), and every CMUX_* variable is dropped so
// cmux detection starts false; tests opt in by setting CMUX_WORKSPACE_ID.
const spawnStub = `data:text/javascript;base64,${Buffer.from(
  `import { spawnSync } from "node:child_process"
export { spawnSync }
export const spawn = (...args) => { (globalThis.__seshSpawns ??= []).push(args); return { on() {} } }`,
).toString("base64")}`
export const resolvePanelImport = (specifier) => (specifier === "node:child_process" ? spawnStub : import.meta.resolve(specifier))
export function stripCmuxEnv() {
  const saved = Object.entries(process.env).filter(([name]) => name.startsWith("CMUX_"))
  for (const [name] of saved) delete process.env[name]
  globalThis.__seshSpawns = []
  return () => {
    for (const name of Object.keys(process.env)) if (name.startsWith("CMUX_")) delete process.env[name]
    for (const [name, value] of saved) process.env[name] = value
  }
}

// Compile a panel source exactly as the published one, plus a test-only fixture.
export async function loadPanel(source = readFileSync(sourcePath, "utf8")) {
  const fixture = `
export { tui as __tui, SidebarSessions as __Sidebar, HomeBottom as __Home }
export function __setDb(run) { clearTranscriptCache(); dbClient = { run, close() {} } }
export function SidebarHost(props) {
  return <box width={props.width} height={props.height}><SidebarSessions {...props.panelProps} /></box>
}
export function HomeHost(props) {
  return <box width={props.width} height={props.height} flexDirection="column"><box height={3} /><HomeBottom {...props.panelProps} /></box>
}
// Host layout pinned to OpenCode v2.2.5, packages/tui/src/ui/dialog.tsx:
// quarter-height anchor, one-row content padding, terminal-minus-two width cap.
export function DialogHost(props) {
  return (
    <box width="100%" height="100%" alignItems="center" paddingTop={props.height / 4}>
      <box width={props.width} paddingTop={1}>{props.content()}</box>
    </box>
  )
}
`
  const { code } = transformSync(source + fixture, {
    filename: "tui-dialogs.tsx",
    babelrc: false,
    configFile: false,
    presets: [
      ["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }],
      ["@babel/preset-typescript", { isTSX: true, allExtensions: true }],
    ],
    plugins: [() => ({ visitor: {
      ImportDeclaration(path) {
        path.node.source.value = resolvePanelImport(path.node.source.value)
      },
    } })],
  })
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)
}

const color = RGBA.fromHex("#ffffff")
export const theme = Object.fromEntries(
  ["text", "textMuted", "warning", "error", "success", "accent", "primary", "info", "background", "backgroundPanel", "backgroundElement", "border", "borderActive"]
    .map((name) => [name, color]),
)

// Session fixtures: long enough titles to exercise truncation.
export const session = (index, title, dir = "/work/project") => ({
  id: `ses_dlg${index}`,
  title,
  directory: dir,
  projectID: "prj_1",
  time: { created: Date.now() - index * 60000 - 5000, updated: Date.now() - index * 60000 },
})

export async function createHarness({ width, height, sessions, waiting = [], costRows = [], transcript = "", source, indexDelay = 0 }) {
  const restoreEnv = stripCmuxEnv()
  const panel = await loadPanel(source)
  const setup = await createTestRenderer({ width, height })
  const dialogs = []
  let commands = []
  const layers = new Set()
  const toasts = []
  const navigations = []
  let cleared = 0
  let listedSessions = [...sessions]
  const dir = mkdtempSync(join(tmpdir(), "sesh-dialogs-"))
  const dbPath = join(dir, "opencode.db")
  const seed = new Database(dbPath)
  seed.exec(`CREATE TABLE session_v2 (id TEXT, directory TEXT);
    CREATE TABLE session_message (session_id TEXT, seq INTEGER, type TEXT, data TEXT, time_created INTEGER);`)
  const insert = seed.prepare("INSERT INTO session_message VALUES (?, 0, 'assistant', ?, ?)")
  costRows.forEach((row, index) => {
    seed.prepare("INSERT INTO session_v2 VALUES (?, ?)").run(`ses_cost${index}`, row.directory)
    insert.run(`ses_cost${index}`, JSON.stringify({ cost: row.cost }), Date.now())
  })
  seed.close()
  const previousDb = process.env.SESH_DB
  process.env.SESH_DB = dbPath
  const previousPins = process.env.SESH_PINS_FILE
  process.env.SESH_PINS_FILE = join(dir, "pins.json")
  const api = {
    renderer: setup.renderer,
    theme: { current: theme },
    mode: { current: () => "base" },
    route: { current: { name: "home" }, navigate(...args) { navigations.push(args) } },
    state: { path: { directory: "/work/project" }, session: { status: () => "idle" } },
    keymap: { registerLayer(layer) { layers.add(layer); return () => layers.delete(layer) } },
    command: { register(factory) { commands = factory() } },
    slots: { register() {} },
    ui: {
      toast(toast) { toasts.push(toast) },
      dialog: {
        open: false,
        replace(content, onClose) { dialogs.push({ content, onClose }) },
        setSize() {},
        clear() { cleared += 1 },
      },
    },
    client: {
      project: { list: async () => ({ data: [{ id: "prj_1", name: "project", canonical: "/work/project" }] }) },
      experimental: { session: { list: async () => ({ data: listedSessions }) } },
      session: {
        messages: async () => ({ data: transcript ? [{ info: { role: "assistant" }, parts: [{ type: "text", text: transcript }] }] : [] }),
        delete: async ({ sessionID }) => { listedSessions = listedSessions.filter((entry) => entry.id !== sessionID); return {} },
        fork: async () => ({ data: { id: "ses_forked" } }),
      },
    },
  }
  panel.__setDb(async (sql) => {
    if (/pragma_table_info/i.test(sql)) return []
    if (sql.includes("question_since")) return []
    if (sql.startsWith("WITH msg AS")) {
      if (indexDelay) await new Promise((resolve) => setTimeout(resolve, indexDelay))
      return sessions.map((entry) => ({ sid: entry.id, text: transcript }))
    }
    return waiting.map((id) => ({ id, reason: "question" }))
  })
  let disposeRoot
  createRoot((dispose) => {
    disposeRoot = dispose
    panel.__tui(api)
  })
  const command = async (slash) => {
    const before = dialogs.length
    commands.find((entry) => entry.slash?.name === slash).onSelect()
    for (let i = 0; i < 50 && dialogs.length === before; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(dialogs.length > before, `/${slash} did not open a dialog`)
    return dialogs.at(-1)
  }
  const show = async (dialog, dialogWidth) => {
    await render(() => panel.DialogHost({ content: dialog.content, width: dialogWidth, height: setup.renderer.height }), setup.renderer)
    await setup.flush()
    await setup.flush()
    await setup.flush()
    return setup.captureCharFrame()
  }
  return {
    api, setup, panel, layers, toasts, navigations, command, show,
    get cleared() { return cleared },
    get spawns() { return globalThis.__seshSpawns },
    setCmux(inside) {
      if (inside) process.env.CMUX_WORKSPACE_ID = "workspace:test"
      else delete process.env.CMUX_WORKSPACE_ID
    },
    press(key) {
      const binding = [...layers].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
        .flatMap((layer) => layer.bindings ?? []).find((entry) => entry.key === key)
      assert.ok(binding, `No binding for ${key}`)
      binding.cmd()
    },
    async sidebar() {
      const entries = sessions.map((entry) => ({ id: entry.id, title: entry.title, dir: entry.directory, group: entry.directory, updated: entry.time.updated }))
      await render(() => panel.SidebarHost({ width, height, panelProps: {
        api, pins: () => ({ sessions: [], directories: [] }), onTogglePin() {},
        poll(listener) { listener({ entries, waiting: new Map(waiting.map((id) => [id, "question"])), running: new Set(), failed: false }); return () => {} },
      } }), setup.renderer)
      await setup.flush()
      await setup.flush()
      await setup.flush()
      return setup.captureCharFrame()
    },
    async home() {
      const entries = sessions.map((entry) => ({ id: entry.id, title: entry.title, dir: entry.directory, group: entry.directory, updated: entry.time.updated }))
      await render(() => panel.HomeHost({ width, height, panelProps: {
        api, pins: () => ({ sessions: [], directories: [] }), onTogglePin() {},
        poll(listener) { listener({ entries, waiting: new Map(), running: new Set(), failed: false }); return () => {} },
      } }), setup.renderer)
      for (let i = 0; i < 5; i++) await setup.flush()
      return setup.captureCharFrame()
    },
    close() {
      for (const dialog of dialogs) dialog.onClose?.()
      disposeRoot?.()
      setup.renderer.destroy?.()
      rmSync(dir, { recursive: true, force: true })
      restoreEnv()
      if (previousPins === undefined) delete process.env.SESH_PINS_FILE
      else process.env.SESH_PINS_FILE = previousPins
      if (previousDb === undefined) delete process.env.SESH_DB
      else process.env.SESH_DB = previousDb
    },
  }
}
