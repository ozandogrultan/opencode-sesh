/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Project, Session } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { getTreeSitterClient, RGBA, SyntaxStyle, TextAttributes } from "@opentui/core"

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
    { scope: ["markup.raw.inline"], style: { foreground: theme.syntaxString, background: theme.background } },
    {
      scope: ["markup.link", "markup.link.url", "string.special", "string.special.url"],
      style: { foreground: theme.markdownLink, underline: true },
    },
    { scope: ["markup.link.label", "label"], style: { foreground: theme.markdownLinkText, underline: true } },
    { scope: ["conceal"], style: { foreground: theme.textMuted } },
  ])
}

function getMarkdownStyle(theme: ThemeColors): SyntaxStyle | undefined {
  if (markdownStyleCache?.theme === theme) return markdownStyleCache.style
  try {
    markdownStyleCache = { theme, style: buildMarkdownStyle(theme) }
    return markdownStyleCache.style
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
//    view. Rows are display-only; ctrl+o opens the full picker.
// 2. Picker (ctrl+o, `/sesh`, command palette): an xlarge grouped picker over
//    every session across all project directories, newest first.
//
// `/sesh` is registered by this plugin (a markdown command cannot open the
// dialog). Native `/sessions` and session_list (<leader>l) stay untouched.
const BASE_MODE = "base"
const POLL_MS = 15_000
// Titles that must never become a cmux workspace name: opencode's pre-first-
// turn placeholder, and the sentinel other plugins (opencode-ghost) use for
// internal sessions so their scaffolding rows stay out of the UI.
const PLACEHOLDER_TITLE = /^New session\b|^ghost-hidden$/i

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
// scrollbox. The picker (ctrl+o) remains the place for transcript search.

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

function ensureRootMouse(renderer: TuiPluginApi["renderer"]) {
  if (rootMouseInstalled || !renderer?.root) return
  rootMouseInstalled = true
  const root = renderer.root as unknown as {
    onMouseDown?: (event: unknown) => void
    _mouseListeners?: { down?: (event: unknown) => void }
  }
  const previous = root._mouseListeners?.down
  root.onMouseDown = (event) => {
    previous?.(event)
    for (const handler of [...rootMouseHandlers]) handler()
  }
}

type Entry = { id: string; title: string; dir: string; group: string; updated: number }
type EntryResult = { entries: Entry[]; truncated: boolean }

const SESSION_PAGE_LIMIT = 200
const SESSION_MAX = 5000

async function fetchEntries(api: TuiPluginApi): Promise<EntryResult> {
  const home = process.env.HOME ?? ""
  const projectResult = await api.client.project.list({})
  const projects = ((projectResult?.data ?? projectResult) as Project[]) ?? []
  const projectName = new Map<string, string>(
    projects.map((p) => [p.id, p.name?.trim() || shortDir(p.worktree ?? "", home)]),
  )
  const sessions: Session[] = []
  let cursor: number | undefined
  let truncated = false
  // Page through the global list instead of one fixed window, so sessions in
  // older directories stay searchable. `cursor` is the previous page's oldest
  // `time.updated`; a repeated or missing cursor stops the walk.
  for (;;) {
    const result = await api.client.experimental.session.list({
      limit: SESSION_PAGE_LIMIT,
      roots: true,
      directory: "",
      ...(cursor === undefined ? {} : { cursor }),
    })
    const page = ((result?.data ?? result) as Session[]) ?? []
    if (!Array.isArray(page) || page.length === 0) break
    sessions.push(...page)
    if (page.length < SESSION_PAGE_LIMIT) break
    if (sessions.length >= SESSION_MAX) {
      truncated = true
      break
    }
    const next = page[page.length - 1]?.time?.updated
    if (typeof next !== "number" || next === cursor) {
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
      return {
        id: s.id,
        title: s.title?.trim() || "(untitled)",
        dir: s.directory ?? "",
        group:
          (projectLabel && projectLabel !== "other" ? projectLabel : shortDir(s.directory ?? "", home)) ||
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
    return new sqlite.Database(`${dataHome}/opencode/opencode.db`, { readonly: true })
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
const NEEDS_INPUT_SQL = (stuckBefore: number) => `
SELECT s.id AS id,
  CASE WHEN EXISTS (
    SELECT 1 FROM part p
    WHERE p.session_id = s.id
      AND json_extract(p.data, '$.type') = 'tool'
      AND json_extract(p.data, '$.tool') = 'question'
      AND COALESCE(json_extract(p.data, '$.state.status'), 'pending') != 'completed'
      AND NOT EXISTS (
        SELECT 1 FROM message m
        WHERE m.session_id = s.id
          AND json_extract(m.data, '$.role') = 'user'
          AND m.time_created > p.time_created)
  ) THEN 'question' ELSE 'stuck' END AS reason
FROM session s
WHERE COALESCE(s.time_archived, 0) = 0
  AND s.parent_id IS NULL
  AND (EXISTS (
    SELECT 1 FROM part p
    WHERE p.session_id = s.id
      AND json_extract(p.data, '$.type') = 'tool'
      AND json_extract(p.data, '$.tool') = 'question'
      AND COALESCE(json_extract(p.data, '$.state.status'), 'pending') != 'completed'
      AND NOT EXISTS (
        SELECT 1 FROM message m
        WHERE m.session_id = s.id
          AND json_extract(m.data, '$.role') = 'user'
          AND m.time_created > p.time_created)
  ) OR EXISTS (
    SELECT 1 FROM part p2
    WHERE p2.session_id = s.id
      AND json_extract(p2.data, '$.type') = 'tool'
      AND json_extract(p2.data, '$.state.status') = 'running'
      AND p2.time_created < ${stuckBefore}))
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

// cmux bridge: which surface is running which agent session, so opening a
// session that is live in another cmux workspace focuses that workspace
// instead of opening a duplicate here. The truth is cmux's own resume record
// (`checkpoint_id` per surface), not anything this panel writes — so it also
// covers background agents and panes running an older panel. Outside cmux
// (no CMUX_WORKSPACE_ID) no cmux call is made.
type CmuxSurface = { ref: string; workspaceRef: string; here: boolean; checkpoint?: string }

async function cmuxJson(args: string[]): Promise<any | undefined> {
  try {
    const { stdout } = await promisify(execFile)("cmux", args)
    return JSON.parse(stdout)
  } catch {
    return undefined
  }
}

async function cmuxSurfaces(): Promise<CmuxSurface[]> {
  const tree = await cmuxJson(["tree", "--json", "--all"])
  if (!tree) return []
  const surfaces: CmuxSurface[] = []
  for (const w of tree.windows ?? []) {
    for (const ws of w.workspaces ?? []) {
      if (typeof ws?.ref !== "string") continue
      for (const pane of ws.panes ?? []) {
        for (const s of pane.surfaces ?? []) {
          if (s?.type === "terminal" && typeof s.ref === "string") {
            surfaces.push({ ref: s.ref, workspaceRef: ws.ref, here: s.here === true })
          }
        }
      }
    }
  }
  await Promise.all(
    surfaces.map(async (surface) => {
      const info = await cmuxJson(["surface", "resume", "show", "--surface", surface.ref, "--json"])
      const checkpoint = info?.restore_record?.checkpoint_id
      if (typeof checkpoint === "string") surface.checkpoint = checkpoint
    }),
  )
  return surfaces
}

// Pure selection: the workspace to focus for a session, or undefined to open
// locally. Prefers a live surface in a different workspace; ignores the
// caller's own surface and workspace (focusing where you already are is a
// no-op, so a local open is the better answer).
function pickFocusWorkspace(surfaces: CmuxSurface[], sessionID: string): string | undefined {
  const self = surfaces.find((surface) => surface.here)
  for (const surface of surfaces) {
    if (self && surface.ref === self.ref) continue
    if (surface.checkpoint !== sessionID) continue
    if (self && surface.workspaceRef === self.workspaceRef) continue
    return surface.workspaceRef
  }
  return undefined
}

function addTranscript(index: Map<string, string>, sid: string, data: string): void {
  try {
    const part = JSON.parse(data) as { type?: unknown; text?: unknown }
    if (part?.type !== "text" || typeof part.text !== "string") return
    const base = index.get(sid) ?? ""
    index.set(sid, `${base} ${part.text.toLowerCase()}`.trim())
  } catch {
    // ignore malformed parts
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
            `SELECT session_id AS sid, data FROM part WHERE session_id IN (${placeholders}) AND json_extract(data, '$.type') = 'text' ORDER BY time_created`,
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
        const record = JSON.parse(raw) as { fulltextLower?: unknown }
        const fulltext = typeof record?.fulltextLower === "string" ? record.fulltextLower : ""
        index.set(id, `${base} ${fulltext}`.trim())
      } catch {
        try {
          const result = await api.client.session.messages({ sessionID: id })
          const messages = result.data ?? []
          const text = messages
            .flatMap((message) =>
              message.parts
                .filter((part) => part.type === "text")
                .map((part) => (part as { text: string }).text),
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
    const result = await api.client.session.messages({ sessionID })
    const messages = result.data ?? []
    const blocks = messages
      .map((message) => {
        const text = message.parts
          .filter((part) => part.type === "text")
          .map((part) => (part as { text: string }).text)
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
    setPreviewID(entry.id)
    setPreviewText("Loading…")
    void fetchTranscriptText(api, entry.id).then((text) => {
      if (previewID() === entry.id) setPreviewText(text)
    })
    api.ui.dialog.replace(
      () => (
        <box flexDirection="column" paddingLeft={4} paddingRight={4} paddingBottom={1} gap={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text attributes={TextAttributes.BOLD}>{entry.title}</text>
            <text style={{ fg: api.theme.current.textMuted }}>esc</text>
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

  return { open }
}

type TreeRow =
  | { kind: "group"; dir: string; label: string; count: number }
  | { kind: "item"; entry: Entry; last: boolean }

type PinProps = { pins: () => Pins; onTogglePin: (kind: keyof Pins, value: string) => void; refreshPins: () => void }

function SidebarSessions(props: { api: TuiPluginApi } & PinProps) {
  const theme = () => props.api.theme.current
  const home = process.env.HOME ?? ""
  const [entries, setEntries] = createSignal<Entry[]>([])
  const [sectionCollapsed, setSectionCollapsed] = createSignal(false)
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({})
  const [hovered, setHovered] = createSignal<string>()
  const preview = createTranscriptPreview(props.api)
  const [query, setQuery] = createSignal("")
  const [deleting, setDeleting] = createSignal<string>()
  const [searching, setSearching] = createSignal(false)
  const [loadFailed, setLoadFailed] = createSignal(false)
  const [navActive, setNavActive] = createSignal(false)
  const [cursor, setCursor] = createSignal(0)
  const [pendingDelete, setPendingDelete] = createSignal<string>()
  const [waiting, setWaiting] = createSignal<Map<string, string>>(new Map())
  let confirmTimer: ReturnType<typeof setTimeout> | undefined
  let lastSyncedTitle: string | undefined
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
      // Keep this cmux workspace named after the session it is showing, so the
      // sidebar and the workspace list agree. The session title is the source
      // of truth; a placeholder title is never pushed. cmux-only.
      try {
        const workspace = process.env.CMUX_WORKSPACE_ID
        const id = currentID()
        const title = id ? (props.api.state.session.get(id)?.title ?? "").trim() : ""
        if (workspace && title && !PLACEHOLDER_TITLE.test(title) && title !== lastSyncedTitle) {
          await promisify(execFile)("cmux", ["workspace", "rename", workspace, "--title", title])
          lastSyncedTitle = title
        }
      } catch {
        // renaming is best-effort; a failure leaves the workspace name alone
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
    const ordered = pinnedFirst(entries(), props.pins())
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
    return shownEntries().filter((entry) => ids.has(entry.id))
  })
  const waitingReason = (id: string) => (waiting().get(id) === "question" ? "awaiting answer" : "run stuck")

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
      rows.push({ kind: "group", dir: group.dir, label: prettyDir(group.dir, home), count: group.list.length })
      if (collapsed()[group.dir]) continue
      for (let i = 0; i < group.list.length; i++) {
        rows.push({ kind: "item", entry: group.list[i], last: i === group.list.length - 1 })
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
    }
    setSectionCollapsed((value) => !value)
  }

  // Open a session. If a cmux surface is already running it in another
  // workspace, focus that workspace instead of opening a duplicate here;
  // otherwise open it locally. `cmux` calls only run inside cmux.
  const openSession = async (entry: Entry) => {
    if (process.env.CMUX_WORKSPACE_ID) {
      const target = pickFocusWorkspace(await cmuxSurfaces(), entry.id)
      if (target) {
        try {
          await promisify(execFile)("cmux", ["workspace", "select", target])
          return
        } catch {
          // cmux unavailable; fall through to a local open
        }
      }
    }
    props.api.route.navigate("session", { sessionID: entry.id })
  }

  // Flat order of the rows a cursor can land on, so keyboard navigation and
  // mouse hover resolve to the same row.
  const itemRows = createMemo(() => tree().flatMap((row) => (row.kind === "item" ? [row.entry] : [])))
  const isActive = (id: string) => (navActive() ? itemRows()[cursor()]?.id === id : hovered() === id)
  const isPendingDelete = (id: string) => pendingDelete() === id
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

  const sessionStatus = (id: string): "running" | "waiting" | "idle" => {
    try {
      const permissions = props.api.state.session.permission(id)
      const questions = props.api.state.session.question(id)
      if ((permissions?.length ?? 0) > 0 || (questions?.length ?? 0) > 0) return "waiting"
      const status = props.api.state.session.status(id)
      if (status?.type === "busy" || status?.type === "retry") return "running"
    } catch {}
    return "idle"
  }

  const statusColor = (id: string) => {
    const status = sessionStatus(id)
    if (status === "running") return theme().success
    if (status === "waiting") return theme().warning
    return theme().textMuted
  }

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
      if (currentID() === entry.id) props.api.route.navigate("home")
    } catch {
      props.api.ui.toast({ message: "Could not delete session", variant: "error" })
    } finally {
      setDeleting(undefined)
    }
  }

  let disposeHoverSpace: (() => void) | undefined
  let disposeSearch: (() => void) | undefined
  let disposeNav: (() => void) | undefined
  let insideSearchBox = false

  const onRootMouseDown = () => {
    if (insideSearchBox) {
      insideSearchBox = false
      return
    }
    if (searching()) setSearching(false)
  }

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
          key: "ctrl+p",
          desc: "Preview session transcript",
          preventDefault: true,
          cmd: () => openSidebarPreview(entry),
        },
        {
          key: "ctrl+x",
          desc: "Delete session",
          preventDefault: true,
          cmd: () => {
            if (!confirmArmed()) requestDelete(entry)
          },
        },
        { key: "option+s", desc: "Pin session", preventDefault: true, cmd: () => props.onTogglePin("sessions", entry.id) },
        { key: "option+d", desc: "Pin directory", preventDefault: true, cmd: () => props.onTogglePin("directories", entry.dir) },
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
        key: "ctrl+p",
        desc: "Preview session transcript",
        preventDefault: true,
        cmd: () => {
          const entry = itemRows()[cursor()]
          if (entry) openSidebarPreview(entry)
        },
      },
      {
        key: "ctrl+x",
        desc: "Delete session",
        preventDefault: true,
        cmd: () => {
          if (confirmArmed()) return
          const entry = itemRows()[cursor()]
          if (entry) requestDelete(entry)
        },
      },
      {
        key: "option+s",
        desc: "Pin session",
        preventDefault: true,
        cmd: () => {
          const entry = itemRows()[cursor()]
          if (entry) props.onTogglePin("sessions", entry.id)
        },
      },
      {
        key: "option+d",
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
    if (confirmTimer) clearTimeout(confirmTimer)
  })

  return (
    <box flexDirection="column" paddingRight={1} flexGrow={1} flexShrink={1}>
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <text flexShrink={1} onMouseDown={() => {
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
        <text flexShrink={0} style={{ fg: theme().textMuted }} onMouseDown={toggleSection}>
          {sectionCollapsed() ? "▸ show" : "▾ hide"}
        </text>
      </box>
      <Show when={!sectionCollapsed()}>
      <Show
        when={entries().length > 0}
        fallback={
          <text style={{ fg: theme().textMuted }}>
            {loadFailed() ? "Session list unavailable · will retry" : "No sessions yet · ctrl+o to browse"}
          </text>
        }
      >
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
            <text flexShrink={0} style={{ fg: theme().textMuted }} onMouseDown={() => setQuery("")}>
              ✕
            </text>
          </Show>
        </box>
        <scrollbox
          flexGrow={1}
          flexShrink={1}
          verticalScrollbarOptions={{ visible: false }}
          horizontalScrollbarOptions={{ visible: false }}
        >
          <For each={tree()}>
          {(row) =>
            row.kind === "group" ? (
              <box flexDirection="row" paddingTop={1} onMouseDown={() => toggleGroup(row.dir)}>
                <text flexGrow={1} flexShrink={1} wrapMode="none">
                  <span style={{ fg: theme().textMuted }}>{collapsed()[row.dir] ? "▸ " : "▾ "}</span>
                  <b>{props.pins().directories.includes(row.dir) ? "★ " : ""}{truncate(row.label, SIDEBAR_GROUP_WIDTH - (props.pins().directories.includes(row.dir) ? 2 : 0))}</b>
                </text>
                <text flexShrink={0} style={{ fg: theme().textMuted }}>
                  {" "}({row.count})
                </text>
              </box>
            ) : (
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
                  // active. Keep its cursor on the hovered row so Option-S/Option-D
                  // cannot silently pin a different (often current) session.
                  if (navActive()) {
                    const index = itemRows().findIndex((entry) => entry.id === row.entry.id)
                    if (index >= 0) setCursor(index)
                  }
                }}
                onMouseOut={() => setHovered(undefined)}
                onMouseDown={() => void openSession(row.entry)}
              >
                <text flexShrink={0}>
                  <span style={{ fg: theme().textMuted }}>{row.last ? "└" : "├"}</span>
                  <span
                    style={{
                      fg: isPendingDelete(row.entry.id)
                        ? theme().error
                        : row.entry.id === currentID()
                          ? theme().accent
                          : statusColor(row.entry.id),
                    }}
                  >
                    {row.entry.id === currentID() ? "●" : isActive(row.entry.id) ? "▸" : "○"}
                  </span>
                </text>
                <Highlighted
                  text={`${props.pins().sessions.includes(row.entry.id) ? "★ " : ""}${truncate(row.entry.title, SIDEBAR_TITLE_WIDTH - (props.pins().sessions.includes(row.entry.id) ? 2 : 0))}`}
                  query={query()}
                  color={isPendingDelete(row.entry.id) ? theme().error : theme().text}
                  matchColor={theme().warning}
                />
                <text flexShrink={0} style={{ fg: isPendingDelete(row.entry.id) ? theme().error : theme().textMuted }}>
                  {isPendingDelete(row.entry.id) ? (
                    "ctrl+x again"
                  ) : waiting().has(row.entry.id) ? (
                    <span>
                      {ago(row.entry.updated)} · <span style={{ fg: theme().warning }}>{waitingReason(row.entry.id)}</span>
                    </span>
                  ) : (
                    ago(row.entry.updated)
                  )}
                </text>
              </box>
            )
          }
        </For>
        </scrollbox>
        <Show when={remaining() > 0}>
          <text style={{ fg: theme().textMuted }}>{`… ${remaining()} more · ctrl+o for all`}</text>
        </Show>
        <Show when={query().trim() && filteredEntries().length === 0}>
          <text style={{ fg: theme().textMuted }}>No title or directory matches · ctrl+o to search transcripts</text>
        </Show>
        <Show when={navActive()}>
          <box paddingTop={1}>
            <text style={{ fg: theme().textMuted }}>↑↓ move · enter open · ctrl+p preview · option+s/d pin · ctrl+x delete · esc done</text>
          </box>
        </Show>
      </Show>
      </Show>
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
  const preview = createTranscriptPreview(props.api)
  let disposeHoverSpace: (() => void) | undefined
  let disposeSearch: (() => void) | undefined
  let insideSearchBox = false

  const onRootMouseDown = () => {
    if (insideSearchBox) {
      insideSearchBox = false
      return
    }
    if (searching()) setSearching(false)
  }

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
          key: "ctrl+p",
          desc: "Preview session transcript",
          preventDefault: true,
          cmd: () => preview.open(entry),
        },
        { key: "option+s", desc: "Pin session", preventDefault: true, cmd: () => props.onTogglePin("sessions", entry.id) },
        { key: "option+d", desc: "Pin directory", preventDefault: true, cmd: () => props.onTogglePin("directories", entry.dir) },
      ],
    })
  })

  onCleanup(() => disposeSearch?.())
  onCleanup(() => disposeHoverSpace?.())

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
    <box flexDirection="column" width="100%" maxWidth={72} paddingLeft={1} paddingRight={1} paddingTop={1} gap={1}>
      <Show
        when={entries().length > 0}
        fallback={
          <box flexDirection="row" gap={1}>
            <text style={{ fg: theme().textMuted }}>Recent sessions</text>
            <text style={{ fg: theme().textMuted }}>
              {loadFailed() ? "· list unavailable, will retry" : "· none yet, ctrl+o to browse"}
            </text>
          </box>
        }
      >
        <box flexDirection="row" justifyContent="space-between" gap={2}>
          <box flexDirection="row" gap={1}>
            <text style={{ fg: theme().textMuted }}>Recent sessions</text>
            <text style={{ fg: theme().textMuted }}>· ctrl+o for all</text>
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
              onMouseDown={() => props.api.route.navigate("session", { sessionID: entry.id })}
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
              <text flexShrink={0} style={{ fg: theme().textMuted }}>
                {props.pins().directories.includes(entry.dir) ? "★ " : ""}{prettyDir(entry.dir, home)} · {ago(entry.updated)}
              </text>
            </box>
          )}
        </For>
        <Show when={visible().length === 0}>
          <text style={{ fg: theme().textMuted }}>No title or directory matches · ctrl+o to search transcripts</text>
        </Show>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  const [pins, setPins] = createSignal<Pins>(emptyPins())
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

  const openPicker = async () => {
    refreshPins()
    if (api.mode.current() !== BASE_MODE) return
    if (api.renderer.currentFocusedEditor === null) return

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
    const [query, setQuery] = createSignal("")
    const [cursor, setCursor] = createSignal(0)
    const [scope, setScope] = createSignal<string>()
    const [pendingDelete, setPendingDelete] = createSignal<Entry>()
    const [searchIndex, setSearchIndex] = createSignal<Map<string, string>>(new Map())
    const [indexProgress, setIndexProgress] = createSignal<IndexProgress>({
      indexed: 0,
      total: 0,
      complete: false,
    })
    void buildSearchIndex(api, entries, (progress, index) => {
      setIndexProgress(progress)
      // Publish a fresh snapshot: the indexing workers mutate their own map,
      // while Solid needs a new reference to update search results mid-scan.
      setSearchIndex(new Map(index))
    })
    type DialogRow = { kind: "group"; label: string; count: number } | { kind: "item"; entry: Entry }

    const orderedEntries = createMemo(() => pinnedFirst(allEntries(), pins()))
    const matchedGroups = createMemo(() => {
      const q = query().trim().toLowerCase()
      const index = searchIndex()
      const group = scope()
      const matched = orderedEntries().filter((entry) => {
        if (group && entry.group !== group) return false
        if (!q) return true
        const haystack = index.get(entry.id) ?? `${entry.title} ${entry.dir}`.toLowerCase()
        return haystack.includes(q)
      })
      const byGroup = new Map<string, Entry[]>()
      for (const entry of matched) {
        const list = byGroup.get(entry.group) ?? []
        list.push(entry)
        byGroup.set(entry.group, list)
      }
      const groups = [...byGroup.entries()].map(([name, list]) => ({ name, list }))
      const currentPins = pins()
      const rank = (group: (typeof groups)[number]) =>
        group.list.some((entry) => currentPins.directories.includes(entry.dir)) ? 2
          : group.list.some((entry) => currentPins.sessions.includes(entry.id)) ? 1 : 0
      return groups.sort((a, b) =>
        rank(b) - rank(a) || Math.max(...b.list.map((entry) => entry.updated)) - Math.max(...a.list.map((entry) => entry.updated)),
      )
    })

    const selectableEntries = createMemo(() => matchedGroups().flatMap((g) => g.list))

    // Visible bounding: say how much transcript text search actually covers and
    // when the metadata walk hit its cap, instead of silently under-reporting.
    const coverageLabel = createMemo(() => {
      const progress = indexProgress()
      const bits: string[] = []
      if (scope()) bits.push(`scope ${scope()}`)
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

    let previousSelection: Entry[] = []
    createEffect(() => {
      const rows = selectableEntries()
      const selected = previousSelection[cursor()]?.id
      const position = rows.findIndex((entry) => entry.id === selected)
      if (position >= 0 && position !== cursor()) setCursor(position)
      else if (cursor() >= rows.length) setCursor(Math.max(0, rows.length - 1))
      previousSelection = rows
    })

    const pickerRows = createMemo<DialogRow[]>(() => {
      const flat: DialogRow[] = []
      for (const group of matchedGroups()) {
        flat.push({ kind: "group", label: group.name, count: group.list.length })
        for (const entry of group.list) flat.push({ kind: "item", entry })
      }
      return flat
    })

    const termHeight = api.renderer.height
    const listHeight = Math.max(6, Math.floor(termHeight / 2) - 12)

    const visiblePickerRows = createMemo<DialogRow[]>(() => {
      const flat = pickerRows()
      const windowSize = listHeight
      const currentID = selectableEntries()[cursor()]?.id
      let pos = currentID
        ? flat.findIndex((row) => row.kind === "item" && row.entry.id === currentID)
        : 0
      if (pos < 0) pos = 0
      let start = Math.max(0, pos - Math.floor(windowSize / 2))
      start = Math.min(start, Math.max(0, flat.length - windowSize))
      return flat.slice(start, start + windowSize)
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

    const moveCursor = (delta: number) => {
      const count = selectableEntries().length
      if (count === 0) return
      cancelDelete()
      setCursor((value) => Math.max(0, Math.min(count - 1, value + delta)))
    }

    // Delete confirmation lives in its own layer, registered only while a row
    // is armed, so y/n never shadow the search box's typing.
    let disposeConfirm: (() => void) | undefined
    const cancelDelete = () => {
      disposeConfirm?.()
      disposeConfirm = undefined
      setPendingDelete(undefined)
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
        setAllEntries(remaining)
        api.ui.toast({ message: `Deleted "${truncate(entry.title, 40)}"`, variant: "info" })
      } catch {
        api.ui.toast({ message: "Could not delete session", variant: "error" })
      }
    }

    const armDelete = (entry: Entry) => {
      setPendingDelete(entry)
      disposeConfirm?.()
      disposeConfirm = api.keymap.registerLayer({
        bindings: [
          {
            key: "y",
            desc: "Confirm delete",
            preventDefault: true,
            cmd: () => {
              const armed = pendingDelete()
              if (armed) void deleteEntry(armed)
            },
          },
          { key: "n", desc: "Cancel delete", preventDefault: true, cmd: cancelDelete },
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
      bindings: [
        { key: "up", desc: "Previous session", preventDefault: true, cmd: () => moveCursor(-1) },
        { key: "down", desc: "Next session", preventDefault: true, cmd: () => moveCursor(1) },
        { key: "pageup", desc: "Page up", preventDefault: true, cmd: () => moveCursor(-10) },
        { key: "pagedown", desc: "Page down", preventDefault: true, cmd: () => moveCursor(10) },
        { key: "home", desc: "First session", preventDefault: true, cmd: () => setCursor(0) },
        {
          key: "end",
          desc: "Last session",
          preventDefault: true,
          cmd: () => setCursor(selectableEntries().length - 1),
        },
        { key: "enter", desc: "Open session", preventDefault: true, cmd: () => choose() },
        { key: "ctrl+p", desc: "Toggle transcript preview", preventDefault: true, cmd: togglePreview },
        { key: "option+s", desc: "Pin session", preventDefault: true, cmd: () => {
          const entry = selectableEntries()[cursor()]
          if (entry) onTogglePin("sessions", entry.id)
        } },
        { key: "option+d", desc: "Pin directory", preventDefault: true, cmd: () => {
          const entry = selectableEntries()[cursor()]
          if (entry) onTogglePin("directories", entry.dir)
        } },
        {
          key: "ctrl+x",
          desc: "Delete session",
          preventDefault: true,
          cmd: () => {
            const target = selectableEntries()[cursor()]
            if (!target) return
            const armed = pendingDelete()
            if (armed && armed.id === target.id) void deleteEntry(target)
            else armDelete(target)
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
        {
          key: "escape",
          desc: "Close",
          preventDefault: true,
          cmd: () => {
            cancelDelete()
            close()
          },
        },
      ],
    })

    const cleanup = () => {
      disposeNav()
      disposeConfirm?.()
      disposeConfirm = undefined
      if (previewTimer) clearTimeout(previewTimer)
    }

    api.ui.dialog.replace(
      () => (
        <box flexDirection="column" flexGrow={1} paddingBottom={1} gap={1}>
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
                onInput={setQuery}
                onSubmit={() => choose()}
                onKeyDown={(event) => {
                  if (event.name === "escape") {
                    event.preventDefault()
                    close()
                  }
                }}
              />
            </box>
            <Show when={coverageLabel()}>
              <box paddingTop={1}>
                <text style={{ fg: api.theme.current.textMuted }}>{coverageLabel()}</text>
              </box>
            </Show>
          </box>
          <box
            flexDirection="column"
            onMouseScroll={(event: { scroll?: { direction: string } }) => {
              const direction = event.scroll?.direction
              if (direction === "down") moveCursor(3)
              else if (direction === "up") moveCursor(-3)
            }}
          >
            <For each={visiblePickerRows()}>
                {(row) =>
                  row.kind === "group" ? (
                    <box paddingTop={1} paddingLeft={4}>
                      <text style={{ fg: api.theme.current.accent }} attributes={TextAttributes.BOLD}>
                        {matchedGroups().find((group) => group.name === row.label)?.list.some((entry) => pins().directories.includes(entry.dir)) ? "★ " : ""}{row.label} <span style={{ fg: api.theme.current.textMuted }}>({row.count})</span>
                      </text>
                    </box>
                  ) : (
                    <box
                      flexDirection="row"
                      gap={1}
                      paddingLeft={4}
                      paddingRight={4}
                      backgroundColor={
                        row.entry.id === selectableEntries()[cursor()]?.id
                          ? api.theme.current.primary
                          : RGBA.fromInts(0, 0, 0, 0)
                      }
                      onMouseDown={() => choose(row.entry)}
                    >
                      <Show when={row.entry.id === currentSessionID()}>
                        <text
                          flexShrink={0}
                          style={{
                            fg:
                              row.entry.id === selectableEntries()[cursor()]?.id
                                ? api.theme.current.selectedListItemText
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
                            ? api.theme.current.selectedListItemText
                            : api.theme.current.text
                        }
                        matchColor={
                          row.entry.id === selectableEntries()[cursor()]?.id
                            ? api.theme.current.selectedListItemText
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
                                ? api.theme.current.selectedListItemText
                                : api.theme.current.textMuted,
                        }}
                      >
                        {pendingDelete()?.id === row.entry.id
                          ? "press y to delete"
                          : `${prettyDir(row.entry.dir, process.env.HOME ?? "")} · ${ago(row.entry.updated)}${
                              query().trim() &&
                              !`${row.entry.title} ${row.entry.dir}`.toLowerCase().includes(query().trim().toLowerCase())
                                ? " · transcript match"
                                : ""
                            }`}
                      </text>
                    </box>
                  )
                }
              </For>
              <Show when={selectableEntries().length === 0}>
                <box paddingLeft={4} paddingRight={4}>
                  <text style={{ fg: api.theme.current.textMuted }}>
                    {!indexProgress().complete
                      ? "No matches yet · still searching transcripts…"
                      : scope()
                        ? `No matches in ${scope()} · ctrl+g for all projects`
                        : "No sessions match · try another search"}
                  </text>
                </box>
              </Show>
            </box>
          <Show when={showPreview()}>
            <box flexShrink={0} flexDirection="column" paddingLeft={4} paddingRight={4} height={12}>
              <text style={{ fg: api.theme.current.textMuted }} attributes={TextAttributes.BOLD}>
                {previewID() ? `Preview · ${truncate(selectableEntries()[cursor()]!.title, 48)}` : "Preview"}
              </text>
              <scrollbox flexGrow={1} scrollbarOptions={{ visible: false }}>
                <Show when={previewID()} fallback={<text style={{ fg: api.theme.current.textMuted }}>Select a session to preview</text>}>
                  <Show when={previewText()} fallback={<text style={{ fg: api.theme.current.textMuted }}>Loading…</text>}>
                    {(text) =>
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
            </box>
          </Show>
          <box paddingLeft={4} paddingRight={4} flexShrink={0}>
            <text
              style={{
                fg: pendingDelete() ? api.theme.current.warning : api.theme.current.textMuted,
              }}
            >
              {pendingDelete()
                ? `Delete "${truncate(pendingDelete()!.title, 40)}"? y confirm · n cancel`
                : "↑↓ navigate · enter open · option+s/d pin · ctrl+x delete · ctrl+f fork · ctrl+g project · ctrl+p preview · esc close"}
            </text>
          </box>
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
  const openCosts = async () => {
    if (api.mode.current() !== BASE_MODE) return
    if (api.renderer.currentFocusedEditor === null) return
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
FROM message m
JOIN session s ON s.id = m.session_id
WHERE json_extract(m.data, '$.role') = 'assistant'
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
      bindings: [
        { key: "escape", desc: "Close", preventDefault: true, cmd: () => api.ui.dialog.clear() },
      ],
    })
    api.ui.dialog.replace(
      () => (
        <box flexDirection="column" paddingLeft={4} paddingRight={4} paddingTop={1} gap={1}>
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
  const openNeeds = async () => {
    if (api.mode.current() !== BASE_MODE) return
    if (api.renderer.currentFocusedEditor === null) return
    let items: { entry: Entry; reason: string }[] = []
    try {
      const { entries } = await fetchEntries(api)
      const db = await openTranscriptDb()
      let waiting = new Map<string, string>()
      if (db) {
        try {
          waiting = await queryWaitingIds(db)
        } finally {
          db.close()
        }
      }
      items = entries
        .filter((entry) => waiting.has(entry.id))
        .map((entry) => ({
          entry,
          reason: waiting.get(entry.id) === "question" ? "awaiting answer" : "run stuck",
        }))
    } catch {
      api.ui.toast({ message: "Could not load sessions", variant: "error" })
      return
    }
    if (items.length === 0) {
      api.ui.toast({ message: "No sessions are waiting on you.", variant: "info" })
      return
    }
    const [cursor, setCursor] = createSignal(0)
    const moveCursor = (delta: number) =>
      setCursor((value) => Math.max(0, Math.min(items.length - 1, value + delta)))
    const choose = () => {
      const target = items[cursor()]
      if (!target) return
      disposeNav()
      api.ui.dialog.clear()
      api.route.navigate("session", { sessionID: target.entry.id })
    }
    const disposeNav = api.keymap.registerLayer({
      bindings: [
        { key: "up", desc: "Previous session", preventDefault: true, cmd: () => moveCursor(-1) },
        { key: "down", desc: "Next session", preventDefault: true, cmd: () => moveCursor(1) },
        { key: "enter", desc: "Open session", preventDefault: true, cmd: () => choose() },
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
        <box flexDirection="column" paddingLeft={4} paddingRight={4} paddingTop={1} gap={1}>
          <text attributes={TextAttributes.BOLD}>
            Needs input{" "}
            <span style={{ fg: api.theme.current.textMuted }}>({items.length})</span>
          </text>
          <box flexDirection="column">
            <For each={items}>
              {(item, index) => (
                <box
                  flexDirection="row"
                  gap={2}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={
                    index() === cursor()
                      ? api.theme.current.primary
                      : RGBA.fromInts(0, 0, 0, 0)
                  }
                  onMouseDown={() => {
                    setCursor(index())
                    choose()
                  }}
                >
                  <text
                    flexGrow={1}
                    flexShrink={1}
                    wrapMode="none"
                    style={{
                      fg:
                        index() === cursor()
                          ? api.theme.current.selectedListItemText
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
                          ? api.theme.current.selectedListItemText
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
                          ? api.theme.current.selectedListItemText
                          : api.theme.current.textMuted,
                    }}
                  >
                    {prettyDir(item.entry.dir, home)} · {ago(item.entry.updated)}
                  </text>
                </box>
              )}
            </For>
          </box>
          <box flexShrink={0}>
            <text style={{ fg: api.theme.current.textMuted }}>↑↓ navigate · enter open · esc close</text>
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
        void openPicker()
      },
    },
    {
      title: "Cost digest (per project)",
      value: "sesh.costs",
      description: "Spend per project, last day and lifetime",
      category: "Sessions",
      slash: { name: "sesh-costs" },
      onSelect: () => {
        void openCosts()
      },
    },
    {
      title: "Sessions waiting on you",
      value: "sesh.needs",
      description: "Unanswered questions and stuck runs",
      category: "Sessions",
      slash: { name: "sesh-needs" },
      onSelect: () => {
        void openNeeds()
      },
    },
  ])

  api.keymap.registerLayer({
    bindings: [{ key: "ctrl+o", desc: "Pick session", preventDefault: true, cmd: () => void openPicker() }],
  })
}

export default { id: "sesh-panel", tui }
