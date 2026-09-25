/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Project, Session } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
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
type SidebarMarker = "current" | "running" | "idle"

// Loading-spinner frames for the marker of a session whose agent is working.
const SIDEBAR_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function newestFirst(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id))
}

// A working agent is the only state the marker displays: everything that
// finished goes back to the neutral row, with the open session marked inside.
function sidebarMarker(current: boolean, live?: string): SidebarMarker {
  if (live === "busy" || live === "retry") return "running"
  return current ? "current" : "idle"
}

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
    const rows = (db.query(`
 SELECT p.session_id AS id,
   MIN(CASE WHEN json_extract(p.data, '$.tool') = 'question'
      AND COALESCE(json_extract(p.data, '$.state.status'), 'pending') != 'completed'
      AND NOT EXISTS (SELECT 1 FROM message m WHERE m.session_id = p.session_id
        AND json_extract(m.data, '$.role') = 'user' AND m.time_created > p.time_created)
     THEN p.time_created END) AS question_since,
   MIN(CASE WHEN json_extract(p.data, '$.state.status') = 'running'
      AND p.time_created < ${cutoff} THEN p.time_created END) AS stuck_since
 FROM part p
 WHERE p.session_id IN (${batch.map(() => "?").join(",")})
   AND json_extract(p.data, '$.type') = 'tool'
 GROUP BY p.session_id`).all(...batch) ?? []) as { id: string; question_since: number | null; stuck_since: number | null }[]
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
    }
    setSectionCollapsed((value) => !value)
  }

  const openSession = (entry: Entry) => props.api.route.navigate("session", { sessionID: entry.id })

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

  // Marker only: a spinner for a working agent, the open-session dot, and the
  // neutral row for idle sessions. Titles stay plain and no status text is
  // rendered.
  const markerOf = (id: string): SidebarMarker => {
    let live: string | undefined
    try {
      live = props.api.state.session.status(id)?.type
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
          key: "ctrl+x",
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
          key: "option+p",
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
        { key: "ctrl+s", desc: "Pin session", preventDefault: true, cmd: () => props.onTogglePin("sessions", entry.id) },
        { key: "ctrl+d", desc: "Pin directory", preventDefault: true, cmd: () => props.onTogglePin("directories", entry.dir) },
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
        key: "option+p",
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
        key: "ctrl+s",
        desc: "Pin session",
        preventDefault: true,
        cmd: () => {
          const entry = itemRows()[cursor()]
          if (entry) props.onTogglePin("sessions", entry.id)
        },
      },
      {
        key: "ctrl+d",
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
          {(row) => {
            if (row.kind === "group") return (
              <box flexDirection="row" paddingTop={1} onMouseDown={() => toggleGroup(row.dir)}>
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
                onMouseDown={() => void openSession(row.entry)}
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
                  {isPendingDelete(row.entry.id) ? "ctrl+x again" : ago(row.entry.updated)}
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
            <text style={{ fg: theme().textMuted }}>↑↓ move · enter open · option+p preview · ctrl+s/d pin · ctrl+x delete · esc done</text>
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
        { key: "ctrl+x", desc: "Confirm delete", preventDefault: true, cmd: () => { confirmArmed() } },
        { key: "enter", desc: "Confirm delete", preventDefault: true, cmd: () => { confirmArmed() } },
        { key: "n", desc: "Cancel delete", preventDefault: true, cmd: cancelDelete },
        { key: "escape", desc: "Cancel delete", preventDefault: true, cmd: cancelDelete },
      ],
    })
  })

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
          key: "option+p",
          desc: "Preview session transcript",
          preventDefault: true,
          cmd: () => preview.open(entry),
        },
        {
          key: "ctrl+x",
          desc: "Delete session",
          preventDefault: true,
          cmd: () => {
            if (!confirmArmed()) requestDelete(entry)
          },
        },
        { key: "ctrl+s", desc: "Pin session", preventDefault: true, cmd: () => props.onTogglePin("sessions", entry.id) },
        { key: "ctrl+d", desc: "Pin directory", preventDefault: true, cmd: () => props.onTogglePin("directories", entry.dir) },
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
              <text flexShrink={0} style={{ fg: pendingDelete() === entry.id ? theme().error : theme().textMuted }}>
                {pendingDelete() === entry.id
                  ? "ctrl+x again"
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
    const CHROME_ROWS = 12
    const listHeight = () => Math.max(6, Math.floor(termHeight * 0.75) - CHROME_ROWS)
    const dialogHeight = () => listHeight() + CHROME_ROWS
    const dialogOffset = () => Math.min(0, Math.floor(termHeight / 4 - dialogHeight() / 2 - 1))
    const hasExcerpt = (entry: Entry) => !!transcriptMatchExcerpt(searchIndex().get(entry.id), entry, query())
    const maxViewportStart = createMemo(() => pickerLastStart(pickerRows(), listHeight(), hasExcerpt))
    const visiblePickerRows = createMemo(() => pickerWindow(
      pickerRows(), Math.min(viewportStart(), maxViewportStart()), listHeight(), hasExcerpt,
    ))

    let previousSelection: Entry[] = []
    createEffect(() => {
      const rows = selectableEntries()
      const position = rows.findIndex((entry) => entry.id === previousSelection[cursor()]?.id)
      if (rows !== previousSelection && (rows.length !== previousSelection.length ||
        rows.some((entry, index) => entry.id !== previousSelection[index]?.id))) {
        // A search/filter/collapse changed the tree: reveal the retained row or
        // start at the first result rather than leaving a stale window open.
        const next = position >= 0 ? position : 0
        setCursor(next)
        const id = rows[next]?.id
        setViewportStart(position < 0 || next === 0 ? 0 : Math.max(0, pickerRows().findIndex(
          (row) => row.kind === "item" && row.entry.id === id,
        )))
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
            key: "ctrl+x",
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
      // Outrank the built-in dialog layer so Escape reaches this picker before
      // the dialog host closes the whole thing.
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
        { key: "option+p", desc: "Toggle transcript preview", preventDefault: true, cmd: togglePreview },
        { key: "ctrl+s", desc: "Pin session", preventDefault: true, cmd: () => {
          const entry = selectableEntries()[cursor()]
          if (entry) onTogglePin("sessions", entry.id)
        } },
        { key: "ctrl+d", desc: "Pin directory", preventDefault: true, cmd: () => {
          const entry = selectableEntries()[cursor()]
          if (entry) onTogglePin("directories", entry.dir)
        } },
        {
          key: "ctrl+x",
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
        { key: "option+w", desc: "Filter needs input", preventDefault: true, cmd: () => setWaitingOnly((value) => !value) },
        { key: "option+s", desc: "Filter pinned sessions", preventDefault: true, cmd: () => setPinnedOnly((value) => !value) },
        {
          key: "escape",
          desc: "Close",
          preventDefault: true,
          cmd: handleEscape,
        },
      ],
    })

    const cleanup = () => {
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
                  if (pendingDelete()) {
                    if (event.name === "y" || (event.ctrl && event.name === "x") || event.name === "enter" || event.name === "return") {
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
                          ? api.theme.current.primary
                          : RGBA.fromInts(0, 0, 0, 0)
                      }
                      onMouseMove={() => {
                        // Repainting under a stationary pointer must not select
                        // another row while the wheel is moving the viewport.
                        const index = selectableEntries().findIndex((entry) => entry.id === row.entry.id)
                        if (index >= 0) setCursor(index)
                      }}
                      onMouseDown={() => choose(row.entry)}
                    >
                      <box flexDirection="row" gap={1}>
                      <text flexShrink={0} style={{ fg: row.entry.id === selectableEntries()[cursor()]?.id
                        ? api.theme.current.selectedListItemText : api.theme.current.textMuted }}>
                        {row.last ? "└" : "├"}
                      </text>
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
                          : `${ago(row.entry.updated)}${
                              query().trim() &&
                              !`${row.entry.title} ${row.entry.dir}`.toLowerCase().includes(query().trim().toLowerCase())
                                ? " · transcript match"
                                : ""
                            }`}
                      </text>
                      </box>
                      <Show when={excerpt()}>
                        {(match) => (
                          <box flexDirection="row" gap={1} paddingLeft={2}>
                            <text flexShrink={0} style={{ fg: api.theme.current.textMuted }}>↳</text>
                            <Highlighted
                              text={match()}
                              query={query()}
                              color={row.entry.id === selectableEntries()[cursor()]?.id ? api.theme.current.selectedListItemText : api.theme.current.textMuted}
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
              <text style={{ fg: api.theme.current.textMuted }}>ctrl+s/d pin · ctrl+x delete · ctrl+f fork · esc close</text>
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
              backgroundColor={api.theme.current.backgroundElement}
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
  let lastNeedsID: string | undefined
  const openNeeds = async () => {
    if (api.mode.current() !== BASE_MODE) return
    if (api.renderer.currentFocusedEditor === null) return
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
        <box flexDirection="column" paddingLeft={4} paddingRight={4} paddingTop={1} gap={1}>
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
                      ? api.theme.current.primary
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
    bindings: [{ key: "option+o", desc: "Pick session", preventDefault: true, cmd: () => void openPicker() }],
  })
}

export default { id: "sesh-panel", tui }
