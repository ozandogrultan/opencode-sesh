/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Project, SessionInfo as Session } from "@opencode/client"
import type { Accessor } from "solid-js"

type TuiPluginApi = ReturnType<typeof createApi>
type TuiPlugin = (api: TuiPluginApi) => Promise<void>
import { createEffect, createMemo, createRoot, createSignal, For, getOwner, on, onCleanup, onMount, runWithOwner, Show } from "solid-js"
import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"
import { getTreeSitterClient, RGBA, SyntaxStyle, TextAttributes } from "@opentui/core"
import { Portal } from "@opentui/solid"

type ThemeColors = TuiPluginApi["theme"]["current"]

let markdownStyleCache: { theme: ThemeColors; style: SyntaxStyle } | undefined

function buildMarkdownStyle(theme: ThemeColors): SyntaxStyle {
  return SyntaxStyle.fromTheme([
    { scope: ["default"], style: { foreground: theme.text } },
    { scope: ["comment", "comment.documentation"], style: { foreground: theme.syntaxComment, italic: true } },
    { scope: ["string", "symbol", "character"], style: { foreground: theme.syntaxString } },
    { scope: ["number", "boolean", "constant", "float"], style: { foreground: theme.syntaxNumber } },
    {
      scope: ["keyword", "keyword.import", "keyword.directive", "keyword.modifier", "keyword.exception"],
      style: { foreground: theme.syntaxKeyword, italic: true },
    },
    {
      scope: ["keyword.return", "keyword.conditional", "keyword.repeat", "keyword.coroutine"],
      style: { foreground: theme.syntaxKeyword, italic: true },
    },
    { scope: ["keyword.type"], style: { foreground: theme.syntaxType, bold: true, italic: true } },
    {
      scope: ["keyword.function", "function.method", "function", "constructor", "variable.member"],
      style: { foreground: theme.syntaxFunction },
    },
    {
      scope: ["operator", "keyword.operator", "punctuation.delimiter", "punctuation.special"],
      style: { foreground: theme.syntaxOperator },
    },
    {
      scope: ["variable", "variable.parameter", "function.method.call", "function.call", "property", "parameter"],
      style: { foreground: theme.syntaxVariable },
    },
    { scope: ["type", "module", "class"], style: { foreground: theme.syntaxType } },
    { scope: ["punctuation", "punctuation.bracket"], style: { foreground: theme.syntaxPunctuation } },
    {
      scope: [
        "variable.builtin",
        "type.builtin",
        "function.builtin",
        "module.builtin",
        "constant.builtin",
        "variable.super",
      ],
      style: { foreground: theme.error },
    },
    // Some opencode themes give Markdown roles the same foreground as body
    // text. Use their semantic accents here so transcript structure remains
    // legible without recoloring the surrounding TUI or ordinary prose.
    { scope: ["markup.heading"], style: { foreground: theme.accent, bold: true } },
    {
      scope: ["markup.heading.1"],
      style: { foreground: theme.primary, bold: true, underline: true },
    },
    {
      scope: ["markup.heading.2", "markup.heading.3", "markup.heading.4", "markup.heading.5", "markup.heading.6"],
      style: { foreground: theme.accent, bold: true },
    },
    { scope: ["markup.bold", "markup.strong"], style: { foreground: theme.accent, bold: true } },
    { scope: ["markup.italic"], style: { foreground: theme.syntaxString, italic: true } },
    { scope: ["markup.list"], style: { foreground: theme.syntaxKeyword } },
    { scope: ["markup.quote"], style: { foreground: theme.markdownBlockQuote, italic: true } },
    { scope: ["markup.raw", "markup.raw.block"], style: { foreground: theme.syntaxString } },
    { scope: ["markup.raw.inline"], style: { foreground: theme.syntaxString, background: theme.backgroundElement } },
    {
      scope: ["markup.link", "markup.link.url", "string.special", "string.special.url"],
      style: { foreground: theme.markdownLink, underline: true },
    },
    { scope: ["markup.link.label", "label"], style: { foreground: theme.markdownLinkText, underline: true } },
    { scope: ["conceal"], style: { foreground: theme.textMuted } },
  ])
}

function getMarkdownStyle(theme: ThemeColors): SyntaxStyle | undefined {
  if (markdownStyleCache?.theme === theme) return markdownStyleCache?.style
  try {
    markdownStyleCache = { theme, style: buildMarkdownStyle(theme) }
    return markdownStyleCache?.style
  } catch {
    try {
      return SyntaxStyle.create()
    } catch {
      return undefined
    }
  }
}

type Pins = { sessions: string[]; directories: string[] }
const emptyPins = (): Pins => ({ sessions: [], directories: [] })
const pinsPath = () =>
  process.env.SESH_PINS_FILE ?? join(process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "", ".local/share"), "sesh/pins.json")

async function readPins(): Promise<Pins> {
  try {
    const data = JSON.parse(await readFile(pinsPath(), "utf8")) as Partial<Pins>
    return {
      sessions: Array.isArray(data.sessions) ? data.sessions.filter((id): id is string => typeof id === "string") : [],
      directories: Array.isArray(data.directories) ? data.directories.filter((dir): dir is string => typeof dir === "string") : [],
    }
  } catch {
    return emptyPins()
  }
}

