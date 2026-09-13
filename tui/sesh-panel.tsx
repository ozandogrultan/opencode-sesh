/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Project, Session } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { readFile } from "node:fs/promises"
import { RGBA, SyntaxStyle, TextAttributes } from "@opentui/core"

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
    { scope: ["markup.heading"], style: { foreground: theme.markdownHeading, bold: true } },
    {
      scope: ["markup.heading.1"],
      style: { foreground: theme.markdownHeading, bold: true, underline: true },
    },
    {
      scope: ["markup.heading.2", "markup.heading.3", "markup.heading.4", "markup.heading.5", "markup.heading.6"],
      style: { foreground: theme.markdownHeading, bold: true },
    },
    { scope: ["markup.bold", "markup.strong"], style: { foreground: theme.markdownStrong, bold: true } },
    { scope: ["markup.italic"], style: { foreground: theme.markdownEmph, italic: true } },
    { scope: ["markup.list"], style: { foreground: theme.markdownListItem } },
    { scope: ["markup.quote"], style: { foreground: theme.markdownBlockQuote, italic: true } },
    { scope: ["markup.raw", "markup.raw.block"], style: { foreground: theme.markdownCode } },
    { scope: ["markup.raw.inline"], style: { foreground: theme.markdownCode, background: theme.background } },
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

const SEARCH_KEYS = "abcdefghijklmnopqrstuvwxyz0123456789-_.@/+".split("")

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
  onProgress?: (progress: IndexProgress) => void,
): Promise<Map<string, string>> {
  const index = new Map<string, string>()
  for (const entry of entries) {
    index.set(entry.id, `${entry.title.toLowerCase()} ${entry.dir.toLowerCase()}`)
  }
  const ids = entries.map((entry) => entry.id).filter((id) => SESSION_ID_PATTERN.test(id))
  const remaining = new Set(ids)
  const total = ids.length
  let indexed = 0
  const report = (complete: boolean) => onProgress?.({ indexed, total, complete })
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
      report(false)
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
    void fetchTranscriptText(api, entry.id).then(setPreviewText)
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
              <markdown content={previewText()} syntaxStyle={getMarkdownStyle(api.theme.current)!} />
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

function SidebarSessions(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const home = process.env.HOME ?? ""
  const [entries, setEntries] = createSignal<Entry[]>([])
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({})
  const [hovered, setHovered] = createSignal<string>()
  const preview = createTranscriptPreview(props.api)
  const [query, setQuery] = createSignal("")
  const [deleting, setDeleting] = createSignal<string>()
  const [searching, setSearching] = createSignal(false)
  const currentID = createMemo(() => {
    const route = props.api.route.current
    if (route.name !== "session") return undefined
    const params = route.params
    return params && typeof params.sessionID === "string" ? params.sessionID : undefined
  })

  onMount(() => {
    let alive = true
    const load = async () => {
      try {
        const { entries: all } = await fetchEntries(props.api)
        if (alive) setEntries(all)
      } catch {
        // leave the previous list in place rather than flashing to blank
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
    if (!q) return entries()
    return entries().filter(
      (entry) => entry.title.toLowerCase().includes(q) || entry.dir.toLowerCase().includes(q),
    )
  })

  const tree = createMemo<TreeRow[]>(() => {
    const groups = new Map<string, Entry[]>()
    for (const entry of filteredEntries()) {
      const list = groups.get(entry.dir) ?? []
      list.push(entry)
      groups.set(entry.dir, list)
    }
    const ordered = [...groups.entries()]
      .map(([dir, list]) => ({ dir, list, updated: Math.max(...list.map((entry) => entry.updated)) }))
      .sort((a, b) => b.updated - a.updated)
    const rows: TreeRow[] = []
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

  const deleteEntry = async (entry: Entry) => {
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
          key: "space",
          desc: "Preview session transcript",
          preventDefault: true,
          cmd: () => openSidebarPreview(entry),
        },
        {
          key: "ctrl+x",
          desc: "Delete session",
          preventDefault: true,
          cmd: () => void deleteEntry(entry),
        },
        {
          key: "/",
          desc: "Search sessions",
          preventDefault: true,
          cmd: () => setSearching(true),
        },
      ],
    })
  })

  onCleanup(() => {
    disposeHoverSpace?.()
    disposeSearch?.()
  })

  return (
    <box flexDirection="column" paddingRight={1}>
      <Show when={entries().length > 0}>
        <box flexDirection="row" gap={1}>
          <text>
            <b>Sessions</b>
            <span style={{ fg: theme().textMuted }}>
              {query().trim() ? ` (${filteredEntries().length}/${entries().length})` : ` (${entries().length})`}
            </span>
          </text>
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
          verticalScrollbarOptions={{ visible: false }}
          horizontalScrollbarOptions={{ visible: false }}
        >
          <For each={tree()}>
          {(row) =>
            row.kind === "group" ? (
              <box flexDirection="row" paddingTop={1} onMouseDown={() => toggleGroup(row.dir)}>
                <text flexGrow={1} flexShrink={1} wrapMode="none">
                  <span style={{ fg: theme().textMuted }}>{collapsed()[row.dir] ? "▸ " : "▾ "}</span>
                  <b>{truncate(row.label, SIDEBAR_GROUP_WIDTH)}</b>
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
                  row.entry.id === hovered() && row.entry.id !== currentID()
                    ? theme().backgroundElement
                    : RGBA.fromInts(0, 0, 0, 0)
                }
                onMouseOver={() => setHovered(row.entry.id)}
                onMouseOut={() => setHovered(undefined)}
                onMouseDown={() => props.api.route.navigate("session", { sessionID: row.entry.id })}
              >
                <text flexShrink={0}>
                  <span style={{ fg: theme().textMuted }}>{row.last ? "└" : "├"}</span>
                  <span
                    style={{ fg: row.entry.id === currentID() ? theme().accent : statusColor(row.entry.id) }}
                  >
                    {row.entry.id === currentID() ? "●" : "○"}
                  </span>
                </text>
                <text flexGrow={1} flexShrink={1} overflow="hidden" wrapMode="none" style={{ fg: theme().text }}>
                  {truncate(row.entry.title, SIDEBAR_TITLE_WIDTH)}
                </text>
                <text flexShrink={0} style={{ fg: theme().textMuted }}>
                  {ago(row.entry.updated)}
                </text>
              </box>
            )
          }
        </For>
        </scrollbox>
      </Show>
    </box>
  )
}