async function togglePin(kind: keyof Pins, value: string): Promise<Pins> {
  const file = pinsPath()
  await mkdir(dirname(file), { recursive: true })
  const lock = `${file}.lock`
  let locked = false
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await mkdir(lock)
      locked = true
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      try {
        const owner = Number((await readFile(join(lock, "pid"), "utf8")).trim())
        if (Number.isSafeInteger(owner) && owner > 0) {
          try {
            process.kill(owner, 0)
          } catch (check) {
            if ((check as NodeJS.ErrnoException).code === "ESRCH") {
              await unlink(join(lock, "pid")).catch(() => {})
              await rmdir(lock).catch(() => {})
            }
          }
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  if (!locked) throw new Error("pins are busy")
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`
  try {
    await writeFile(join(lock, "pid"), `${process.pid}\n`)
    const next = await readPins()
    next[kind] = next[kind].includes(value) ? next[kind].filter((item) => item !== value) : [...next[kind], value]
    await writeFile(tmp, JSON.stringify(next) + "\n", { mode: 0o600 })
    await rename(tmp, file)
    return next
  } finally {
    await unlink(tmp).catch(() => {})
    await unlink(join(lock, "pid")).catch(() => {})
    await rmdir(lock)
  }
}

function pinnedFirst(entries: Entry[], pins: Pins): Entry[] {
  const sessions = new Set(pins.sessions)
  const directories = new Set(pins.directories)
  return [...entries].sort((a, b) => {
    const aRank = sessions.has(a.id) ? 2 : directories.has(a.dir) ? 1 : 0
    const bRank = sessions.has(b.id) ? 2 : directories.has(b.dir) ? 1 : 0
    return bRank - aRank || b.updated - a.updated
  })
}

// Sessions panel: an opencode-native session switcher in two parts.
//
// 1. Sidebar (always visible): a compact recent-sessions section appended to
//    the native sidebar via the `sidebar_content` slot. Native session_list
//    (<leader>l) is left untouched; this complements it with a cross-project
//    view. Rows are display-only; option+o opens the full picker.
// 2. Picker (option+o, `/sesh`, command palette): an xlarge grouped picker over
//    every session across all project directories, newest first.
//
// `/sesh` is registered by this plugin (a markdown command cannot open the
// dialog). Native `/sessions` and session_list (<leader>l) stay untouched.
const BASE_MODE = "base"
const POLL_MS = 15_000

function shortDir(dir: string, home: string): string {
  if (!dir || dir === "/") return "other"
  const pretty = home && dir.startsWith(home + "/") ? "~" + dir.slice(home.length) : dir
  return pretty.replace(/\/+$/, "").split("/").pop() || "other"
}

function prettyDir(dir: string, home: string): string {
  if (!dir) return "other"
  if (home && dir === home) return "~"
  const pretty = home && dir.startsWith(home + "/") ? "~" + dir.slice(home.length) : dir.replace(/\/+$/, "")
  const parts = pretty.split("/").filter(Boolean)
  if (parts.length <= 3) return pretty
  return "…/" + parts.slice(-2).join("/")
}

function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function truncate(text: string, width: number): string {
  if (width <= 0) return ""
  if (text.length <= width) return text
  return text.slice(0, width - 1) + "…"
}

// Sidebar and home rows should read at a similar length. The sidebar title
// column is ~2 chars narrower than the group column (status dot + timestamp),
// so cap it a bit lower to guarantee separation.
const SIDEBAR_TITLE_WIDTH = 27
const SIDEBAR_GROUP_WIDTH = 30
const HOME_TITLE_WIDTH = 30

// The sidebar lists every session (newest first, pins ahead) and fills
// whatever vertical space it gets: overflow scrolls inside the stretched
// scrollbox. The picker (option+o) remains the place for transcript search.

// Uppercase is included deliberately: a search box that silently drops shifted
// letters cannot be used for acronyms or paths like README.
const SEARCH_KEYS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.@/+:,?!()[]".split("")

function searchBindings(append: (input: string) => void, exit: () => void) {
  return [
    ...SEARCH_KEYS.map((ch) => ({ key: ch, preventDefault: true, cmd: () => append(ch) })),
    { key: "space", preventDefault: true, cmd: () => append(" ") },
    { key: "backspace", preventDefault: true, cmd: () => append("\b") },
    { key: "escape", preventDefault: true, cmd: exit },
  ]
}

const rootMouseHandlers = new Set<() => void>()
let rootMouseInstalled = false
let removeRootMouse: (() => void) | undefined
const ROOT_MOUSE = Symbol.for("opencode-sesh.root-mouse")

function ensureRootMouse(renderer: TuiPluginApi["renderer"]) {
  if (rootMouseInstalled || !renderer?.root) return
  rootMouseInstalled = true
  const root = renderer.root as unknown as {
    onMouseDown?: (event: unknown) => void
    _mouseListeners?: { down?: (event: unknown) => void }
    [ROOT_MOUSE]?: Set<() => void>
  }
  if (!root[ROOT_MOUSE]) {
    const handlers = new Set<() => void>()
    root[ROOT_MOUSE] = handlers
    const previous = root._mouseListeners?.down
    root.onMouseDown = (event) => {
      previous?.(event)
      for (const handler of [...handlers]) handler()
    }
  }
  const dispatch = () => {
    for (const handler of [...rootMouseHandlers]) handler()
  }
  root[ROOT_MOUSE].add(dispatch)
  removeRootMouse = () => {
    root[ROOT_MOUSE]?.delete(dispatch)
    rootMouseHandlers.clear()
    rootMouseInstalled = false
  }
}

type Entry = { id: string; title: string; dir: string; group: string; updated: number }
type EntryResult = { entries: Entry[]; truncated: boolean }
type SidebarMarker = "current" | "running" | "idle"

const LEFT_BUTTON = 0
const RIGHT_BUTTON = 2

function openInCmuxWorkspace(api: TuiPluginApi, entry: Entry) {
  if (!process.env.CMUX_WORKSPACE_ID) {
    api.ui.toast({ message: "Right-click opens a new workspace only inside cmux", variant: "info" })
    return
  }
  const args = ["new-workspace", "--name", entry.title || entry.id, "--command", `opencode --session ${entry.id}`, "--focus", "true"]
  if (entry.dir) args.push("--cwd", entry.dir)
  const child = spawn("cmux", args, { stdio: "ignore" })
  child.on("error", () => api.ui.toast({ message: "Could not open a cmux workspace", variant: "error" }))
  child.on("exit", (code) => {
    if (code) api.ui.toast({ message: "Could not open a cmux workspace", variant: "error" })
  })
}

type MenuAction = "open" | "preview" | "workspace" | "fork" | "pin" | "delete" | "confirm" | "cancel"
type MenuItem = { id: MenuAction; label: string }
type MenuState = { entry: Entry; x: number; y: number; items: MenuItem[]; index: number; confirming: boolean }
type MenuLayer = {
  mode: "base"
  priority: number
  bindings: { key: string; desc: string; preventDefault: boolean; cmd: () => void }[]
}
type ContextMenuHost = {
  registerLayer: (layer: MenuLayer) => () => void
  actions: Record<"open" | "preview" | "workspace" | "fork" | "pin" | "delete", (entry: Entry) => void>
  pinned: (entry: Entry) => boolean
  cmux: () => boolean
  blocked: () => boolean
  onChange: (state: MenuState | undefined) => void
}

const CONTEXT_MENU_LAYER_PRIORITY = 30

function contextMenuItems(pinned: boolean, cmux: boolean): MenuItem[] {
  return [
    { id: "open", label: "Open" },
    { id: "preview", label: "Preview transcript" },
    ...(cmux ? [{ id: "workspace" as const, label: "Open in new cmux workspace" }] : []),
    { id: "fork", label: "Fork" },
    { id: "pin", label: pinned ? "Unpin" : "Pin" },
    { id: "delete", label: "Delete" },
  ]
}

function contextMenuSize(items: MenuItem[]): { width: number; height: number } {
  return { width: Math.max(...items.map((item) => item.label.length)) + 4, height: items.length + 2 }
}

function contextMenuBox(
  anchor: { x: number; y: number; width: number; height: number },
  cols: number,
  rows: number,
): { left: number; top: number; width: number; height: number } {
  const width = Math.max(1, Math.min(anchor.width, cols))
  const height = Math.max(1, Math.min(anchor.height, rows))
  const left = Math.max(0, Math.min(anchor.x, cols - width))
  const below = anchor.y + 1
  const top = below + height <= rows ? below : Math.max(0, anchor.y - height)
  return { left, top, width, height }
}

function createContextMenu(host: ContextMenuHost) {
  let state: MenuState | undefined
  let dispose: (() => void) | undefined

  const publish = (next: MenuState | undefined) => {
    state = next
    host.onChange(next)
  }

  const close = () => {
    dispose?.()
    dispose = undefined
    if (state) publish(undefined)
  }

  const select = (index: number) => {
    if (!state) return
    const next = Math.max(0, Math.min(state.items.length - 1, index))
    // A still pointer re-fires over events; republishing an identical state
    // would rebuild the keyed menu on every frame, churning renderables until
    // clicks fall through to whatever is beneath.
    if (next === state.index) return
    publish({ ...state, index: next })
  }

  const move = (delta: number) => {
    if (!state) return
    const count = state.items.length
    const next = (state.index + delta + count) % count
    if (next === state.index) return
    publish({ ...state, index: next })
  }

  const activate = (index?: number) => {
    if (!state) return
    const current = state
    const item = current.items[index ?? current.index]
    if (!item) return
    if (item.id === "delete") {
      publish({
        ...current,
        confirming: true,
        items: [
          { id: "confirm", label: "Confirm delete" },
          { id: "cancel", label: "Cancel" },
        ],
        index: 1,
      })
      return
    }
    close()
    if (item.id === "confirm") host.actions.delete(current.entry)
    else if (item.id !== "cancel") host.actions[item.id](current.entry)
  }

  const click = (index: number, button?: number) => {
    if ((button ?? LEFT_BUTTON) === LEFT_BUTTON) activate(index)
  }

  const guarded = (run: () => void) => () => {
    if (host.blocked()) close()
    else run()
  }

  const open = (entry: Entry, x: number, y: number) => {
    if (host.blocked()) return
    publish({ entry, x, y, items: contextMenuItems(host.pinned(entry), host.cmux()), index: 0, confirming: false })
    if (dispose) return
    dispose = host.registerLayer({
      mode: "base",
      priority: CONTEXT_MENU_LAYER_PRIORITY,
      bindings: [
        { key: "up", desc: "Previous menu item", preventDefault: true, cmd: guarded(() => move(-1)) },
        { key: "down", desc: "Next menu item", preventDefault: true, cmd: guarded(() => move(1)) },
        { key: "enter", desc: "Choose menu item", preventDefault: true, cmd: guarded(() => activate()) },
        { key: "escape", desc: "Close menu", preventDefault: true, cmd: close },
      ],
    })
  }

  return { open, close, select, activate, click, current: () => state }
}

type PortalContainer = {
  position?: string
  left?: number
  top?: number
  zIndex?: number
  destroyRecursively?: () => void
}

// Loading-spinner frames for the marker of a session whose agent is working.
const SIDEBAR_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function newestFirst(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id))
}

// A working agent is the only state the marker displays: everything that
// finished goes back to the neutral row, with the open session marked inside.
function sidebarMarker(current: boolean, live?: string): SidebarMarker {
  if (live === "running" || live === "busy" || live === "retry") return "running"
  return current ? "current" : "idle"
}

const SESSION_PAGE_LIMIT = 200
const SESSION_MAX = 5000

async function fetchEntries(api: TuiPluginApi): Promise<EntryResult> {
  const home = process.env.HOME ?? ""
  const projectResult = await api.client.project.list()
  const projects = ((projectResult?.data ?? projectResult) as Project[]) ?? []
  const projectName = new Map<string, string>(
    projects.map((p) => [p.id, p.name?.trim() || shortDir(p.canonical, home)]),
  )
  const sessions: Session[] = []
  let cursor: string | undefined
  let truncated = false
  for (;;) {
    const result = await api.client.experimental.session.list({
      limit: SESSION_PAGE_LIMIT,
      roots: true,
      ...(cursor === undefined ? {} : { cursor }),
    })
    const page = ((result?.data ?? result) as Session[]) ?? []
    if (!Array.isArray(page) || page.length === 0) break
    sessions.push(...page)
    if (!result.cursor?.next) break
    if (sessions.length >= SESSION_MAX) {
      truncated = true
      break
    }
    const next = result.cursor.next
    if (next === cursor) {
      truncated = true
      break
    }
    cursor = next
  }
  const entries = sessions
    .filter((s) => !s.time?.archived && !s.parentID)
    .sort((a, b) => b.time.updated - a.time.updated)
    .map((s) => {
      const projectLabel = s.projectID ? projectName.get(s.projectID) : undefined
      const sDir = (s as any).directory ?? s.location?.directory ?? ""
      return {
        id: s.id,
        title: s.title?.trim() || "(untitled)",
        dir: sDir,
        group:
          (projectLabel && projectLabel !== "other" ? projectLabel : shortDir(sDir, home)) ||
          "other",
        updated: s.time.updated,
      }
    })
  return { entries, truncated }
}

const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]+$/
const TRANSCRIPT_BATCH = 64
const REMOTE_CONCURRENCY = 8

type IndexProgress = { indexed: number; total: number; complete: boolean }

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function openTranscriptDb(): Promise<any | undefined> {
  try {
    const home = process.env.HOME ?? ""
    const dataHome = process.env.XDG_DATA_HOME ?? `${home}/.local/share`
    // @ts-ignore - bun:sqlite ships with the Bun runtime (verified); no type package installed
    const sqlite: any = await import("bun:sqlite")
    if (typeof sqlite?.Database !== "function") return undefined
    return new sqlite.Database(process.env.SESH_DB ?? `${dataHome}/opencode/opencode.db`, { readonly: true })
  } catch {
    return undefined
  }
}

// NEEDS_INPUT_SQL: sessions waiting on the user (shared heuristic — keep in
// sync with bin/sesh-waiting.sh). A session waits when it is not archived,
// is not a fork child, and either has an unanswered `question` tool part or
// a `tool` part still marked running older than STUCK_AFTER_MS (awaiting
// approval, or orphaned by a dead server). Server-independent on purpose:
// the TUI sync layer only sees permission/question state for sessions owned
// by the current server, which is invisible cross-project.
const STUCK_AFTER_MS = 600000
const LIVE_TOOLS_CTE = (sessionFilter: string) => `
WITH live AS (
  SELECT m.session_id AS session_id, m.seq AS seq,
    json_extract(c.value, '$.name') AS name,
    json_extract(c.value, '$.state.status') AS status,
    COALESCE(json_extract(c.value, '$.time.created'), m.time_created) AS created
  FROM session_message m, json_each(m.data, '$.content') c
  WHERE m.type = 'assistant'
    AND (m.data LIKE '%"status":"running"%' OR m.data LIKE '%"status":"pending"%')
    AND json_extract(c.value, '$.type') = 'tool'
    AND json_extract(c.value, '$.state.status') IN ('pending', 'running')${sessionFilter}
)`
const QUESTION_OPEN = `live.name = 'question'
  AND NOT EXISTS (
    SELECT 1 FROM session_message u
    WHERE u.session_id = live.session_id AND u.type = 'user' AND u.seq > live.seq)`
const NEEDS_INPUT_SQL = (stuckBefore: number) => `${LIVE_TOOLS_CTE("")}
SELECT s.id AS id,
  CASE WHEN EXISTS (SELECT 1 FROM live WHERE live.session_id = s.id AND ${QUESTION_OPEN})
    THEN 'question' ELSE 'stuck' END AS reason
FROM session_v2 s
WHERE COALESCE(s.time_archived, 0) = 0
  AND s.parent_id IS NULL
  AND (EXISTS (SELECT 1 FROM live WHERE live.session_id = s.id AND ${QUESTION_OPEN})
    OR EXISTS (
      SELECT 1 FROM live
      WHERE live.session_id = s.id AND live.status = 'running' AND live.created < ${stuckBefore}))
ORDER BY s.time_updated DESC`

async function queryWaitingIds(db: any): Promise<Map<string, string>> {
  const rows = (db.query(NEEDS_INPUT_SQL(Date.now() - STUCK_AFTER_MS)).all() ?? []) as {
    id: unknown
    reason: unknown
  }[]
  const out = new Map<string, string>()
  for (const row of rows) {
    if (
      typeof row?.id === "string" &&
      SESSION_ID_PATTERN.test(row.id) &&
      (row.reason === "question" || row.reason === "stuck")
    ) {
      out.set(row.id, row.reason)
    }
  }
  return out
}

type WaitingDetail = { reason: "question" | "stuck"; since?: number }

// The shared needs-input query decides *which* sessions are waiting. Read the
// oldest still-unanswered question or stuck tool for each result so triage can
// show how long it has waited, rather than its last (unrelated) update time.
async function queryWaitingDetails(db: any): Promise<Map<string, WaitingDetail>> {
  const reasons = await queryWaitingIds(db)
  const details = new Map<string, WaitingDetail>(
    [...reasons].map(([id, reason]) => [id, { reason: reason as WaitingDetail["reason"] }]),
  )
  const ids = [...details.keys()]
  const cutoff = Date.now() - STUCK_AFTER_MS
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200)
    const rows = (db.query(`${LIVE_TOOLS_CTE(` AND m.session_id IN (${batch.map(() => "?").join(",")})`)}
SELECT live.session_id AS id,
  MIN(CASE WHEN ${QUESTION_OPEN} THEN live.created END) AS question_since,
  MIN(CASE WHEN live.status = 'running' AND live.created < ${cutoff} THEN live.created END) AS stuck_since
FROM live
GROUP BY live.session_id`).all(...batch) ?? []) as { id: string; question_since: number | null; stuck_since: number | null }[]
    for (const row of rows) {
      const detail = details.get(row.id)
      if (!detail) continue
      const since = detail.reason === "question" ? row.question_since : row.stuck_since
      if (typeof since === "number") detail.since = since
    }
  }
  return details
}

function addTranscript(index: Map<string, string>, sid: string, data: string): void {
  try {
    const message = JSON.parse(data) as { text?: unknown; content?: unknown }
    const texts: string[] = []
    if (typeof message?.text === "string") texts.push(message.text)
    if (Array.isArray(message?.content)) {
      for (const part of message.content as { type?: unknown; text?: unknown }[]) {
        if (part?.type === "text" && typeof part.text === "string") texts.push(part.text)
      }
    }
    for (const text of texts) {
      const base = index.get(sid) ?? ""
      index.set(sid, `${base} ${text.toLowerCase()}`.trim())
    }
  } catch {
    // ignore malformed messages
  }
}

// Index titles/directories immediately, then add transcript text progressively
// in batches so the render thread can breathe. Covers every entry, not a fixed
// newest window; `onProgress` lets the picker show coverage.
async function buildSearchIndex(
  api: TuiPluginApi,
  entries: Entry[],
  onProgress?: (progress: IndexProgress, index: Map<string, string>) => void,
): Promise<Map<string, string>> {
  const index = new Map<string, string>()
  for (const entry of entries) {
    index.set(entry.id, `${entry.title.toLowerCase()} ${entry.dir.toLowerCase()}`)
  }
  const ids = entries.map((entry) => entry.id).filter((id) => SESSION_ID_PATTERN.test(id))
  const remaining = new Set(ids)
  const total = ids.length
  let indexed = 0
  const report = (complete: boolean) => onProgress?.({ indexed, total, complete }, index)
  report(false)

  const db = await openTranscriptDb()
  if (db) {
    try {
      for (let i = 0; i < ids.length; i += TRANSCRIPT_BATCH) {
        const batch = ids.slice(i, i + TRANSCRIPT_BATCH)
        const placeholders = batch.map(() => "?").join(",")
        const rows = (db
          .query(
            `SELECT session_id AS sid, data FROM session_message WHERE session_id IN (${placeholders}) AND type IN ('user', 'assistant') ORDER BY seq`,
          )
          .all(...batch) ?? []) as { sid: string; data: string }[]
        for (const row of rows) addTranscript(index, row.sid, row.data)
        for (const id of batch) remaining.delete(id)
        indexed += batch.length
        report(false)
        await nextTick()
      }
    } catch {
      // local store unavailable mid-walk; fall back to the remote path below
    } finally {
      db.close()
    }
  }

  if (remaining.size > 0) {
    await buildSearchIndexRemote(api, [...remaining], index, () => {
      indexed += 1
      if (indexed % TRANSCRIPT_BATCH === 0) report(false)
    })
  }
  report(true)
  return index
}

async function buildSearchIndexRemote(
  api: TuiPluginApi,
  ids: string[],
  index: Map<string, string>,
  onEach: () => void,
): Promise<void> {
  const home = process.env.HOME ?? ""
  const cacheDir = process.env.SESH_CACHE_DIR ?? `${home}/.cache/sesh`
  let cursor = 0
  // Bounded concurrency: a fixed worker pool instead of one request per session.
  const worker = async () => {
    for (;;) {
      const i = cursor++
      if (i >= ids.length) return
      const id = ids[i]
      const base = index.get(id) ?? ""
      try {
        const raw = await readFile(`${cacheDir}/extractions/${id}.json`, "utf8")
        const record = JSON.parse(raw) as { fulltextLower?: unknown; title?: unknown }
        const fulltext = typeof record?.fulltextLower === "string" ? record.fulltextLower : ""
        // Extraction caches prefix the transcript with the cached title. The
        // live entry already indexes its own title; strip that duplicate so a
        // title-only match cannot appear as a transcript excerpt.
        const title = typeof record?.title === "string" ? `${record.title.toLowerCase()} ` : ""
        const transcript = title && fulltext.startsWith(title) ? fulltext.slice(title.length) : fulltext
        index.set(id, `${base} ${transcript}`.trim())
      } catch {
        try {
          const result = await api.client.session.messages({ sessionID: id })
          const messages = result.data ?? []
          const text = messages
            .flatMap((message: any) =>
              message.parts
                .filter((part: any) => part.type === "text")
                .map((part: any) => (part as { text: string }).text),
            )
            .join(" ")
            .toLowerCase()
          index.set(id, `${base} ${text}`.trim())
        } catch {}
      }
      onEach()
    }
  }
  await Promise.all(Array.from({ length: Math.min(REMOTE_CONCURRENCY, ids.length) }, worker))
}

// The index is title + directory + text parts, all lowercased. Start looking
// after the metadata so a title match never masquerades as a transcript hit.
function transcriptMatchExcerpt(indexed: string | undefined, entry: Entry, query: string): string | undefined {
  const needle = query.trim().toLowerCase()
  if (!indexed || !needle) return undefined
  const transcriptStart = `${entry.title.toLowerCase()} ${entry.dir.toLowerCase()}`.length + 1
  const at = indexed.indexOf(needle, transcriptStart)
  if (at < 0) return undefined
  const start = Math.max(transcriptStart, at - 28)
  const end = Math.min(indexed.length, Math.max(at + needle.length + 28, start + 90))
  const excerpt = indexed.slice(start, end).replace(/\s+/g, " ").trim()
  return `${start > transcriptStart ? "…" : ""}${excerpt}${end < indexed.length ? "…" : ""}`
}

type PickerFilters = { query: string; scope?: string; waitingOnly: boolean; pinnedOnly: boolean }

function filterPickerEntries(
  entries: Entry[], filters: PickerFilters, index: Map<string, string>, waitingIds: Set<string>, pinnedSessions: string[],
): Entry[] {
  const q = filters.query.trim().toLowerCase()
  const pinned = new Set(pinnedSessions)
  return entries.filter((entry) => {
    if (filters.scope && entry.group !== filters.scope) return false
    if (filters.waitingOnly && !waitingIds.has(entry.id)) return false
    if (filters.pinnedOnly && !pinned.has(entry.id)) return false
    if (!q) return true
    return (index.get(entry.id) ?? `${entry.title} ${entry.dir}`.toLowerCase()).includes(q)
  })
}

const TRANSCRIPT_PREVIEW_TURNS = 8
const TRANSCRIPT_PREVIEW_CHARS = 2000

// Case-insensitive range of `query` inside `text`, so a matched row can show
// which part of it the search hit instead of only filtering invisibly. Kept
// below the data-layer markers that tests/tui.mjs evaluates: JSX must not enter
// that extraction window.
function matchRange(text: string, query: string): [number, number] | undefined {
  const q = query.trim().toLowerCase()
  if (!q) return undefined
  const at = text.toLowerCase().indexOf(q)
  return at < 0 ? undefined : [at, at + q.length]
}

function Highlighted(props: {
  text: string
  query: string
  color: RGBA
  matchColor: RGBA
  bold?: boolean
}) {
  const parts = createMemo(() => {
    const range = matchRange(props.text, props.query)
    if (!range) return [props.text, "", ""] as const
    return [props.text.slice(0, range[0]), props.text.slice(range[0], range[1]), props.text.slice(range[1])] as const
  })
  return (
    <text
      flexGrow={1}
      flexShrink={1}
      overflow="hidden"
      wrapMode="none"
      attributes={props.bold ? TextAttributes.BOLD : undefined}
      style={{ fg: props.color }}
    >
      {parts()[0]}
      <span style={{ fg: props.matchColor }}>{parts()[1]}</span>
      {parts()[2]}
    </text>
  )
}

async function fetchTranscriptText(api: TuiPluginApi, sessionID: string): Promise<string> {
  try {
    const result = await api.client.session.messages({ sessionID, preview: true })
    const messages = result.data ?? []
    const blocks = messages
      .map((message: any) => {
        const text = message.parts
          .filter((part: any) => part.type === "text")
          .map((part: any) => (part as { text: string }).text)
          .join("\n")
          .trim()
        if (!text) return ""
        const role = (message.info as { role?: string }).role
        return `**${role === "user" ? "You" : "Assistant"}**\n\n${text.slice(0, TRANSCRIPT_PREVIEW_CHARS)}`
      })
      .filter(Boolean)
      .slice(-TRANSCRIPT_PREVIEW_TURNS)
      .reverse()
    const text = blocks.join("\n\n---\n\n")
    return text || "(no text in this session)"
  } catch {
    return "(preview unavailable)"
  }
}

// Shared transcript preview dialog. Call from a component's setup scope so the
// preview key layer is torn down with it.
function createTranscriptPreview(api: TuiPluginApi) {
  const [previewID, setPreviewID] = createSignal<string>()
  const [previewText, setPreviewText] = createSignal("")
  let disposePreviewKeys: (() => void) | undefined

  const close = () => {
    setPreviewID(undefined)
    api.ui.dialog.clear()
    disposePreviewKeys?.()
    disposePreviewKeys = undefined
  }

  const open = (entry: Entry) => {
    if (previewID() === entry.id) {
      close()
      return
    }
    if (previewID()) close()
    setPreviewID(entry.id)
    setPreviewText("Loading…")
    void fetchTranscriptText(api, entry.id).then((text) => {
      if (previewID() === entry.id) setPreviewText(text)
    })
    api.ui.dialog.replace(
      () => (
        <box
          flexDirection="column"
          paddingLeft={4}
          paddingRight={4}
          paddingBottom={1}
          gap={1}
          backgroundColor={api.theme.current.backgroundPanel}
          onMouseDown={(event: { stopPropagation: () => void }) => event.stopPropagation()}
        >
          <box flexDirection="row" justifyContent="space-between">
            <text attributes={TextAttributes.BOLD}>{entry.title}</text>
            <text style={{ fg: api.theme.current.textMuted }} onMouseUp={close}>esc</text>
          </box>
          <text style={{ fg: api.theme.current.textMuted }}>
            {prettyDir(entry.dir, process.env.HOME ?? "")} · {ago(entry.updated)}
          </text>
          <scrollbox
            paddingLeft={1}
            paddingRight={1}
            scrollbarOptions={{ visible: false }}
            maxHeight={Math.max(6, Math.floor(api.renderer.height / 2))}
          >
            {getMarkdownStyle(api.theme.current) ? (
              <markdown
                content={previewText()}
                syntaxStyle={getMarkdownStyle(api.theme.current)!}
                treeSitterClient={getTreeSitterClient()}
              />
            ) : (
              <text wrapMode="word">{previewText()}</text>
            )}
          </scrollbox>
        </box>
      ),
      () => {
        setPreviewID(undefined)
        disposePreviewKeys?.()
        disposePreviewKeys = undefined
      },
    )
    api.ui.dialog.setSize("large")
    disposePreviewKeys?.()
    disposePreviewKeys = api.keymap.registerLayer({
      mode: "modal",
      bindings: [
        {
          key: "escape",
          desc: "Close preview",
          preventDefault: true,
          cmd: close,
        },
      ],
    })
  }

  onCleanup(() => disposePreviewKeys?.())

  // Outside presses reach the root handler; close on the first one instead of
  // relying on the host backdrop. Gated on our own preview so other dialogs
  // are never touched.
  const closeIfOpen = () => {
    if (previewID()) close()
  }

  return { open, closeIfOpen }
}

type TreeRow =
  | { kind: "group"; dir: string; label: string; count: number }
  | { kind: "item"; entry: Entry; last: boolean }

type PickerRow =
  | { kind: "group"; dir: string; label: string; count: number; pinned: boolean; continued?: boolean }
  | { kind: "item"; entry: Entry; last: boolean }

// Window by terminal lines, not session count: group spacing and transcript
// excerpts each consume an extra line. Carry the directory heading forward
// when a long group starts above the viewport.
function pickerWindow(rows: PickerRow[], start: number, height: number, excerpt: (entry: Entry) => boolean): PickerRow[] {
  if (!rows.length) return []
  const first = Math.max(0, Math.min(start, rows.length - 1))
  const shown: PickerRow[] = []
  let remaining = height
  if (rows[first].kind === "item") {
    for (let i = first - 1; i >= 0; i--) {
      const row = rows[i]
      if (row.kind !== "group") continue
      shown.push({ ...row, continued: true })
      remaining--
      break
    }
  }
  for (let i = first; i < rows.length; i++) {
    const row = rows[i]
    const lines = row.kind === "group" ? 2 : excerpt(row.entry) ? 2 : 1
    if (lines > remaining && shown.length) break
    shown.push(row)
    remaining -= lines
  }
  return shown
}

function pickerLastStart(rows: PickerRow[], height: number, excerpt: (entry: Entry) => boolean): number {
  if (!rows.length) return 0
  let start = rows.length - 1
  while (start > 0 && pickerWindow(rows, start - 1, height, excerpt).at(-1) === rows.at(-1)) start--
  return start
}

type PinProps = { pins: () => Pins; onTogglePin: (kind: keyof Pins, value: string) => void; refreshPins: () => void }

function SidebarSessions(props: { api: TuiPluginApi } & PinProps) {
  const theme = () => props.api.theme.current
  const home = process.env.HOME ?? ""
  const [entries, setEntries] = createSignal<Entry[]>([])
  const [sectionCollapsed, setSectionCollapsed] = createSignal(false)
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({})
  const [hovered, setHovered] = createSignal<string>()
  const preview = createTranscriptPreview(props.api)
  const [menuState, setMenuState] = createSignal<MenuState>()
  let portalContainer: PortalContainer | undefined
  const [query, setQuery] = createSignal("")
  const [deleting, setDeleting] = createSignal<string>()
  const [searching, setSearching] = createSignal(false)
  const [loadFailed, setLoadFailed] = createSignal(false)
  const [navActive, setNavActive] = createSignal(false)
  const [cursor, setCursor] = createSignal(0)
  const [pendingDelete, setPendingDelete] = createSignal<string>()
  const [waiting, setWaiting] = createSignal<Map<string, string>>(new Map())
  let confirmTimer: ReturnType<typeof setTimeout> | undefined
  const currentID = createMemo(() => {
    const route = props.api.route.current
    if (route.name !== "session") return undefined
    const params = route.params
    return params && typeof params.sessionID === "string" ? params.sessionID : undefined
  })

  onMount(() => {
    let alive = true
    const load = async () => {
      props.refreshPins()
      try {
        const { entries: all } = await fetchEntries(props.api)
        if (alive) {
          setEntries(all)
          setLoadFailed(false)
        }
      } catch {
        // leave the previous list in place rather than flashing to blank, but
        // say so when there is nothing at all to show
        if (alive && entries().length === 0) setLoadFailed(true)
      }
      try {
        const db = await openTranscriptDb()
        if (db) {
          try {
            const ids = await queryWaitingIds(db)
            if (alive) setWaiting(ids)
          } finally {
            db.close()
          }
        }
      } catch {
        // leave the previous waiting set in place rather than flashing
      }
    }
    void load()
    const clock = setInterval(() => void load(), POLL_MS)
    onCleanup(() => {
      alive = false
      clearInterval(clock)
    })
  })

  const filteredEntries = createMemo(() => {
    const q = query().trim().toLowerCase()
    const ordered = entries()
    if (!q) return ordered
    return ordered.filter(
      (entry) => entry.title.toLowerCase().includes(q) || entry.dir.toLowerCase().includes(q),
    )
  })

  const shownEntries = createMemo(() => filteredEntries())
  const remaining = createMemo(() => Math.max(0, filteredEntries().length - shownEntries().length))

  const NEEDS_INPUT_DIR = "__needs_input__"
  const waitingEntries = createMemo(() => {
    const ids = waiting()
    return newestFirst(shownEntries().filter((entry) => ids.has(entry.id)))
  })

  const tree = createMemo<TreeRow[]>(() => {
    const rows: TreeRow[] = []
    const pending = waitingEntries()
    if (pending.length > 0) {
      rows.push({ kind: "group", dir: NEEDS_INPUT_DIR, label: "Needs input", count: pending.length })
      if (!collapsed()[NEEDS_INPUT_DIR]) {
        for (let i = 0; i < pending.length; i++) {
          rows.push({ kind: "item", entry: pending[i], last: i === pending.length - 1 })
        }
      }
    }
    const groups = new Map<string, Entry[]>()
    for (const entry of shownEntries()) {
      if (waiting().has(entry.id)) continue
      const list = groups.get(entry.dir) ?? []
      list.push(entry)
      groups.set(entry.dir, list)
    }
    const ordered = [...groups.entries()]
      .map(([dir, list]) => ({ dir, list, updated: Math.max(...list.map((entry) => entry.updated)) }))
      .sort((a, b) => {
        const pins = props.pins()
        const rank = (group: { dir: string; list: Entry[] }) =>
          pins.directories.includes(group.dir) ? 2 : group.list.some((entry) => pins.sessions.includes(entry.id)) ? 1 : 0
        return rank(b) - rank(a) || b.updated - a.updated
      })
    for (const group of ordered) {
      const sessions = newestFirst(group.list)
      rows.push({ kind: "group", dir: group.dir, label: prettyDir(group.dir, home), count: group.list.length })
      if (collapsed()[group.dir]) continue
      for (let i = 0; i < sessions.length; i++) {
        rows.push({ kind: "item", entry: sessions[i], last: i === sessions.length - 1 })
      }
    }
    return rows
  })

  const toggleGroup = (dir: string) => {
    setCollapsed((prev) => ({ ...prev, [dir]: !prev[dir] }))
  }

  const toggleSection = () => {
    if (!sectionCollapsed()) {
      cancelDelete()
      setNavActive(false)
      setSearching(false)
      setHovered(undefined)
      menu.close()
    }
    setSectionCollapsed((value) => !value)
  }

  const openSession = (entry: Entry) => {
    // Opening a session hands input back to the main view: release every
    // sidebar capture first, so its key layers cannot shadow the composer's
    // once the new session is open.
    menu.close()
    cancelDelete()
    setNavActive(false)
    setSearching(false)
    setHovered(undefined)
    props.api.route.navigate("session", { sessionID: entry.id })
  }

  // Flat order of the rows a cursor can land on, so keyboard navigation and
  // mouse hover resolve to the same row.
  const itemRows = createMemo(() => tree().flatMap((row) => (row.kind === "item" ? [row.entry] : [])))
  const isActive = (id: string) => (navActive() ? itemRows()[cursor()]?.id === id : hovered() === id)
  const isPendingDelete = (id: string) => pendingDelete() === id

  const routeKey = createMemo(() => {
    const route = props.api.route.current
    const id = route.name === "session" && typeof route.params?.sessionID === "string" ? route.params.sessionID : ""
    return `${route.name}:${id}`
  })
  createEffect(on(routeKey, () => menu.close(), { defer: true }))
  // Navigating away also releases the sidebar's keyboard captures: a nav,
  // search, hover or armed delete left over from the previous session must
  // not shadow the composer's keys in the next one.
  createEffect(on(routeKey, () => {
    cancelDelete()
    setNavActive(false)
    setSearching(false)
    setHovered(undefined)
  }, { defer: true }))
  createEffect(() => {
    const state = menuState()
    if (state && !itemRows().some((entry) => entry.id === state.entry.id)) menu.close()
  })
  createEffect(() => {
    if (props.api.ui.dialog.open) menu.close()
    // A modal dialog owns input while open: yield the sidebar's keyboard
    // captures too, so its layers cannot double-fire with the dialog's own.
    if (props.api.ui.dialog.open) {
      cancelDelete()
      setNavActive(false)
      setSearching(false)
      setHovered(undefined)
    }
  })

  const moveCursor = (delta: number) => {
    const count = itemRows().length
    if (count === 0) return
    setCursor((value) => Math.max(0, Math.min(count - 1, value + delta)))
  }
  let previousRows: Entry[] = []
  createEffect(() => {
    const rows = itemRows()
    const selected = previousRows[cursor()]?.id
    const position = rows.findIndex((entry) => entry.id === selected)
    if (position >= 0 && position !== cursor()) setCursor(position)
    else if (cursor() >= rows.length) setCursor(Math.max(0, rows.length - 1))
    previousRows = rows
  })

  // Marker only: a spinner for a working agent, the open-session dot, and the
  // neutral row for idle sessions. Titles stay plain and no status text is
  // rendered.
  const markerOf = (id: string): SidebarMarker => {
    let live: string | undefined
    try {
      live = props.api.state.session.status(id)
    } catch {}
    return sidebarMarker(id === currentID(), live)
  }

  // The spinner animates only while a listed session is actually running, so
  // an idle list costs no timer and only running rows re-render per frame.
  const [spinFrame, setSpinFrame] = createSignal(0)
  let spinTimer: ReturnType<typeof setInterval> | undefined
  createEffect(() => {
    const spinning = itemRows().some((entry) => markerOf(entry.id) === "running")
    if (spinning && !spinTimer) {
      spinTimer = setInterval(() => setSpinFrame((value) => (value + 1) % SIDEBAR_SPINNER.length), 120)
    } else if (!spinning && spinTimer) {
      clearInterval(spinTimer)
      spinTimer = undefined
      setSpinFrame(0)
    }
  })
  onCleanup(() => {
    if (spinTimer) clearInterval(spinTimer)
  })

  const cancelDelete = () => {
    if (confirmTimer) clearTimeout(confirmTimer)
    confirmTimer = undefined
    setPendingDelete(undefined)
  }

  // Deleting is irreversible, so ctrl+x arms the row and a second ctrl+x (or y)
  // commits it. The arm survives pointer movement — edge-hover flicker must
  // not eat the confirm — and is cleared by the five-second timeout, n, Esc,
  // collapsing the section, or the delete itself.
  const requestDelete = (entry: Entry) => {
    if (deleting()) return
    if (pendingDelete() === entry.id) {
      void deleteEntry(entry)
      return
    }
    setPendingDelete(entry.id)
    if (confirmTimer) clearTimeout(confirmTimer)
    confirmTimer = setTimeout(() => setPendingDelete(undefined), 5000)
  }

  // The confirm always targets the visibly armed row ("ctrl+x again"),
  // wherever the pointer or cursor currently is. Returns true when an arm
  // was pending (and is now committed or discarded as stale).
  const confirmArmed = (): boolean => {
    const id = pendingDelete()
    if (!id) return false
    const entry = entries().find((e) => e.id === id)
    if (!entry) cancelDelete()
    else void deleteEntry(entry)
    return true
  }

  let sidebarScroll: { scrollTop: number } | undefined

  const deleteEntry = async (entry: Entry) => {
    cancelDelete()
    if (deleting()) return
    setDeleting(entry.id)
    try {
      const result = await props.api.client.session.delete({
        sessionID: entry.id,
        directory: entry.dir || undefined,
      })
      if (result && "error" in result && result.error) throw result.error
      const { entries: remaining } = await fetchEntries(props.api)
      if (remaining.some((item) => item.id === entry.id)) {
        setEntries(remaining)
        props.api.ui.toast({ message: "Session was not deleted", variant: "error" })
        return
      }
      const scrollTop = sidebarScroll?.scrollTop ?? 0
      setEntries(remaining)
      setHovered(undefined)
      const restore = () => {
        if (sidebarScroll) sidebarScroll.scrollTop = scrollTop
      }
      queueMicrotask(restore)
      setTimeout(restore, 0)
      props.api.ui.toast({ message: `Deleted "${truncate(entry.title, 40)}"`, variant: "info" })
      if (currentID() === entry.id) props.api.route.navigate("home")
    } catch {
      props.api.ui.toast({ message: "Could not delete session", variant: "error" })
    } finally {
      setDeleting(undefined)
    }
  }

  const forkEntry = async (entry: Entry) => {
    try {
      const result = await props.api.client.session.fork({
        sessionID: entry.id,
        directory: entry.dir || undefined,
      })
      const created = (result?.data ?? result) as Session | undefined
      if (!created?.id) throw new Error("fork returned no session")
      props.api.route.navigate("session", { sessionID: created.id })
      props.api.ui.toast({ message: `Forked "${truncate(entry.title, 40)}"`, variant: "info" })
    } catch {
      props.api.ui.toast({ message: "Could not fork session", variant: "error" })
    }
  }

  const menu = createContextMenu({
    registerLayer: (layer) => props.api.keymap.registerLayer(layer),
    actions: {
      open: (entry) => void openSession(entry),
      preview: (entry) => preview.open(entry),
      workspace: (entry) => openInCmuxWorkspace(props.api, entry),
      fork: (entry) => void forkEntry(entry),
      pin: (entry) => props.onTogglePin("sessions", entry.id),
      delete: (entry) => void deleteEntry(entry),
    },
    pinned: (entry) => props.pins().sessions.includes(entry.id),
    cmux: () => Boolean(process.env.CMUX_WORKSPACE_ID),
    blocked: () => props.api.ui.dialog.open,
    onChange: setMenuState,
  })

  const menuView = createMemo(() => {
    const state = menuState()
    if (!state) return undefined
    const box = contextMenuBox(
      { x: state.x, y: state.y, ...contextMenuSize(state.items) },
      props.api.renderer.width,
      props.api.renderer.height,
    )
    return { state, box }
  })

  let disposeHoverSpace: (() => void) | undefined
  let disposeSearch: (() => void) | undefined
  let disposeNav: (() => void) | undefined
  let disposeConfirm: (() => void) | undefined
  let insideSearchBox = false

  createEffect(() => {
    disposeConfirm?.()
    disposeConfirm = undefined
    if (!pendingDelete()) return
    disposeConfirm = props.api.keymap.registerLayer({
      mode: "base",
      priority: 25,
      bindings: [
        {
          key: "y",
          desc: "Confirm delete",
          preventDefault: true,
          cmd: () => {
            confirmArmed()
          },
        },
        {
          key: "alt+d",
          desc: "Confirm delete",
          preventDefault: true,
          cmd: () => {
            confirmArmed()
          },
        },
        {
          key: "enter",
          desc: "Confirm delete",
          preventDefault: true,
          cmd: () => {
            confirmArmed()
          },
        },
        { key: "n", desc: "Cancel delete", preventDefault: true, cmd: cancelDelete },
        { key: "escape", desc: "Cancel delete", preventDefault: true, cmd: cancelDelete },
      ],
    })
  })

  const onRootMouseDown = () => {
    menu.close()
    preview.closeIfOpen()
    if (insideSearchBox) {
      insideSearchBox = false
      return
    }
    if (searching()) setSearching(false)
    // A click anywhere outside the sidebar means input is back in the main
    // view: release the nav layer, hover shortcuts and any armed delete so
    // the sidebar's keys and rows stop shadowing the composer.
    cancelDelete()
    if (navActive()) setNavActive(false)
    setHovered(undefined)
  }

  onMount(() => {
    ensureRootMouse(props.api.renderer)
    rootMouseHandlers.add(onRootMouseDown)
    const closeMenu = () => menu.close()
    props.api.renderer.on("resize", closeMenu)
    onCleanup(() => {
      rootMouseHandlers.delete(onRootMouseDown)
      props.api.renderer.off("resize", closeMenu)
    })
  })

  const appendQuery = (input: string) => {
    if (input === "\b") setQuery((value) => value.slice(0, -1))
    else setQuery((value) => value + input)
  }

  createEffect(() => {
    disposeSearch?.()
    disposeSearch = undefined
    if (!searching()) return
    disposeSearch = props.api.keymap.registerLayer({
      mode: "base",
      priority: 20,
      bindings: searchBindings(appendQuery, () => setSearching(false)),
    })
  })

  const openSidebarPreview = (entry: Entry) => preview.open(entry)

  createEffect(() => {
    disposeHoverSpace?.()
    disposeHoverSpace = undefined
    const id = hovered()
    if (!id) return
    const entry = entries().find((e) => e.id === id)
    if (!entry) return
    disposeHoverSpace = props.api.keymap.registerLayer({
      mode: "base",
      priority: 20,
      bindings: [
        {
          key: "alt+p",
          desc: "Preview session transcript",
          preventDefault: true,
          cmd: () => openSidebarPreview(entry),
        },
        {
          key: "alt+d",
          desc: "Delete session",
          preventDefault: true,
          cmd: () => {
            if (!confirmArmed()) requestDelete(entry)
          },
        },
        { key: "alt+s", desc: "Pin session", preventDefault: true, cmd: () => props.onTogglePin("sessions", entry.id) },
        { key: "alt+r", desc: "Pin directory", preventDefault: true, cmd: () => props.onTogglePin("directories", entry.dir) },
        {
          key: "/",
          desc: "Search sessions",
          preventDefault: true,
          cmd: () => setSearching(true),
        },
      ],
    })
  })

  // Keyboard navigation is opt-in (click the "Sessions" heading or the search
  // box) so the sidebar never steals the arrow keys from the main prompt.
  // Clicking anywhere outside the sidebar, opening a session, or navigating
  // releases it again, so its layers cannot shadow the composer afterwards.
  createEffect(() => {
    disposeNav?.()
    disposeNav = undefined
    if (!navActive()) return
    const bindings = [
      { key: "up", desc: "Previous session", preventDefault: true, cmd: () => moveCursor(-1) },
      { key: "down", desc: "Next session", preventDefault: true, cmd: () => moveCursor(1) },
      { key: "pageup", desc: "Page up", preventDefault: true, cmd: () => moveCursor(-5) },
      { key: "pagedown", desc: "Page down", preventDefault: true, cmd: () => moveCursor(5) },
      { key: "home", desc: "First session", preventDefault: true, cmd: () => setCursor(0) },
      {
        key: "end",
        desc: "Last session",
        preventDefault: true,
        cmd: () => setCursor(Math.max(0, itemRows().length - 1)),
      },
      {
        key: "alt+p",
        desc: "Preview session transcript",
        preventDefault: true,
        cmd: () => {
          const entry = itemRows()[cursor()]
          if (entry) openSidebarPreview(entry)
        },
      },
      {
        key: "alt+d",
        desc: "Delete session",
        preventDefault: true,
        cmd: () => {
          if (confirmArmed()) return
          const entry = itemRows()[cursor()]
          if (entry) requestDelete(entry)
        },
      },
      {
        key: "alt+s",
        desc: "Pin session",
        preventDefault: true,
        cmd: () => {
          const entry = itemRows()[cursor()]
          if (entry) props.onTogglePin("sessions", entry.id)
        },
      },
      {
        key: "alt+r",
        desc: "Pin directory",
        preventDefault: true,
        cmd: () => {
          const entry = itemRows()[cursor()]
          if (entry) props.onTogglePin("directories", entry.dir)
        },
      },
      {
        key: "enter",
        desc: "Open session",
        preventDefault: true,
        cmd: () => {
          if (confirmArmed()) return
          const entry = itemRows()[cursor()]
          if (entry) void openSession(entry)
        },
      },
      {
        key: "escape",
        desc: "Leave the session list",
        preventDefault: true,
        cmd: () => {
          cancelDelete()
          setNavActive(false)
        },
      },
      ...(pendingDelete()
        ? [
            {
              key: "y",
              desc: "Confirm delete",
              preventDefault: true,
              cmd: () => {
                confirmArmed()
              },
            },
            { key: "n", desc: "Cancel delete", preventDefault: true, cmd: cancelDelete },
          ]
        : []),
    ]
    disposeNav = props.api.keymap.registerLayer({ mode: "base", priority: 20, bindings })
  })

  onCleanup(() => {
    disposeHoverSpace?.()
    disposeSearch?.()
    disposeNav?.()
    disposeConfirm?.()
    menu.close()
    const container = portalContainer
    portalContainer = undefined
    process.nextTick(() => container?.destroyRecursively?.())
    if (confirmTimer) clearTimeout(confirmTimer)
  })

  return (
    <box flexDirection="column" paddingRight={1} flexGrow={1} flexShrink={1}>
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <text flexShrink={1} onMouseDown={(event: { stopPropagation: () => void }) => {
          // Sidebar-internal: keep this click from reaching the root handler,
          // which would release the nav layer this toggle just activated.
          event.stopPropagation()
          if (!sectionCollapsed()) setNavActive((value) => !value)
        }}>
          <b>Sessions</b>
          <span style={{ fg: theme().textMuted }}>
            {query().trim() ? ` (${filteredEntries().length}/${entries().length})` : ` (${entries().length})`}
          </span>
          <span style={{ fg: theme().accent }}>{navActive() ? " · nav" : ""}</span>
          <Show when={waitingEntries().length > 0}>
            <span style={{ fg: theme().warning }}> · {waitingEntries().length} need input</span>
          </Show>
        </text>
        <text flexShrink={0} style={{ fg: theme().textMuted }} onMouseDown={(event: { stopPropagation: () => void }) => {
          event.stopPropagation()
          toggleSection()
        }}>
          {sectionCollapsed() ? "▸ show" : "▾ hide"}
        </text>
      </box>
      <Show when={!sectionCollapsed()}>
      <Show
        when={entries().length > 0}
        fallback={
          <text style={{ fg: theme().textMuted }}>
            {loadFailed() ? "Session list unavailable · will retry" : "No sessions yet · option+o to browse"}
          </text>
        }
      >
        <box
          flexDirection="row"
          gap={1}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={searching() ? theme().backgroundElement : RGBA.fromInts(0, 0, 0, 0)}
          onMouseDown={(event: { stopPropagation: () => void }) => {
            // Sidebar-internal: the root handler must not see this click, or
            // it would clear the search this box just activated.
            event.stopPropagation()
            insideSearchBox = true
            setSearching(true)
          }}
        >
          <text
            flexGrow={1}
            flexShrink={1}
            overflow="hidden"
            wrapMode="none"
            style={{ fg: query() ? theme().text : theme().textMuted }}
          >
            {query() || "search…"}
            {searching() ? "▏" : ""}
          </text>
          <Show when={query()}>
            <text flexShrink={0} style={{ fg: theme().textMuted }} onMouseDown={(event: { stopPropagation: () => void }) => {
              event.stopPropagation()
              setQuery("")
            }}>
              ✕
            </text>
          </Show>
        </box>
        <scrollbox
          ref={(node: { scrollTop: number }) => (sidebarScroll = node)}
          flexGrow={1}
          flexShrink={1}
          verticalScrollbarOptions={{ visible: false }}
          horizontalScrollbarOptions={{ visible: false }}
          onMouseScroll={() => menu.close()}
        >
          <For each={tree()}>
          {(row) => {
            if (row.kind === "group") return (
              <box flexDirection="row" paddingTop={1} onMouseDown={(event: { button?: number; stopPropagation: () => void }) => {
                event.stopPropagation()
                if (event.button === RIGHT_BUTTON) return
                toggleGroup(row.dir)
              }}>
                <text flexGrow={1} flexShrink={1} wrapMode="none">
                  <span style={{ fg: theme().textMuted }}>{collapsed()[row.dir] ? "▸ " : "▾ "}</span>
                  <b>{props.pins().directories.includes(row.dir) ? "★ " : ""}{truncate(row.label, SIDEBAR_GROUP_WIDTH - (props.pins().directories.includes(row.dir) ? 2 : 0))}</b>
                </text>
                <text flexShrink={0} style={{ fg: theme().textMuted }}>
                  {" "}({row.count})
                </text>
              </box>
            )
            const marker = createMemo(() => markerOf(row.entry.id))
            return (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={
                  isActive(row.entry.id) && row.entry.id !== currentID()
                    ? theme().backgroundElement
                    : RGBA.fromInts(0, 0, 0, 0)
                }
                onMouseOver={() => {
                  setHovered(row.entry.id)
                  // The keyboard layer wins over the hover layer while nav is
                  // active. Keep its cursor on the hovered row so Ctrl-S/Ctrl-D
                  // cannot silently pin a different (often current) session.
                  if (navActive()) {
                    const index = itemRows().findIndex((entry) => entry.id === row.entry.id)
                    if (index >= 0) setCursor(index)
                  }
                }}
                onMouseOut={() => setHovered(undefined)}
                onMouseDown={(event: { button?: number; x: number; y: number; stopPropagation: () => void }) => {
                  if (event.button === RIGHT_BUTTON) {
                    event.stopPropagation()
                    menu.open(row.entry, event.x, event.y)
                  } else {
                    // Sidebar-internal: openSession releases the sidebar's own
                    // captures, so this click must not also reach the root
                    // handler as an outside click.
                    event.stopPropagation()
                    void openSession(row.entry)
                  }
                }}
              >
                <text flexShrink={0}>
                  <span style={{ fg: theme().textMuted }}>{row.last ? "└" : "├"}</span>
                  <span
                    style={{
                      fg: isPendingDelete(row.entry.id)
                        ? theme().error
                        : marker() === "current"
                          ? theme().accent
                          : marker() === "running"
                            ? theme().success
                            : theme().textMuted,
                    }}
                  >
                    {marker() === "current" ? "●" : marker() === "running" ? SIDEBAR_SPINNER[spinFrame()] : isActive(row.entry.id) ? "▸" : "○"}
                  </span>
                </text>
                <Highlighted
                  text={`${props.pins().sessions.includes(row.entry.id) ? "★ " : ""}${truncate(row.entry.title, SIDEBAR_TITLE_WIDTH - (props.pins().sessions.includes(row.entry.id) ? 2 : 0))}`}
                  query={query()}
                  color={isPendingDelete(row.entry.id) ? theme().error : theme().text}
                  matchColor={theme().warning}
                />
                <text flexShrink={0} style={{ fg: isPendingDelete(row.entry.id) ? theme().error : theme().textMuted }}>
                  {isPendingDelete(row.entry.id) ? "option+d again" : ago(row.entry.updated)}
                </text>
              </box>
            )
          }}
        </For>
        </scrollbox>
        <Show when={remaining() > 0}>
          <text style={{ fg: theme().textMuted }}>{`… ${remaining()} more · option+o for all`}</text>
        </Show>
        <Show when={query().trim() && filteredEntries().length === 0}>
            <text style={{ fg: theme().textMuted }}>No title or directory matches · option+o to search transcripts</text>
        </Show>
        <Show when={navActive()}>
          <box paddingTop={1}>
            <text style={{ fg: theme().textMuted }}>↑↓ move · enter open · option+p preview · option+s/r pin · option+d delete · esc done</text>
          </box>
        </Show>
      </Show>
      </Show>
      <Portal
        mount={props.api.renderer.root as never}
        ref={(container: PortalContainer) => {
          portalContainer = container
          container.position = "absolute"
          container.left = 0
          container.top = 0
          container.zIndex = 1000
        }}
      >
        <Show when={menuView()} keyed>
          {(view) => (
          <box
            position="absolute"
            left={view.box.left}
            top={view.box.top}
            width={view.box.width}
            height={view.box.height}
            flexDirection="column"
            border
            borderStyle="rounded"
            borderColor={theme().borderActive}
            backgroundColor={theme().backgroundPanel}
            paddingLeft={1}
            paddingRight={1}
            onMouseDown={(event: { stopPropagation: () => void }) => event.stopPropagation()}
            onMouseUp={(event: { stopPropagation: () => void }) => event.stopPropagation()}
          >
            <For each={view.state.items}>
              {(item, index) => (
                <box
                  height={1}
                  backgroundColor={view.state.index === index() ? theme().backgroundElement : RGBA.fromInts(0, 0, 0, 0)}
                  onMouseOver={() => menu.select(index())}
                  // Release activates so the press that opens a dialog cannot
                  // straddle it: the release is consumed here before any dialog
                  // opened by the action exists.
                  onMouseDown={(event: { stopPropagation: () => void }) => event.stopPropagation()}
                  onMouseUp={(event: { button?: number; stopPropagation: () => void }) => {
                    event.stopPropagation()
                    menu.click(index(), event.button)
                  }}
                >
                  <text
                    wrapMode="none"
                    style={{
                      fg:
                        item.id === "delete" || item.id === "confirm"
                          ? theme().error
                          : view.state.index === index()
                            ? theme().text
                            : theme().textMuted,
                    }}
                  >
                    {item.label}
                  </text>
                </box>
              )}
            </For>
          </box>
          )}
        </Show>
      </Portal>
    </box>
  )
}

const HOME_SESSION_LIMIT = 6

function HomeSessions(props: { api: TuiPluginApi } & PinProps) {
  const theme = () => props.api.theme.current
  const home = process.env.HOME ?? ""
  const [entries, setEntries] = createSignal<Entry[]>([])
  const [query, setQuery] = createSignal("")
  const [hovered, setHovered] = createSignal<string>()
  const [searching, setSearching] = createSignal(false)
  const [loadFailed, setLoadFailed] = createSignal(false)
  const [pendingDelete, setPendingDelete] = createSignal<string>()
  const [deleting, setDeleting] = createSignal<string>()
  let confirmTimer: ReturnType<typeof setTimeout> | undefined
  let disposeConfirm: (() => void) | undefined
  const preview = createTranscriptPreview(props.api)
  let disposeHoverSpace: (() => void) | undefined
  let disposeSearch: (() => void) | undefined
  let insideSearchBox = false

  const cancelDelete = () => {
    if (confirmTimer) clearTimeout(confirmTimer)
    confirmTimer = undefined
    disposeConfirm?.()
    disposeConfirm = undefined
    setPendingDelete(undefined)
  }

  const confirmArmed = (): boolean => {
    const id = pendingDelete()
    if (!id) return false
    const entry = entries().find((e) => e.id === id)
    if (!entry) cancelDelete()
    else void deleteEntry(entry)
    return true
  }

  const requestDelete = (entry: Entry) => {
    if (deleting()) return
    if (pendingDelete() === entry.id) {
      void deleteEntry(entry)
      return
    }
    setPendingDelete(entry.id)
    if (confirmTimer) clearTimeout(confirmTimer)
    confirmTimer = setTimeout(() => setPendingDelete(undefined), 5000)
  }

  const deleteEntry = async (entry: Entry) => {
    cancelDelete()
    if (deleting()) return
    setDeleting(entry.id)
    try {
      const result = await props.api.client.session.delete({
        sessionID: entry.id,
        directory: entry.dir || undefined,
      })
      if (result && "error" in result && result.error) throw result.error
      const { entries: remaining } = await fetchEntries(props.api)
      if (remaining.some((item) => item.id === entry.id)) {
        setEntries(remaining)
        props.api.ui.toast({ message: "Session was not deleted", variant: "error" })
        return
      }
      setEntries(remaining)
      setHovered(undefined)
      props.api.ui.toast({ message: `Deleted "${truncate(entry.title, 40)}"`, variant: "info" })
      if ("params" in props.api.route.current && (props.api.route.current.params as any)?.sessionID === entry.id) {
        props.api.route.navigate("home")
      }
    } catch {
      props.api.ui.toast({ message: "Could not delete session", variant: "error" })
    } finally {
      setDeleting(undefined)
    }
  }

  createEffect(() => {
    disposeConfirm?.()
    disposeConfirm = undefined
    if (!pendingDelete()) return
    disposeConfirm = props.api.keymap.registerLayer({
      mode: "base",
      priority: 25,
      bindings: [
        { key: "y", desc: "Confirm delete", preventDefault: true, cmd: () => { confirmArmed() } },
        { key: "alt+d", desc: "Confirm delete", preventDefault: true, cmd: () => { confirmArmed() } },
        { key: "enter", desc: "Confirm delete", preventDefault: true, cmd: () => { confirmArmed() } },
        { key: "n", desc: "Cancel delete", preventDefault: true, cmd: cancelDelete },
        { key: "escape", desc: "Cancel delete", preventDefault: true, cmd: cancelDelete },
      ],
    })
  })

  const onRootMouseDown = () => {
    preview.closeIfOpen()
    if (insideSearchBox) {
      insideSearchBox = false
      return
    }
    if (searching()) setSearching(false)
  }

  // A modal dialog owns input while open: yield this list's keyboard captures
  // too, so its layers cannot double-fire with the dialog's own.
  createEffect(() => {
    if (props.api.ui.dialog.open) {
      cancelDelete()
      setSearching(false)
      setHovered(undefined)
    }
  })

  onMount(() => {
    ensureRootMouse(props.api.renderer)
    rootMouseHandlers.add(onRootMouseDown)
    onCleanup(() => rootMouseHandlers.delete(onRootMouseDown))
  })

  const appendQuery = (input: string) => {
    if (input === "\b") setQuery((value) => value.slice(0, -1))
    else setQuery((value) => value + input)
  }

  createEffect(() => {
    disposeSearch?.()
    disposeSearch = undefined
    if (!searching()) return
    disposeSearch = props.api.keymap.registerLayer({
      mode: "base",
      priority: 20,
      bindings: searchBindings(appendQuery, () => setSearching(false)),
    })
  })

  createEffect(() => {
    disposeHoverSpace?.()
    disposeHoverSpace = undefined
    const id = hovered()
    if (!id) return
    const entry = entries().find((e) => e.id === id)
    if (!entry) return
    disposeHoverSpace = props.api.keymap.registerLayer({
      mode: "base",
      priority: 20,
      bindings: [
        {
          key: "alt+p",
          desc: "Preview session transcript",
          preventDefault: true,
          cmd: () => preview.open(entry),
        },
        {
          key: "alt+d",
          desc: "Delete session",
          preventDefault: true,
          cmd: () => {
            if (!confirmArmed()) requestDelete(entry)
          },
        },
        { key: "alt+s", desc: "Pin session", preventDefault: true, cmd: () => props.onTogglePin("sessions", entry.id) },
        { key: "alt+r", desc: "Pin directory", preventDefault: true, cmd: () => props.onTogglePin("directories", entry.dir) },
      ],
    })
  })

  onCleanup(() => {
    disposeSearch?.()
    disposeHoverSpace?.()
    disposeConfirm?.()
    if (confirmTimer) clearTimeout(confirmTimer)
  })

  onMount(() => {
    let alive = true
    const load = async () => {
      props.refreshPins()
      try {
        const { entries: all } = await fetchEntries(props.api)
        if (alive) {
          setEntries(all)
          setLoadFailed(false)
        }
      } catch {
        if (alive && entries().length === 0) setLoadFailed(true)
      }
    }
    void load()
    const clock = setInterval(() => void load(), POLL_MS)
    onCleanup(() => {
      alive = false
      clearInterval(clock)
    })
  })

  const visible = createMemo(() => {
    const q = query().trim().toLowerCase()
    const list = q
      ? entries().filter(
          (entry) => entry.title.toLowerCase().includes(q) || entry.dir.toLowerCase().includes(q),
        )
      : entries()
    return pinnedFirst(list, props.pins()).slice(0, HOME_SESSION_LIMIT)
  })

  return (
    <box width="100%" alignItems="center">
      <box flexDirection="column" width="100%" maxWidth={72} paddingLeft={1} paddingRight={1} paddingTop={1} gap={1}>
        <Show
          when={entries().length > 0}
          fallback={
            <box flexDirection="row" gap={1}>
              <text style={{ fg: theme().textMuted }}>Recent sessions</text>
              <text style={{ fg: theme().textMuted }}>
                {loadFailed() ? "· list unavailable, will retry" : "· none yet, option+o to browse"}
              </text>
            </box>
          }
        >
          <box flexDirection="row" justifyContent="space-between" gap={2}>
            <box flexDirection="row" gap={1}>
              <text style={{ fg: theme().textMuted }}>Recent sessions</text>
              <text style={{ fg: theme().textMuted }}>· option+o for all</text>
            </box>
            <box
              flexDirection="row"
              gap={1}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={searching() ? theme().backgroundElement : RGBA.fromInts(0, 0, 0, 0)}
              onMouseDown={() => {
                insideSearchBox = true
                setSearching(true)
              }}
            >
              <box width={24}>
                <text
                  flexGrow={1}
                  flexShrink={1}
                  overflow="hidden"
                  wrapMode="none"
                  style={{ fg: query() ? theme().text : theme().textMuted }}
                >
                  {query() || "search…"}
                  {searching() ? "▏" : ""}
                </text>
              </box>
              <Show when={query()}>
                <text flexShrink={0} style={{ fg: theme().textMuted }} onMouseDown={() => setQuery("")}>
                  ✕
                </text>
              </Show>
            </box>
          </box>
          <For each={visible()}>
            {(entry) => (
              <box
                flexDirection="row"
                gap={1}
                backgroundColor={entry.id === hovered() ? theme().backgroundElement : RGBA.fromInts(0, 0, 0, 0)}
                onMouseOver={() => setHovered(entry.id)}
                onMouseOut={() => setHovered(undefined)}
                onMouseDown={(event: { button?: number }) =>
                  event.button === RIGHT_BUTTON
                    ? openInCmuxWorkspace(props.api, entry)
                    : props.api.route.navigate("session", { sessionID: entry.id })
                }
              >
                <text flexShrink={0} style={{ fg: theme().textMuted }}>
                  ○
                </text>
                <Highlighted
                  text={`${props.pins().sessions.includes(entry.id) ? "★ " : ""}${truncate(entry.title, HOME_TITLE_WIDTH - (props.pins().sessions.includes(entry.id) ? 2 : 0))}`}
                  query={query()}
                  color={theme().text}
                  matchColor={theme().warning}
                />
                <text flexShrink={0} style={{ fg: pendingDelete() === entry.id ? theme().error : theme().textMuted }}>
                  {pendingDelete() === entry.id
                    ? "option+d again"
                    : `${props.pins().directories.includes(entry.dir) ? "★ " : ""}${prettyDir(entry.dir, home)} · ${ago(entry.updated)}`}
                </text>
              </box>
            )}
          </For>
          <Show when={visible().length === 0}>
              <text style={{ fg: theme().textMuted }}>No title or directory matches · option+o to search transcripts</text>
          </Show>
        </Show>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  const [pins, setPins] = createSignal<Pins>(emptyPins())
  // Keep exploratory context while the plugin remains loaded; a full OpenCode
  // restart starts with a clean picker rather than an old cross-project filter.
  let pickerState: PickerFilters = {
    query: "", waitingOnly: false, pinnedOnly: false,
  }
  let pinVersion = 0
  const refreshPins = () => {
    const version = pinVersion
    void readPins().then((latest) => {
      if (version === pinVersion) setPins(latest)
    })
  }
  refreshPins()
  const onTogglePin = (kind: keyof Pins, value: string) => {
    if (!value) return
    pinVersion += 1
    void togglePin(kind, value).then(
      (updated) => {
        setPins(updated)
        api.ui.toast({ message: `${updated[kind].includes(value) ? "Pinned" : "Unpinned"} ${kind === "sessions" ? "session" : "directory"}`, variant: "info" })
      },
      () => api.ui.toast({ message: "Could not update pins", variant: "error" }),
    )
  }
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content() {
        return <SidebarSessions api={api} pins={pins} onTogglePin={onTogglePin} refreshPins={refreshPins} />
      },
      home_bottom() {
        return <HomeSessions api={api} pins={pins} onTogglePin={onTogglePin} refreshPins={refreshPins} />
      },
    },
  })

  const openPicker = async (command = false) => {
    refreshPins()
    if (!command && api.mode.current() !== BASE_MODE) return
    if (!command && api.renderer.currentFocusedEditor === null) return

    let entriesResult: EntryResult
    try {
      entriesResult = await fetchEntries(api)
    } catch {
      api.ui.toast({ message: "Could not load sessions", variant: "error" })
      return
    }
    const entries = entriesResult.entries
    if (entries.length === 0) {
      api.ui.toast({ message: "No sessions found", variant: "warning" })
      return
    }

    const [allEntries, setAllEntries] = createSignal<Entry[]>(entries)
    const [previewText, setPreviewText] = createSignal("")
    const [showPreview, setShowPreview] = createSignal(false)
    const [query, setQuery] = createSignal(pickerState.query)
    const [cursor, setCursor] = createSignal(0)
    const [viewportStart, setViewportStart] = createSignal(0)
    const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({})
    const [scope, setScope] = createSignal<string | undefined>(
      entries.some((entry) => entry.group === pickerState.scope) ? pickerState.scope : undefined,
    )
    const [waitingOnly, setWaitingOnly] = createSignal(pickerState.waitingOnly)
    const [pinnedOnly, setPinnedOnly] = createSignal(pickerState.pinnedOnly)
    const [waitingIds, setWaitingIds] = createSignal<Set<string>>(new Set())
    const [waitingCoverage, setWaitingCoverage] = createSignal<"loading" | "ready" | "unavailable">("loading")
    let alive = true
    void (async () => {
      const db = await openTranscriptDb()
      if (!db) {
        if (alive) setWaitingCoverage("unavailable")
        return
      }
      try {
        const ids = await queryWaitingIds(db)
        if (alive) {
          setWaitingIds(new Set(ids.keys()))
          setWaitingCoverage("ready")
        }
      } catch {
        if (alive) setWaitingCoverage("unavailable")
      } finally {
        db.close()
      }
    })()
    const [pendingDelete, setPendingDelete] = createSignal<Entry>()
    const [searchIndex, setSearchIndex] = createSignal<Map<string, string>>(new Map())
    const [indexProgress, setIndexProgress] = createSignal<IndexProgress>({
      indexed: 0,
      total: 0,
      complete: false,
    })
    void buildSearchIndex(api, entries, (progress, index) => {
      if (!alive) return
      setIndexProgress(progress)
      // Publish a fresh snapshot: the indexing workers mutate their own map,
      // while Solid needs a new reference to update search results mid-scan.
      setSearchIndex(new Map(index))
    })
    const orderedEntries = createMemo(() => pinnedFirst(allEntries(), pins()))
    const currentProject = () => {
      const route = api.route.current
      const id = route.name === "session" ? route.params?.sessionID : undefined
      return allEntries().find((entry) => entry.id === id)?.group ??
        allEntries().find((entry) => entry.dir === api.state.path.directory)?.group
    }
    const matchedGroups = createMemo(() => {
      const matched = filterPickerEntries(
        orderedEntries(),
        { query: query(), scope: scope(), waitingOnly: waitingOnly(), pinnedOnly: pinnedOnly() },
        searchIndex(), waitingIds(), pins().sessions,
      )
      const byGroup = new Map<string, Entry[]>()
      for (const entry of matched) {
        const list = byGroup.get(entry.dir) ?? []
        list.push(entry)
        byGroup.set(entry.dir, list)
      }
      const groups = [...byGroup.entries()].map(([dir, list]) => ({ dir, list: newestFirst(list) }))
      const currentPins = pins()
      const rank = (group: (typeof groups)[number]) =>
        currentPins.directories.includes(group.dir) ? 2
          : group.list.some((entry) => currentPins.sessions.includes(entry.id)) ? 1 : 0
      return groups.sort((a, b) =>
        rank(b) - rank(a) || Math.max(...b.list.map((entry) => entry.updated)) - Math.max(...a.list.map((entry) => entry.updated)),
      )
    })

    const selectableEntries = createMemo(() => matchedGroups().flatMap((g) =>
      collapsed()[g.dir] && !query().trim() ? [] : g.list,
    ))

    // Visible bounding: say how much transcript text search actually covers and
    // when the metadata walk hit its cap, instead of silently under-reporting.
    const coverageLabel = createMemo(() => {
      const progress = indexProgress()
      const bits: string[] = []
      if (scope()) bits.push(`scope ${scope()}`)
      if (waitingOnly()) bits.push(waitingCoverage() === "loading" ? "checking needs input" : waitingCoverage() === "unavailable" ? "needs-input unavailable" : "needs input")
      if (pinnedOnly()) bits.push("pinned sessions")
      if (progress.total > 0) {
        bits.push(
          progress.complete
            ? `transcripts ${progress.total}`
            : `indexing transcripts ${progress.indexed}/${progress.total}`,
        )
      }
      if (entriesResult.truncated) bits.push(`showing newest ${allEntries().length}`)
      return bits.join(" · ")
    })

    const pickerRows = createMemo<PickerRow[]>(() => {
      const flat: PickerRow[] = []
      for (const group of matchedGroups()) {
        flat.push({ kind: "group", dir: group.dir, label: prettyDir(group.dir, process.env.HOME ?? ""),
          count: group.list.length, pinned: pins().directories.includes(group.dir) })
        if (collapsed()[group.dir] && !query().trim()) continue
        for (let i = 0; i < group.list.length; i++) {
          flat.push({ kind: "item", entry: group.list[i], last: i === group.list.length - 1 })
        }
      }
      return flat
    })

    const termHeight = api.renderer.height
    // The dialog host anchors content a quarter of the way down the screen and
    // lets it size to content, so a taller picker drifts downward. Pin the
    // content height and offset it up by the same amount to keep it centred.
    const dialogWidth = Math.min(116, api.renderer.width - 2)
    const CHROME_ROWS = 13
    const listHeight = () => Math.max(6, Math.floor(termHeight * 0.75) - CHROME_ROWS)
    const dialogHeight = () => listHeight() + CHROME_ROWS
    const dialogOffset = () => Math.min(0, Math.floor(termHeight / 4 - dialogHeight() / 2 - 1))
    const hasExcerpt = (entry: Entry) => !!transcriptMatchExcerpt(searchIndex().get(entry.id), entry, query())
    const maxViewportStart = createMemo(() => pickerLastStart(pickerRows(), listHeight(), hasExcerpt))
    const visiblePickerRows = createMemo(() => pickerWindow(
      pickerRows(), Math.min(viewportStart(), maxViewportStart()), listHeight(), hasExcerpt,
    ))

    let previousSelection: Entry[] = []
    let deletedAt: number | undefined
    createEffect(() => {
      const rows = selectableEntries()
      const position = rows.findIndex((entry) => entry.id === previousSelection[cursor()]?.id)
      if (rows !== previousSelection && (rows.length !== previousSelection.length ||
        rows.some((entry, index) => entry.id !== previousSelection[index]?.id))) {
        // A search/filter/collapse changed the tree: reveal the retained row or
        // start at the first result rather than leaving a stale window open.
        if (deletedAt !== undefined) {
          setCursor(Math.max(0, Math.min(deletedAt, rows.length - 1)))
          deletedAt = undefined
        } else {
          const next = position >= 0 ? position : 0
          setCursor(next)
          const id = rows[next]?.id
          setViewportStart(position < 0 || next === 0 ? 0 : Math.max(0, pickerRows().findIndex(
            (row) => row.kind === "item" && row.entry.id === id,
          )))
        }
      } else if (cursor() >= rows.length) setCursor(Math.max(0, rows.length - 1))
      previousSelection = rows
    })

    const previewCache = new Map<string, string>()
    let previewTimer: ReturnType<typeof setTimeout> | undefined

    const previewID = () => selectableEntries()[cursor()]?.id

    const loadPreview = async (id: string | undefined) => {
      if (!id) return
      const cached = previewCache.get(id)
      if (cached !== undefined) {
        setPreviewText(cached)
        return
      }
      try {
        const text = await fetchTranscriptText(api, id)
        previewCache.set(id, text)
        if (showPreview() && previewID() === id) setPreviewText(text)
      } catch {}
    }

    const currentSessionID = () => {
      const route = api.route.current
      if (route.name !== "session") return undefined
      const params = route.params
      return params && typeof params.sessionID === "string" ? params.sessionID : undefined
    }

    const close = () => {
      cleanup()
      api.ui.dialog.clear()
    }

    createEffect(() => {
      const showing = showPreview()
      const id = previewID()
      if (previewTimer) clearTimeout(previewTimer)
      if (!showing || !id) return
      const cached = previewCache.get(id)
      if (cached !== undefined) {
        setPreviewText(cached)
        return
      }
      // Never show another session's transcript beneath the new selection.
      setPreviewText("Loading…")
      previewTimer = setTimeout(() => void loadPreview(id), 120)
    })

    const togglePreview = () => setShowPreview((value) => !value)

    const selectCursor = (index: number) => {
      const count = selectableEntries().length
      if (count === 0) return
      cancelDelete()
      const next = Math.max(0, Math.min(count - 1, index))
      const id = selectableEntries()[next].id
      const flat = pickerRows()
      const target = flat.findIndex((row) => row.kind === "item" && row.entry.id === id)
      let start = Math.min(viewportStart(), maxViewportStart())
      if (target < start) start = target
      else while (start < target && !pickerWindow(flat, start, listHeight(), hasExcerpt).some(
        (row) => row.kind === "item" && row.entry.id === id,
      )) start++
      setViewportStart(Math.max(0, Math.min(start, maxViewportStart())))
      setCursor(next)
    }
    const moveCursor = (delta: number) => selectCursor(cursor() + delta)

    // Match OpenTUI's scrollbox: honor every wheel event's delta. The viewport
    // stays independent of selection, so fast scrolling cannot recenter on hover.
    const scrollPicker = (scroll?: { direction: string; delta: number }) => {
      if (showPreview() || !scroll || (scroll.direction !== "up" && scroll.direction !== "down")) return
      const amount = Math.trunc(scroll.delta) * (scroll.direction === "down" ? 1 : -1)
      setViewportStart((start) => Math.max(0, Math.min(maxViewportStart(), start + amount)))
    }

    // Delete confirmation lives in its own layer, registered only while a row
    // is armed, so y/n never shadow the search box's typing.
    let disposeConfirm: (() => void) | undefined
    let confirmTimer: ReturnType<typeof setTimeout> | undefined
    const cancelDelete = () => {
      if (confirmTimer) clearTimeout(confirmTimer)
      confirmTimer = undefined
      disposeConfirm?.()
      disposeConfirm = undefined
      setPendingDelete(undefined)
    }

    const confirmArmed = (): boolean => {
      const armed = pendingDelete()
      if (!armed) return false
      void deleteEntry(armed)
      return true
    }

    // Escape first closes the transcript overlay, then the picker. One Escape
    // can reach both the focused search input and the key layer (sometimes in
    // separate ticks), so ignore the duplicate that trails right behind.
    let escapeHandledAt = 0
    const handleEscape = () => {
      const now = Date.now()
      if (escapeHandledAt > now) return
      if (showPreview()) {
        setShowPreview(false)
        escapeHandledAt = now + 150
        return
      }
      if (pendingDelete()) {
        cancelDelete()
        escapeHandledAt = now + 150
        return
      }
      cancelDelete()
      close()
    }

    const deleteEntry = async (entry: Entry) => {
      cancelDelete()
      try {
        const result = await api.client.session.delete({
          sessionID: entry.id,
          directory: entry.dir || undefined,
        })
        if (result && "error" in result && result.error) throw result.error
        const { entries: remaining } = await fetchEntries(api)
        if (remaining.some((item) => item.id === entry.id)) {
          setAllEntries(remaining)
          api.ui.toast({ message: "Session was not deleted", variant: "error" })
          return
        }
        deletedAt = selectableEntries().findIndex((item) => item.id === entry.id)
        if (deletedAt < 0) deletedAt = undefined
        setAllEntries(remaining)
        api.ui.toast({ message: `Deleted "${truncate(entry.title, 40)}"`, variant: "info" })
        if (currentSessionID() === entry.id) api.route.navigate("home")
      } catch {
        api.ui.toast({ message: "Could not delete session", variant: "error" })
      }
    }

    const armDelete = (entry: Entry) => {
      setPendingDelete(entry)
      if (confirmTimer) clearTimeout(confirmTimer)
      confirmTimer = setTimeout(cancelDelete, 5000)
      disposeConfirm?.()
      disposeConfirm = api.keymap.registerLayer({
        mode: "modal",
        priority: 20,
        bindings: [
          {
            key: "y",
            desc: "Confirm delete",
            preventDefault: true,
            cmd: () => {
              confirmArmed()
            },
          },
          {
            key: "alt+d",
            desc: "Confirm delete",
            preventDefault: true,
            cmd: () => {
              confirmArmed()
            },
          },
          {
            key: "enter",
            desc: "Confirm delete",
            preventDefault: true,
            cmd: () => {
              confirmArmed()
            },
          },
          { key: "n", desc: "Cancel delete", preventDefault: true, cmd: cancelDelete },
          { key: "escape", desc: "Cancel delete", preventDefault: true, cmd: cancelDelete },
        ],
      })
    }

    const forkEntry = async (entry: Entry) => {
      try {
        const result = await api.client.session.fork({
          sessionID: entry.id,
          directory: entry.dir || undefined,
        })
        const created = (result?.data ?? result) as Session | undefined
        if (!created?.id) throw new Error("fork returned no session")
        cleanup()
        api.ui.dialog.clear()
        api.route.navigate("session", { sessionID: created.id })
        api.ui.toast({ message: `Forked "${truncate(entry.title, 40)}"`, variant: "info" })
      } catch {
        api.ui.toast({ message: "Could not fork session", variant: "error" })
      }
    }

    const choose = (entry?: Entry) => {
      const target = entry ?? selectableEntries()[cursor()]
      if (!target) return
      cleanup()
      api.ui.dialog.clear()
      api.route.navigate("session", { sessionID: target.id })
    }

    const disposeNav = api.keymap.registerLayer({
      mode: "modal",
      priority: 1,
      bindings: [
        { key: "up", desc: "Previous session", preventDefault: true, cmd: () => moveCursor(-1) },
        { key: "down", desc: "Next session", preventDefault: true, cmd: () => moveCursor(1) },
        { key: "pageup", desc: "Page up", preventDefault: true, cmd: () => moveCursor(-10) },
        { key: "pagedown", desc: "Page down", preventDefault: true, cmd: () => moveCursor(10) },
        { key: "home", desc: "First session", preventDefault: true, cmd: () => selectCursor(0) },
        {
          key: "end",
          desc: "Last session",
          preventDefault: true,
          cmd: () => selectCursor(selectableEntries().length - 1),
        },
        {
          key: "enter",
          desc: "Open session",
          preventDefault: true,
          cmd: () => {
            if (confirmArmed()) return
            choose()
          },
        },
        { key: "alt+p", desc: "Toggle transcript preview", preventDefault: true, cmd: togglePreview },
        { key: "ctrl+s", desc: "Pin session", preventDefault: true, cmd: () => {
          const entry = selectableEntries()[cursor()]
          if (entry) onTogglePin("sessions", entry.id)
        } },
        { key: "ctrl+d", desc: "Pin directory", preventDefault: true, cmd: () => {
          const entry = selectableEntries()[cursor()]
          if (entry) onTogglePin("directories", entry.dir)
        } },
        {
          key: "alt+d",
          desc: "Delete session",
          preventDefault: true,
          cmd: () => {
            if (confirmArmed()) return
            const target = selectableEntries()[cursor()]
            if (target) armDelete(target)
          },
        },
        {
          key: "ctrl+f",
          desc: "Fork session",
          preventDefault: true,
          cmd: () => {
            const target = selectableEntries()[cursor()]
            if (target) void forkEntry(target)
          },
        },
        {
          key: "ctrl+g",
          desc: "Toggle project scope",
          preventDefault: true,
          cmd: () => {
            const target = selectableEntries()[cursor()]
            if (scope()) setScope(undefined)
            else if (target) setScope(target.group)
          },
        },
        { key: "alt+w", desc: "Filter needs input", preventDefault: true, cmd: () => setWaitingOnly((value) => !value) },
        { key: "alt+s", desc: "Filter pinned sessions", preventDefault: true, cmd: () => setPinnedOnly((value) => !value) },
        {
          key: "escape",
          desc: "Close",
          preventDefault: true,
          cmd: handleEscape,
        },
      ],
    })

    const cleanup = () => {
      if (!alive) return
      alive = false
      if (confirmTimer) clearTimeout(confirmTimer)
      pickerState = { query: query(), scope: scope(), waitingOnly: waitingOnly(), pinnedOnly: pinnedOnly() }
      disposeNav()
      disposeConfirm?.()
      disposeConfirm = undefined
      if (previewTimer) clearTimeout(previewTimer)
    }

    api.ui.dialog.replace(
      () => (
        <box
          flexDirection="column"
          height={dialogHeight()}
          marginTop={dialogOffset()}
          paddingTop={1}
          paddingBottom={1}
          gap={1}
          backgroundColor={api.theme.current.backgroundPanel}
        >
          <box paddingLeft={4} paddingRight={4}>
            <box flexDirection="row" justifyContent="space-between">
              <text attributes={TextAttributes.BOLD}>
                Sessions <span style={{ fg: api.theme.current.textMuted }}>({selectableEntries().length})</span>
              </text>
              <text style={{ fg: api.theme.current.textMuted }} onMouseUp={close}>
                esc
              </text>
            </box>
            <box paddingTop={1}>
              <input
                focused
                placeholder="Search title, directory, transcript…"
                value={query()}
                placeholderColor={api.theme.current.textMuted}
                focusedBackgroundColor={api.theme.current.backgroundPanel}
                focusedTextColor={api.theme.current.text}
                cursorColor={api.theme.current.primary}
                onInput={(value) => {
                  if (pendingDelete()) return
                  setQuery(value)
                }}
                onSubmit={() => {
                  if (confirmArmed()) return
                  choose()
                }}
                onKeyDown={(event) => {
                  if (event.name === "escape") {
                    event.preventDefault()
                    handleEscape()
                    return
                  }
                  if (event.ctrl && event.name === "x") {
                    event.preventDefault()
                    if (confirmArmed()) return
                    const target = selectableEntries()[cursor()]
                    if (target) armDelete(target)
                    return
                  }
                  if (event.ctrl && event.name === "f") {
                    event.preventDefault()
                    const target = selectableEntries()[cursor()]
                    if (target) void forkEntry(target)
                    return
                  }
                  if (pendingDelete()) {
                    if (event.name === "y" || event.name === "enter" || event.name === "return") {
                      event.preventDefault()
                      confirmArmed()
                      return
                    }
                    if (event.name === "n") {
                      event.preventDefault()
                      cancelDelete()
                      return
                    }
                  }
                }}
              />
            </box>
            <Show when={coverageLabel()}>
              <box paddingTop={1}>
                <text style={{ fg: api.theme.current.textMuted }}>{coverageLabel()}</text>
              </box>
            </Show>
            <box flexDirection="row" gap={2} paddingTop={1}>
              <text style={{ fg: scope() ? api.theme.current.accent : api.theme.current.textMuted }} onMouseDown={() => {
                const group = currentProject()
                if (group) setScope(scope() === group ? undefined : group)
                else api.ui.toast({ message: "No current project to filter", variant: "info" })
              }}>
                {scope() ? `Project: ${truncate(scope()!, 22)}` : "Project: all"}
              </text>
              <text style={{ fg: waitingOnly() ? api.theme.current.warning : api.theme.current.textMuted }} onMouseDown={() => setWaitingOnly((value) => !value)}>
                {waitingOnly() ? "● Needs input" : "○ Needs input"}
              </text>
              <text style={{ fg: pinnedOnly() ? api.theme.current.accent : api.theme.current.textMuted }} onMouseDown={() => setPinnedOnly((value) => !value)}>
                {pinnedOnly() ? "★ Pinned" : "☆ Pinned"}
              </text>
            </box>
          </box>
          <box
            flexDirection="column"
            flexGrow={1}
            overflow="hidden"
            onMouseScroll={(event: { scroll?: { direction: string; delta: number } }) => {
              scrollPicker(event.scroll)
            }}
          >
            <For each={visiblePickerRows()}>
                {(row) => {
                  if (row.kind === "group") return (
                    <box flexDirection="row" paddingTop={row.continued ? 0 : 1} paddingLeft={4} paddingRight={4}
                      onMouseDown={() => setCollapsed((state) => ({ ...state, [row.dir]: !state[row.dir] }))}>
                      <text flexGrow={1} flexShrink={1} wrapMode="none" style={{ fg: api.theme.current.accent }} attributes={TextAttributes.BOLD}>
                        {collapsed()[row.dir] && !query().trim() ? "▸ " : "▾ "}{row.pinned ? "★ " : ""}{row.label}
                      </text>
                      <text flexShrink={0} style={{ fg: api.theme.current.textMuted }}> ({row.count})</text>
                    </box>
                  )
                  const excerpt = createMemo(() => transcriptMatchExcerpt(searchIndex().get(row.entry.id), row.entry, query()))
                  return (
                    <box
                      flexDirection="column"
                      paddingLeft={6}
                      paddingRight={4}
                      backgroundColor={
                        row.entry.id === selectableEntries()[cursor()]?.id
                          ? api.theme.current.backgroundElement
                          : RGBA.fromInts(0, 0, 0, 0)
                      }
                      onMouseMove={() => {
                        // Repainting under a stationary pointer must not select
                        // another row while the wheel is moving the viewport.
                        const index = selectableEntries().findIndex((entry) => entry.id === row.entry.id)
                        if (index >= 0) setCursor(index)
                      }}
                      onMouseDown={(event: { button?: number }) =>
                        event.button === RIGHT_BUTTON ? (cleanup(), api.ui.dialog.clear(), openInCmuxWorkspace(api, row.entry)) : choose(row.entry)
                      }
                    >
                      <box flexDirection="row" gap={1}>
                      <text flexShrink={0} style={{ fg: row.entry.id === selectableEntries()[cursor()]?.id
                        ? api.theme.current.text : api.theme.current.textMuted }}>
                        {row.last ? "└" : "├"}
                      </text>
                      <Show when={row.entry.id === currentSessionID()}>
                        <text
                          flexShrink={0}
                          style={{
                            fg:
                              row.entry.id === selectableEntries()[cursor()]?.id
                                ? api.theme.current.text
                                : api.theme.current.primary,
                          }}
                        >
                          ●
                        </text>
                      </Show>
                      <Highlighted
                        text={`${pins().sessions.includes(row.entry.id) ? "★ " : ""}${truncate(row.entry.title, pins().sessions.includes(row.entry.id) ? 59 : 61)}`}
                        query={query()}
                        bold={row.entry.id === selectableEntries()[cursor()]?.id}
                        color={
                          row.entry.id === selectableEntries()[cursor()]?.id
                            ? api.theme.current.text
                            : api.theme.current.text
                        }
                        matchColor={
                          row.entry.id === selectableEntries()[cursor()]?.id
                            ? api.theme.current.text
                            : api.theme.current.warning
                        }
                      />
                      <text
                        flexShrink={0}
                        style={{
                          fg:
                            pendingDelete()?.id === row.entry.id
                              ? api.theme.current.error
                              : row.entry.id === selectableEntries()[cursor()]?.id
                                ? api.theme.current.text
                                : api.theme.current.textMuted,
                        }}
                      >
                        {pendingDelete()?.id === row.entry.id
                          ? "press y to delete"
                          : `${ago(row.entry.updated)}${
                              query().trim() &&
                              !`${row.entry.title} ${row.entry.dir}`.toLowerCase().includes(query().trim().toLowerCase())
                                ? " · transcript match"
                                : ""
                            }`}
                      </text>
                      </box>
                      <Show when={excerpt()}>
                        {(match: Accessor<string>) => (
                          <box flexDirection="row" gap={1} paddingLeft={2}>
                            <text flexShrink={0} style={{ fg: api.theme.current.textMuted }}>↳</text>
                            <Highlighted
                              text={match()}
                              query={query()}
                              color={row.entry.id === selectableEntries()[cursor()]?.id ? api.theme.current.text : api.theme.current.textMuted}
                              matchColor={api.theme.current.warning}
                            />
                          </box>
                        )}
                      </Show>
                    </box>
                  )
                }}
              </For>
              <Show when={matchedGroups().length === 0}>
                <box paddingLeft={4} paddingRight={4}>
                  <text style={{ fg: api.theme.current.textMuted }}>
                    {waitingOnly() && waitingCoverage() === "loading"
                        ? "Checking which sessions need input…"
                      : waitingOnly() && waitingCoverage() === "unavailable"
                        ? "Needs-input data unavailable · turn off the filter"
                      : pinnedOnly() && pins().sessions.length === 0
                        ? "No pinned sessions yet · ctrl+s pins a session"
                      : !indexProgress().complete && query().trim()
                        ? "No matches yet · still searching transcripts…"
                      : scope()
                        ? `No matches in ${scope()} · ctrl+g for all projects`
                        : waitingOnly()
                          ? "No sessions need input with these filters"
                        : "No sessions match · try another search"}
                  </text>
                </box>
              </Show>
            </box>
          <box paddingLeft={4} paddingRight={4} flexShrink={0} flexDirection="column">
            <text
              style={{
                fg: pendingDelete() ? api.theme.current.warning : api.theme.current.textMuted,
              }}
            >
              {pendingDelete()
                ? `Delete "${truncate(pendingDelete()!.title, 40)}"? y confirm · n cancel`
                : "↑↓ move · enter open · ctrl+g project · option+w input · option+s pinned · option+p preview"}
            </text>
            <Show when={!pendingDelete()}>
              <text style={{ fg: api.theme.current.textMuted }}>ctrl+s/d pin · option+d delete · ctrl+f fork · esc close</text>
            </Show>
          </box>
          <Show when={showPreview()}>
            <box
              position="absolute"
              left={0}
              top={0}
              width={dialogWidth}
              height={dialogHeight()}
              flexDirection="column"
              backgroundColor={api.theme.current.backgroundPanel}
              paddingLeft={4}
              paddingRight={4}
              paddingTop={1}
              paddingBottom={1}
              gap={1}
            >
              <box flexDirection="row" justifyContent="space-between">
                <text attributes={TextAttributes.BOLD}>
                  {previewID() ? truncate(selectableEntries()[cursor()]!.title, dialogWidth - 18) : "Preview"}
                </text>
                <text style={{ fg: api.theme.current.textMuted }}>esc close</text>
              </box>
              <Show when={previewID()}>
                <text style={{ fg: api.theme.current.textMuted }}>
                  {prettyDir(selectableEntries()[cursor()]!.dir, process.env.HOME ?? "")} · {ago(selectableEntries()[cursor()]!.updated)}
                </text>
              </Show>
              <scrollbox flexGrow={1} scrollbarOptions={{ visible: false }}>
                <Show when={previewID()} fallback={<text style={{ fg: api.theme.current.textMuted }}>Select a session to preview</text>}>
                  <Show when={previewText()} fallback={<text style={{ fg: api.theme.current.textMuted }}>Loading…</text>}>
                    {(text: Accessor<string>) =>
                      getMarkdownStyle(api.theme.current) ? (
                        <markdown
                          content={text()}
                          syntaxStyle={getMarkdownStyle(api.theme.current)!}
                          treeSitterClient={getTreeSitterClient()}
                        />
                      ) : (
                        <text wrapMode="word">{text()}</text>
                      )
                    }
                  </Show>
                </Show>
              </scrollbox>
              <text style={{ fg: api.theme.current.textMuted }}>↑↓ switch session · esc back to picker</text>
            </box>
          </Show>
        </box>
      ),
      () => {
        cleanup()
      },
    )
    api.ui.dialog.setSize("xlarge")
  }

  // Read-only digest dialog: spend per project, last day beside lifetime.
  // Same message-level sums as `sesh costs`; the dialog just renders them.
  const openCosts = async (command = false) => {
    if (!command && api.mode.current() !== BASE_MODE) return
    if (!command && api.renderer.currentFocusedEditor === null) return
    type CostRow = { directory: string; window: number; lifetime: number; sessions: number }
    let rows: CostRow[] = []
    let failed = false
    try {
      const db = await openTranscriptDb()
      if (!db) failed = true
      else {
        try {
          const cutoff = Date.now() - 86400000
          const raw = (db.query(`
SELECT s.directory AS directory,
  ROUND(SUM(CASE WHEN m.time_created >= ${cutoff} THEN COALESCE(json_extract(m.data, '$.cost'), 0) ELSE 0 END), 4) AS window_cost,
  ROUND(SUM(COALESCE(json_extract(m.data, '$.cost'), 0)), 4) AS lifetime_cost,
  COUNT(DISTINCT s.id) AS sessions
FROM session_message m
JOIN session_v2 s ON s.id = m.session_id
WHERE m.type = 'assistant'
  AND json_extract(m.data, '$.cost') IS NOT NULL
GROUP BY s.directory
ORDER BY lifetime_cost DESC`).all() ?? []) as {
            directory: unknown
            window_cost: unknown
            lifetime_cost: unknown
            sessions: unknown
          }[]
          rows = raw
            .filter(
              (
                row,
              ): row is {
                directory: string
                window_cost: number
                lifetime_cost: number
                sessions: number
              } =>
                typeof row?.directory === "string" &&
                typeof row?.window_cost === "number" &&
                typeof row?.lifetime_cost === "number" &&
                typeof row?.sessions === "number" &&
                row.lifetime_cost > 0,
            )
            .map((row) => ({
              directory: row.directory,
              window: row.window_cost,
              lifetime: row.lifetime_cost,
              sessions: row.sessions,
            }))
        } finally {
          db.close()
        }
      }
    } catch {
      failed = true
    }
    const money = (n: number) => (n === 0 ? "—" : `$${n.toFixed(2)}`)
    const home = process.env.HOME ?? ""
    const disposeKeys = api.keymap.registerLayer({
      mode: "modal",
      bindings: [
        { key: "escape", desc: "Close", preventDefault: true, cmd: () => api.ui.dialog.clear() },
      ],
    })
    api.ui.dialog.replace(
      () => (
        <box flexDirection="column" paddingLeft={4} paddingRight={4} paddingTop={1} gap={1} backgroundColor={api.theme.current.backgroundPanel}>
          <text attributes={TextAttributes.BOLD}>
            Cost digest{" "}
            <span style={{ fg: api.theme.current.textMuted }}>(24h · lifetime)</span>
          </text>
          <Show
            when={!failed && rows.length > 0}
            fallback={
              <text style={{ fg: api.theme.current.textMuted }}>
                {failed ? "Cost data unavailable." : "No assistant cost recorded."}
              </text>
            }
          >
            <For each={rows}>
              {(row) => (
                <box flexDirection="row" gap={2}>
                  <text flexShrink={0} style={{ fg: api.theme.current.success }}>
                    {money(row.window)}
                  </text>
                  <text flexShrink={0} style={{ fg: api.theme.current.textMuted }}>
                    {money(row.lifetime)}
                  </text>
                  <text flexShrink={0} style={{ fg: api.theme.current.textMuted }}>
                    ({row.sessions})
                  </text>
                  <text flexGrow={1} flexShrink={1} wrapMode="none">
                    {prettyDir(row.directory, home)}
                  </text>
                </box>
              )}
            </For>
          </Show>
          <box flexShrink={0}>
            <text style={{ fg: api.theme.current.textMuted }}>esc close</text>
          </box>
        </box>
      ),
      () => {
        disposeKeys()
      },
    )
    api.ui.dialog.setSize("large")
  }

  // Triage dialog: the waiting set as an openable list. Enter opens the
  // highlighted session; the sidebar section stays the always-visible view.
  let lastNeedsID: string | undefined
  const openNeeds = async (command = false) => {
    if (!command && api.mode.current() !== BASE_MODE) return
    if (!command && api.renderer.currentFocusedEditor === null) return
    let items: { entry: Entry; reason: string; since?: number }[] = []
    try {
      const { entries } = await fetchEntries(api)
      const db = await openTranscriptDb()
      if (!db) {
        api.ui.toast({ message: "Needs-input data unavailable", variant: "error" })
        return
      }
      let waiting: Map<string, WaitingDetail>
      try {
        waiting = await queryWaitingDetails(db)
      } finally {
        db.close()
      }
      items = entries
        .filter((entry) => waiting.has(entry.id))
        .map((entry) => ({
          entry,
          reason: waiting.get(entry.id)?.reason === "question" ? "awaiting answer" : "run stuck",
          since: waiting.get(entry.id)?.since,
        }))
        .sort((a, b) => (a.since ?? a.entry.updated) - (b.since ?? b.entry.updated))
    } catch {
      api.ui.toast({ message: "Could not load sessions", variant: "error" })
      return
    }
    if (items.length === 0) {
      api.ui.toast({ message: "No sessions are waiting on you.", variant: "info" })
      return
    }
    const route = api.route.current
    const currentID = route.name === "session" ? route.params?.sessionID : undefined
    const previous = items.findIndex((item) => item.entry.id === (currentID ?? lastNeedsID))
    const [cursor, setCursor] = createSignal(previous < 0 ? 0 : (previous + 1) % items.length)
    const moveCursor = (delta: number) =>
      setCursor((value) => Math.max(0, Math.min(items.length - 1, value + delta)))
    const choose = (target = items[cursor()]) => {
      if (!target) return
      lastNeedsID = target.entry.id
      disposeNav()
      api.ui.dialog.clear()
      api.route.navigate("session", { sessionID: target.entry.id })
    }
    const disposeNav = api.keymap.registerLayer({
      mode: "modal",
      bindings: [
        { key: "up", desc: "Previous session", preventDefault: true, cmd: () => moveCursor(-1) },
        { key: "down", desc: "Next session", preventDefault: true, cmd: () => moveCursor(1) },
        { key: "enter", desc: "Open session", preventDefault: true, cmd: () => choose() },
        { key: "n", desc: "Open next waiting session", preventDefault: true, cmd: () => {
          const at = items.findIndex((item) => item.entry.id === currentID)
          choose(items[at < 0 ? cursor() : (at + 1) % items.length])
        } },
        {
          key: "escape",
          desc: "Close",
          preventDefault: true,
          cmd: () => api.ui.dialog.clear(),
        },
      ],
    })
    const home = process.env.HOME ?? ""
    api.ui.dialog.replace(
      () => (
        <box flexDirection="column" paddingLeft={4} paddingRight={4} paddingTop={1} gap={1} backgroundColor={api.theme.current.backgroundPanel}>
          <text attributes={TextAttributes.BOLD}>
            Needs input{" "}
            <span style={{ fg: api.theme.current.textMuted }}>({items.length} · longest waiting first)</span>
          </text>
          <scrollbox flexGrow={1} height={Math.max(6, Math.floor(api.renderer.height / 2) - 10)} scrollbarOptions={{ visible: false }}>
            <For each={items}>
              {(item, index) => (
                <box
                  flexDirection="row"
                  gap={2}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={
                    index() === cursor()
                      ? api.theme.current.backgroundElement
                      : RGBA.fromInts(0, 0, 0, 0)
                  }
                  onMouseDown={() => {
                    setCursor(index())
                    choose(item)
                  }}
                >
                  <text
                    flexGrow={1}
                    flexShrink={1}
                    wrapMode="none"
                    style={{
                      fg:
                        index() === cursor()
                          ? api.theme.current.text
                          : api.theme.current.text,
                    }}
                  >
                    {truncate(item.entry.title, 48)}
                  </text>
                  <text
                    flexShrink={0}
                    style={{
                      fg:
                        index() === cursor()
                          ? api.theme.current.text
                          : api.theme.current.warning,
                    }}
                  >
                    {item.reason}
                  </text>
                  <text
                    flexShrink={0}
                    style={{
                      fg:
                        index() === cursor()
                          ? api.theme.current.text
                          : api.theme.current.textMuted,
                    }}
                  >
                    {prettyDir(item.entry.dir, home)} · {item.since === undefined ? "time unknown" : `waiting ${ago(item.since)}`}
                  </text>
                </box>
              )}
            </For>
          </scrollbox>
          <box flexShrink={0}>
            <text style={{ fg: api.theme.current.textMuted }}>↑↓ navigate · enter open · n open next waiting · esc close</text>
          </box>
        </box>
      ),
      () => {
        disposeNav()
      },
    )
    api.ui.dialog.setSize("large")
  }

  api.command?.register(() => [
    {
      title: "Pick session (all directories)",
      value: "sesh.pick",
      description: "Switch to any session across all project directories",
      category: "Sessions",
      slash: { name: "sesh" },
      onSelect: () => {
        void openPicker(true)
      },
    },
    {
      title: "Cost digest (per project)",
      value: "sesh.costs",
      description: "Spend per project, last day and lifetime",
      category: "Sessions",
      slash: { name: "sesh-costs" },
      onSelect: () => {
        void openCosts(true)
      },
    },
    {
      title: "Sessions waiting on you",
      value: "sesh.needs",
      description: "Unanswered questions and stuck runs",
      category: "Sessions",
      slash: { name: "sesh-needs" },
      onSelect: () => {
        void openNeeds(true)
      },
    },
  ])

  api.keymap.registerLayer({
    bindings: [{ key: "alt+o", desc: "Pick session", preventDefault: true, cmd: () => void openPicker() }],
  })
}

let hostOwner: ReturnType<typeof getOwner> = null

function adaptTheme(theme: Plugin.Context["theme"]) {
  const opaque = (color: RGBA) => RGBA.fromValues(color.r, color.g, color.b, 1)
  return {
    text: theme.text.base,
    textMuted: theme.text.muted,
    background: theme.background.base,
    backgroundPanel: opaque(theme.background.raised.base),
    backgroundElement: opaque(theme.background.raised.high),
    border: theme.border.base,
    borderActive: theme.hue.accent[200],
    borderSubtle: theme.border.base,
    accent: theme.hue.accent[200],
    primary: theme.hue.accent[200],
    secondary: theme.text.action.secondary.base,
    error: theme.text.feedback.error.base,
    warning: theme.text.feedback.warning.base,
    success: theme.text.feedback.success.base,
    info: theme.text.feedback.info.base,
    selectedListItemText: theme.text.base,
    syntaxComment: theme.syntax.comment,
    syntaxString: theme.syntax.string,
    syntaxNumber: theme.syntax.number,
    syntaxKeyword: theme.syntax.keyword,
    syntaxType: theme.syntax.type,
    syntaxFunction: theme.syntax.function,
    syntaxOperator: theme.syntax.operator,
    syntaxVariable: theme.syntax.variable,
    syntaxPunctuation: theme.syntax.punctuation,
    markdownLink: theme.markdown.link,
    markdownLinkText: theme.markdown.linkText,
    markdownBlockQuote: theme.markdown.blockQuote,
  }
}

function createApi(ctx: Plugin.Context) {
  const [dialogOpen, setDialogOpen] = createSignal(false)
  let sourceTheme: Plugin.Context["theme"] | undefined
  let currentTheme: ReturnType<typeof adaptTheme>
  return {
    theme: {
      get current() {
        if (sourceTheme !== ctx.theme) {
          sourceTheme = ctx.theme
          currentTheme = adaptTheme(sourceTheme)
        }
        return currentTheme!
      },
    },
    ui: {
      toast(opts: { title?: string; message: string; variant?: "info" | "warning" | "error" | "success" }) {
        ctx.ui.toast.show({
          title: opts.title ?? "Sessions",
          message: opts.message,
          variant: opts.variant ?? "info",
        })
      },
      dialog: {
        clear() {
          ctx.ui.dialog.clear()
          setDialogOpen(false)
        },
        replace(render: () => any, onClose?: () => void) {
          let closed = false
          ctx.ui.dialog.show(render, () => {
            if (closed) return
            closed = true
            setDialogOpen(false)
            onClose?.()
          })
          setDialogOpen(true)
        },
        setSize(size: Parameters<Plugin.Context["ui"]["dialog"]["set"]>[0]["size"]) {
          ctx.ui.dialog.set({ size })
        },
        // V2's Dialog has no reactive open/isOpen accessor; track it locally
        // from the replace/clear calls above and the host's onClose callback.
        get open() {
          return dialogOpen()
        },
      },
    },
    route: {
      get current() {
        const r = ctx.ui.router.current()
        if (r.type === "session") {
          return { name: "session", params: { sessionID: r.sessionID } }
        }
        return { name: r.type, params: {} }
      },
      navigate(name: string, params?: { sessionID?: string }) {
        if (name === "session" && params?.sessionID) {
          ctx.ui.router.navigate({ type: "session", sessionID: params.sessionID })
        } else if (name === "home") {
          ctx.ui.router.navigate({ type: "home" })
        }
      },
    },
    state: {
      path: {
        get directory() {
          return ctx.location?.directory ?? process.cwd()
        },
      },
      session: {
        status(id: string) {
          return ctx.data.session.status(id)
        },
      },
    },
    mode: {
      current() {
        return ctx.keymap.mode.current()
      },
    },
    renderer: {
      get height() {
        return ctx.renderer?.height ?? 40
      },
      get width() {
        return ctx.renderer?.width ?? 120
      },
      get root() {
        return ctx.renderer.root
      },
      get currentFocusedEditor() {
        return ctx.renderer.currentFocusedEditor
      },
      on(event: string, handler: (...args: any[]) => void) {
        ctx.renderer.on(event, handler)
      },
      off(event: string, handler: (...args: any[]) => void) {
        ctx.renderer.off(event, handler)
      },
    },
    keymap: {
      registerLayer(layer: {
        mode?: string
        priority?: number
        bindings?: Array<{ key: string; desc?: string; preventDefault?: boolean; cmd: () => void }>
      }) {
        return runWithOwner(hostOwner, () => createRoot((dispose) => {
          ctx.keymap.layer(() => ({
            mode: layer.mode ?? "base",
            priority: layer.priority ?? 20,
            commands: (layer.bindings ?? []).map((b) => ({
              title: b.desc,
              bind: b.key,
              run: () => {
                b.cmd()
              },
            })),
          }))
          return dispose
        }))!
      },
    },
    slots: {
      register(cfg: { order?: number; slots: Record<string, () => any> }) {
        if (cfg.slots.sidebar_content) {
          ctx.ui.slot({
            prepend: "sidebar.content",
            render: cfg.slots.sidebar_content as any,
          })
        }
        if (cfg.slots.home_bottom) {
          ctx.ui.slot({
            prepend: "home.footer",
            render: cfg.slots.home_bottom as any,
          })
        }
      },
    },
    command: {
      register(factory: () => Array<{
        title: string
        value: string
        description?: string
        category?: string
        slash?: { name: string }
        onSelect: () => void
      }>) {
        ctx.keymap.layer(() => ({
          mode: "global",
          priority: 20,
          commands: factory().map((cmd) => ({
            id: cmd.value,
            title: cmd.title,
            description: cmd.description,
            group: cmd.category,
            palette: true,
            slash: cmd.slash ? { name: cmd.slash.name } : undefined,
            run: () => {
              cmd.onSelect()
            },
          })),
        }))
      },
    },
    client: {
      project: {
        async list() {
          const res: any = await ctx.client.project.list()
          return { data: Array.isArray(res) ? res : (res?.data ?? []) }
        },
      },
      session: {
        async delete(req: { sessionID: string; directory?: string }) {
          await ctx.client.session.remove({ sessionID: req.sessionID })
          return { data: undefined }
        },
        async fork(req: { sessionID: string; directory?: string }) {
          const res = await ctx.client.session.fork({ sessionID: req.sessionID })
          return { data: res }
        },
        async messages(req: { sessionID: string; preview?: boolean }) {
          let cursor: string | undefined
          const all = []
          do {
            const res = await ctx.client.message.list({ sessionID: req.sessionID, order: req.preview ? "desc" : "asc", limit: 100, cursor })
            all.push(...res.data)
            const next = res.cursor.next
            if (req.preview || !next || next === cursor) break
            cursor = next
          } while (true)
          if (req.preview) all.reverse()
          const messages = all.map((m) => {
            let text = ""
            if (m.type === "user") text = m.text ?? ""
            else if (m.type === "assistant") {
              text = (m.content ?? [])
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n")
            }
            return {
              id: m.id,
              info: { role: m.type },
              parts: [{ type: "text", text }],
            }
          })
          return { data: messages }
        },
      },
      experimental: {
        session: {
          async list(input: { limit: number; cursor?: string; roots?: boolean; directory?: string }) {
            const res = await ctx.client.session.list({ parentID: null, order: "desc", limit: input.limit, cursor: input.cursor })
            return { cursor: res.cursor, data: res.data.map((s) => ({
                ...s,
                directory: s.location?.directory ?? "",
              })) }
          },
        },
      },
    },
  }
}

export default Plugin.define({
  id: "sesh-panel",
  async setup(ctx) {
    const api = createApi(ctx)
    let initialized = false
    const disposeSlot = ctx.ui.slot({
      append: "app",
      render: () => {
        if (!initialized) {
          initialized = true
          hostOwner = getOwner()
          void tui(api)
        }
        return <box />
      },
    })
    return () => {
      if (api.ui.dialog.open) api.ui.dialog.clear()
      disposeSlot()
      removeRootMouse?.()
    }
  },
})