const HOME_SESSION_LIMIT = 6

function HomeSessions(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const home = process.env.HOME ?? ""
  const [entries, setEntries] = createSignal<Entry[]>([])
  const [query, setQuery] = createSignal("")
  const [hovered, setHovered] = createSignal<string>()
  const [searching, setSearching] = createSignal(false)
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
          key: "space",
          desc: "Preview session transcript",
          preventDefault: true,
          cmd: () => preview.open(entry),
        },
      ],
    })
  })

  onCleanup(() => disposeSearch?.())
  onCleanup(() => disposeHoverSpace?.())

  onMount(() => {
    let alive = true
    const load = async () => {
      try {
        const { entries: all } = await fetchEntries(props.api)
        if (alive) setEntries(all)
      } catch {}
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
    return list.slice(0, HOME_SESSION_LIMIT)
  })

  return (
    <box flexDirection="column" width="100%" maxWidth={72} paddingLeft={1} paddingRight={1} paddingTop={1} gap={1}>
      <Show when={entries().length > 0}>
        <box flexDirection="row" justifyContent="space-between" gap={2}>
          <text style={{ fg: theme().textMuted }}>Recent sessions</text>
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
              <text flexGrow={1} flexShrink={1} overflow="hidden" wrapMode="none" style={{ fg: theme().text }}>
                {truncate(entry.title, HOME_TITLE_WIDTH)}
              </text>
              <text flexShrink={0} style={{ fg: theme().textMuted }}>
                {prettyDir(entry.dir, home)} · {ago(entry.updated)}
              </text>
            </box>
          )}
        </For>
        <Show when={visible().length === 0}>
          <text style={{ fg: theme().textMuted }}>No matching sessions</text>
        </Show>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content() {
        return <SidebarSessions api={api} />
      },
      home_bottom() {
        return <HomeSessions api={api} />
      },
    },
  })

  const openPicker = async () => {
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

    const [previewText, setPreviewText] = createSignal("")
    const [showPreview, setShowPreview] = createSignal(false)
    const [query, setQuery] = createSignal("")
    const [cursor, setCursor] = createSignal(0)
    const [searchIndex, setSearchIndex] = createSignal<Map<string, string>>(new Map())
    const [indexProgress, setIndexProgress] = createSignal<IndexProgress>({
      indexed: 0,
      total: 0,
      complete: false,
    })
    void buildSearchIndex(api, entries, setIndexProgress).then(setSearchIndex)
    let pickerInput: { value: string; isDestroyed?: boolean } | undefined

    type DialogRow = { kind: "group"; label: string; count: number } | { kind: "item"; entry: Entry }

    const matchedGroups = createMemo(() => {
      const q = query().trim().toLowerCase()
      const index = searchIndex()
      const matched = entries.filter((entry) => {
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
      return [...byGroup.entries()].map(([name, list]) => ({ name, list }))
    })

    const selectableEntries = createMemo(() => matchedGroups().flatMap((g) => g.list))

    // Visible bounding: say how much transcript text search actually covers and
    // when the metadata walk hit its cap, instead of silently under-reporting.
    const coverageLabel = createMemo(() => {
      const progress = indexProgress()
      const bits: string[] = []
      if (progress.total > 0) {
        bits.push(
          progress.complete
            ? `transcripts ${progress.total}`
            : `indexing transcripts ${progress.indexed}/${progress.total}`,
        )
      }
      if (entriesResult.truncated) bits.push(`showing newest ${entries.length}`)
      return bits.join(" · ")
    })

    createEffect(() => {
      const count = selectableEntries().length
      if (cursor() >= count) setCursor(Math.max(0, count - 1))
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
      // Keep the previous transcript visible while the next one loads so the
      // preview does not blink away on every cursor move.
      previewTimer = setTimeout(() => void loadPreview(id), 120)
    })

    const togglePreview = () => setShowPreview((value) => !value)

    const moveCursor = (delta: number) => {
      const count = selectableEntries().length
      if (count === 0) return
      setCursor((value) => Math.max(0, Math.min(count - 1, value + delta)))
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
        {
          key: "escape",
          desc: "Close",
          preventDefault: true,
          cmd: () => {
            cleanup()
            api.ui.dialog.clear()
          },
        },
        {
          key: "ctrl+g",
          desc: "Close",
          preventDefault: true,
          cmd: () => {
            cleanup()
            api.ui.dialog.clear()
          },
        },
      ],
    })

    const cleanup = () => {
      disposeNav()
      if (previewTimer) clearTimeout(previewTimer)
    }

    const onSearchInput = (value: string) => {
      if (query() === "" && value.trim() === "" && value.length > 0) {
        if (pickerInput && !pickerInput.isDestroyed) pickerInput.value = ""
        setQuery("")
        togglePreview()
        return
      }
      setQuery(value)
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
                ref={(r) => (pickerInput = r)}
                focused
                placeholder="Search title, directory, transcript…"
                value={query()}
                placeholderColor={api.theme.current.textMuted}
                focusedBackgroundColor={api.theme.current.backgroundPanel}
                focusedTextColor={api.theme.current.text}
                cursorColor={api.theme.current.primary}
                onInput={onSearchInput}
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
                        {row.label} <span style={{ fg: api.theme.current.textMuted }}>({row.count})</span>
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
                      <text
                        flexGrow={1}
                        flexShrink={1}
                        overflow="hidden"
                        wrapMode="none"
                        attributes={
                          row.entry.id === selectableEntries()[cursor()]?.id ? TextAttributes.BOLD : undefined
                        }
                        style={{
                          fg:
                            row.entry.id === selectableEntries()[cursor()]?.id
                              ? api.theme.current.selectedListItemText
                              : api.theme.current.text,
                        }}
                      >
                        {truncate(row.entry.title, 61)}
                      </text>
                      <text
                        flexShrink={0}
                        style={{
                          fg:
                            row.entry.id === selectableEntries()[cursor()]?.id
                              ? api.theme.current.selectedListItemText
                              : api.theme.current.textMuted,
                        }}
                      >
                        {prettyDir(row.entry.dir, process.env.HOME ?? "")} · {ago(row.entry.updated)}
                      </text>
                    </box>
                  )
                }
              </For>
            </box>
          <Show when={showPreview()}>
            <box flexShrink={0} flexDirection="column" paddingLeft={4} paddingRight={4} height={12}>
              <text style={{ fg: api.theme.current.textMuted }} attributes={TextAttributes.BOLD}>
                Preview
              </text>
              <scrollbox flexGrow={1} scrollbarOptions={{ visible: false }}>
                <Show
                  when={previewText()}
                  fallback={<text style={{ fg: api.theme.current.textMuted }}>Loading…</text>}
                >
                  {(text) =>
                    getMarkdownStyle(api.theme.current) ? (
                      <markdown content={text()} syntaxStyle={getMarkdownStyle(api.theme.current)!} />
                    ) : (
                      <text wrapMode="word">{text()}</text>
                    )
                  }
                </Show>
              </scrollbox>
            </box>
          </Show>
          <box paddingLeft={4} paddingRight={4} flexShrink={0}>
            <text style={{ fg: api.theme.current.textMuted }}>
              ↑↓ navigate · enter open · space preview · esc close
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
  ])

  api.keymap.registerLayer({
    bindings: [{ key: "ctrl+o", desc: "Pick session", preventDefault: true, cmd: () => void openPicker() }],
  })
}

export default { id: "sesh-panel", tui }
