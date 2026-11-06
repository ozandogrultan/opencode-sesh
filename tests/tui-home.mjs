#!/usr/bin/env bun
// Render the real home list inside the home layout: data-only tests cannot
// catch text painting over the composer when the terminal runs out of rows.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { transformSync } from "@babel/core"
import { createSignal } from "solid-js"
import { RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { render } from "@opentui/solid"

const source = readFileSync(new URL("../tui-plugins/sesh-panel/tui.tsx", import.meta.url), "utf8")
// Compile exactly as the published panel, but expose a test-only fixture. No
// source exports, files in dist, or installed plugin copies need changing.
const fixture = `
export function HomeFixture(props) {
  // Layout baseline: OpenCode 2.2.4 (unchanged through 2.2.5), matching HOME_FOOTER_ROWS in tui.tsx.
  // Re-check both when upgrading OpenCode: this hand-built fixture does not
  // automatically track changes to the host layout. Sources pinned to 2.2.4:
  // https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/tui/src/routes/home.tsx
  // https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/tui/src/component/prompt/index.tsx#L1676
  // https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/tui/src/component/logo.tsx
  // https://github.com/anomalyco/opencode/blob/45898d0f8569225eb1ddb4ee13f8581b34dff311/packages/tui/src/feature-plugins/home/footer.tsx
  // The native home has a four-line logo (seven when stacked on
  // narrow terminals), and its textarea grows to max(6, terminal rows / 3).
  // Keep its chrome here too:
  // testing only an unpadded text node would leave several rows unaccounted for.
  createEffect(() => props.boxes.editor?.setText(props.message()))
  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
        <box flexGrow={1} minHeight={0} />
        <box height={3} minHeight={0} flexShrink={1} />
        <box height={props.dimensions().width < 44 ? 7 : 4} flexShrink={0}><text>OPENCODE LOGO</text></box>
        <box height={1} flexShrink={0} />
        <box width="100%" maxWidth={75} paddingTop={1} flexShrink={0} zIndex={1000}>
          <box ref={(box) => props.boxes.prompt = box}>
            <box paddingTop={1} paddingLeft={2} paddingRight={2}>
              <textarea
                ref={(editor) => props.boxes.editor = editor}
                minHeight={1}
                maxHeight={Math.max(6, Math.floor(props.dimensions().height / 3))}
                initialValue={props.message()}
              />
              <box paddingTop={1} flexShrink={0}><text wrapMode="none">Plan · model · high</text></box>
            </box>
            <box height={1} flexShrink={0} />
            <box width="100%" height={1} flexDirection="row" justifyContent="space-between" gap={2}>
              <text height={1} wrapMode="none">project · tab agents · ctrl+p commands</text>
              <HomeBottom api={props.api} poll={props.poll} pins={props.pins} onTogglePin={() => {}} />
            </box>
          </box>
        </box>
        <box flexGrow={1} minHeight={0} />
      </box>
      <box width="100%" flexShrink={0}>
        <Show when={props.dimensions().height >= 14 && props.dimensions().width >= 44}>
          <box paddingTop={1} paddingBottom={1} flexShrink={0}><text>MCP · VERSION</text></box>
        </Show>
      </box>
    </box>
  )
}
`
const { code } = transformSync(source + fixture, {
  filename: "tui-home.tsx",
  babelrc: false,
  configFile: false,
  presets: [
    ["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }],
    ["@babel/preset-typescript", { isTSX: true, allExtensions: true }],
  ],
  plugins: [() => ({ visitor: {
    ImportDeclaration(path) {
      path.node.source.value = import.meta.resolve(path.node.source.value)
    },
  } })],
})
const { HomeFixture } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)

const setup = await createTestRenderer({ width: 80, height: 24 })
const [message, setMessage] = createSignal("first line\nsecond line\nthird line\nfourth line\nfifth line\nsixth line")
const [dimensions, setDimensions] = createSignal({ width: 80, height: 24 })
const [pins, setPins] = createSignal({ sessions: [], directories: [] })
const boxes = {}
const theme = Object.fromEntries(["text", "textMuted", "warning", "error", "success", "backgroundElement"].map((name) => [name, RGBA.fromHex("#ffffff")]))
const entries = Array.from({ length: 8 }, (_, index) => ({
  id: `ses_home${index}`, title: `Session ${index}`, dir: "/project", group: "/project", updated: Date.now() - index * 1000,
}))
const layers = new Set()
const [routeName, setRouteName] = createSignal("home")
let subscriptions = 0
const resizeListeners = setup.renderer.listenerCount("resize")
let publish
let pollDisposed = false
const api = {
  renderer: setup.renderer,
  theme: { current: theme },
  ui: { dialog: { open: false } },
  keymap: { registerLayer(layer) { layers.add(layer); return () => layers.delete(layer) } },
  route: { get current() { return { name: routeName() } } },
  state: { session: { status: (id) => (id === "ses_home1" ? "busy" : "idle") } },
}

function frame() {
  return setup.captureCharFrame()
}

function assertLayout(expectedCount) {
  const captured = frame()
  const lines = captured.split("\n")
  const recent = lines.findIndex((line) => line.includes("Recent"))
  const sessionRows = lines.flatMap((line, index) => /Session \d/.test(line) ? [index] : [])
  if (expectedCount !== undefined) assert.equal(sessionRows.length, expectedCount, captured)
  if (recent >= 0) {
    assert.ok(recent >= boxes.prompt.y + boxes.prompt.height, "home list must render below the composer\n" + captured)
    assert.ok(sessionRows.every((index) => index > recent), captured)
  }
  assert.match(captured, /Plan · model · high/)
  if (dimensions().width >= 44 && dimensions().height >= 14) {
    const status = lines.findIndex((line) => line.includes("MCP · VERSION"))
    assert.ok(status >= boxes.prompt.y + boxes.prompt.height, captured)
    assert.ok(sessionRows.every((index) => index < status), captured)
  }
}

async function resize(width, height) {
  setup.resize(width, height)
  setDimensions({ width, height })
  await setup.flush()
}

function press(key) {
  const binding = [...layers].sort((a, b) => b.priority - a.priority)
    .flatMap((layer) => layer.bindings).find((binding) => binding.key === key)
  assert.ok(binding, `no active binding for ${key}`)
  binding.cmd()
}

async function search() {
  const lines = frame().split("\n")
  const y = lines.findIndex((line) => line.includes("search…"))
  assert.ok(y >= 0, frame())
  await setup.mockMouse.click(lines[y].indexOf("search…"), y)
  await setup.flush()
}

try {
  await render(() => HomeFixture({ api, boxes, message, dimensions, pins, poll(callback) {
    publish = callback
    subscriptions += 1
    callback({ entries, failed: false })
    return () => { pollDisposed = true }
  } }), setup.renderer)
  await setup.flush()
  // The list floats directly under the composer, so it must never reach the
  // status footer even with a six-line prompt in an ordinary 80x24 terminal.
  assertLayout()
  for (const word of ["first", "second", "third", "fourth", "fifth", "sixth"]) {
    assert.match(frame(), new RegExp(`${word} line`))
  }

  // Resize in both directions without remounting. Fill the editor to its
  // native maximum, including line wrapping: the list may shrink or vanish,
  // but never overlaps the composer or the native footer.
  for (const [width, height] of [[120, 40], [80, 32], [80, 30], [80, 24], [80, 22], [44, 24], [28, 30], [120, 40]]) {
    await resize(width, height)
    setMessage(Array.from({ length: Math.max(6, Math.floor(height / 3)) }, (_, i) => `line ${i}`).join("\n"))
    await setup.flush()
    assertLayout()
    setMessage("wrapped prompt ".repeat(100))
    await setup.flush()
    assertLayout()
  }

  // With a one-line prompt the list sits right under the composer and uses the
  // room the terminal offers, up to six rows.
  for (const [width, height, count] of [[120, 50, 6], [120, 40, 6], [80, 32, 4], [80, 24, 1], [80, 22, 0], [80, 14, 0], [44, 24, 1], [28, 30, 3], [28, 50, 6], [200, 60, 6], [120, 12, 0]]) {
    await resize(width, height)
    setMessage("hi")
    await setup.flush()
    assertLayout(count)
    if (count > 0) {
      const lines = frame().split("\n")
      const footer = lines.findIndex((line) => line.includes("project ·"))
      const heading = lines.findIndex((line) => line.includes("Recent"))
      assert.ok(heading > footer && heading <= footer + 2, "list must start right below the composer\n" + frame())
    }
  }

  // Long titles/directories must stay on their own row on narrow terminals.
  publish({ entries: entries.map((entry) => ({ ...entry, title: entry.title + " very long title".repeat(10), dir: "/" + "long-directory-name/".repeat(12) })), failed: false })
  await resize(28, 30)
  setMessage("hi")
  assertLayout(3)

  // Age survives long directories; columns line up across rows.
  publish({ entries: entries.map((entry, index) => ({ ...entry, dir: "/" + "long-directory-name/".repeat(12) + (index % 2 ? "data-science-DIAL-2764" : "x") })), failed: false })
  for (const width of [120, 80, 44, 28]) {
    await resize(width, 40)
    setMessage("hi")
    await setup.flush()
    const rows = frame().split("\n").filter((line) => /Session \d/.test(line))
    assert.ok(rows.length > 1, frame())
    for (const row of rows) assert.match(row.trimEnd(), /\s(now|\d+[mhd])$/, "age must always render\n" + frame())
    assert.equal(new Set(rows.map((row) => row.trimEnd().length)).size, 1, "age column must right-align\n" + frame())
    const headerLine = frame().split("\n").find((line) => line.includes("Recent"))
    assert.match(headerLine, /search…\s*$/, "search box must always render at the right edge\n" + frame())
    assert.equal(headerLine.trimEnd().length, rows[0].trimEnd().length, "search label must end at the age column\n" + frame())
    if (width >= 80) assert.match(headerLine, /Recent sessions \(option\+o all\)\s+search…/, frame())
    if (width >= 44) assert.match(headerLine, /\(option\+o all\)/, frame())
    if (width <= 28) {
      assert.doesNotMatch(headerLine, /option\+/, "hint must be dropped when it cannot fit\n" + frame())
      assert.doesNotMatch(rows.join("\n"), /\bx\b|data-/, "narrow lists drop the directory column instead of starving titles\n" + frame())
      assert.match(headerLine, /^\s*Recent \S* +search…\s*$/, "title truncates, never the search box\n" + frame())
    }
    if (width >= 80) {
      assert.equal(new Set(rows.map((row) => row.search(/x\s|data-science-DIAL-2764/) >= 0 ? 1 : 0)).size, 1, frame())
      const dirCols = rows.map((row) => row.search(/\S+\s+(now|\d+[mhd])\s*$/))
      assert.equal(new Set(dirCols).size, 1, "directory column must align\n" + frame())
    }
  }
  // Titles that fill their column still leave two blank columns before the
  // directory and before the age, and are cut with an ellipsis.
  publish({ entries: entries.map((entry, index) => ({ ...entry, title: `Session ${index} ` + "very long title ".repeat(8), dir: "/work/data-science-DIAL-2764", updated: Date.now() - (index % 2 ? 3600_000 : 0) })), failed: false })
  for (const width of [110, 80, 44]) {
    await resize(width, 40)
    setMessage("hi")
    await setup.flush()
    const rows = frame().split("\n").filter((line) => /Session \d/.test(line))
    assert.ok(rows.length > 1, frame())
    for (const row of rows) {
      assert.match(row.trimEnd(), /…\s{2,}data-\S*\s+(now|\d+[mhd])$/, `title, directory and age need a two-column gap at ${width}\n` + frame())
      assert.match(row.trimEnd(), /\S\s{2,}(now|\d+[mhd])$/, frame())
    }
  }
  await resize(28, 40)
  setMessage("hi")
  await setup.flush()
  for (const row of frame().split("\n").filter((line) => /Session \d/.test(line))) {
    assert.match(row.trimEnd(), /…\s{2,}(now|\d+[mhd])$/, "title and age need a two-column gap without a directory\n" + frame())
  }
  publish({ entries: entries.map((entry, index) => ({ ...entry, dir: "/" + "long-directory-name/".repeat(12) + (index % 2 ? "data-science-DIAL-2764" : "x") })), failed: false })
  await resize(28, 40)
  setMessage("hi")
  await setup.flush()
  const markerLines = frame().split("\n")
  const busy = markerLines.find((line) => line.includes("Session 1"))
  assert.match(busy, /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, "running session gets the sidebar spinner marker\n" + frame())
  const idle = markerLines.find((line) => line.includes("Session 0"))
  assert.match(idle, /^\s*○/, "idle session gets a hollow marker\n" + frame())
  assert.doesNotMatch(idle, /●/)
  // A session running in another OpenCode process reaches the list only
  // through the polled DB set; it must spin like a live one.
  publish({ entries: entries.map((entry, index) => ({ ...entry, dir: "/" + "long-directory-name/".repeat(12) + (index % 2 ? "data-science-DIAL-2764" : "x") })), running: new Set(["ses_home0"]), failed: false })
  await setup.flush()
  assert.match(frame().split("\n").find((line) => line.includes("Session 0")), /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, "polled running session spins\n" + frame())
  publish({ entries: entries.map((entry, index) => ({ ...entry, dir: "/" + "long-directory-name/".repeat(12) + (index % 2 ? "data-science-DIAL-2764" : "x") })), failed: false })
  await setup.flush()
  assert.match(frame().split("\n").find((line) => line.includes("Session 0")), /^\s*○/, "a session leaving the polled set stops spinning\n" + frame())
  const listLeft = markerLines.find((line) => line.includes("Recent")).indexOf("Recent")
  const composerLeft = markerLines.find((line) => line.includes("project ·")).indexOf("project")
  assert.equal(listLeft, composerLeft, "list must align with the composer's left edge\n" + frame())

  // Leaving home unmounts the list: no polling subscription on session routes.
  await resize(80, 40)
  assert.equal(subscriptions, 1)
  pollDisposed = false
  setRouteName("session")
  await setup.flush()
  assert.ok(pollDisposed, "session route must dispose the home poll subscription")
  assert.equal(layers.size, 0)
  assert.doesNotMatch(frame(), /Recent sessions/)
  setRouteName("home")
  await setup.flush()
  await setup.flush()
  await setup.flush()
  assert.equal(subscriptions, 2, "returning home resubscribes")
  assert.match(frame(), /Recent sessions/)
  pollDisposed = false

  // Arming a delete in a 22-column list must keep the age visible.
  publish({ entries, failed: false })
  await resize(26, 40)
  setMessage("hi")
  await setup.flush()
  {
    const lines = frame().split("\n")
    const y = lines.findIndex((line) => line.includes("Session 0"))
    await setup.mockMouse.moveTo(lines[y].indexOf("Session 0"), y)
    await setup.flush()
    press("alt+d")
    await setup.flush()
    const armed = frame().split("\n").find((line) => line.includes("option+d"))
    assert.ok(armed, frame())
    assert.match(armed.trimEnd(), /\s(now|\d+[mhd])$/, "age must survive an armed delete in a narrow list\n" + frame())
    press("escape")
    await setup.flush()
  }

  // Header hint right-aligns with the age column; $HOME shows as ~.
  publish({ entries: entries.map((entry, index) => ({ ...entry, dir: index === 0 ? process.env.HOME : entry.dir })), failed: false })
  await resize(100, 40)
  setMessage("hi")
  await setup.flush()
  {
    const lines = frame().split("\n")
    const header = lines.find((line) => line.includes("Recent")).trimEnd()
    const row = lines.find((line) => line.includes("Session 0")).trimEnd()
    assert.equal(header.length, row.length, "header hint must end at the age column\n" + frame())
    assert.match(row, /\s~\s+now$/, "a $HOME directory shows as ~\n" + frame())
  }

  publish({ entries, failed: false })
  await resize(80, 24)
  setMessage("hi")
  setPins({ sessions: ["ses_home7"], directories: [] })
  await setup.flush()
  assertLayout(1)
  assert.match(frame(), /★ Session 7/)

  // Search still works with a reduced row limit. If the list disappears on
  // resize, it must release typing/hover/delete captures back to the composer.
  await search()
  for (const key of "missing") press(key)
  await setup.flush()
  assertLayout(0)
  assert.match(frame(), /No title or directory matches/)
  assert.ok(layers.size > 0)
  await resize(80, 22)
  assertLayout(0)
  assert.doesNotMatch(frame(), /Recent sessions/)
  assert.equal(layers.size, 0)
  await resize(80, 24)
  assert.match(frame(), /No title or directory matches/)
  // Clear the retained query through its visible clear action.
  const queryLines = frame().split("\n")
  const queryY = queryLines.findIndex((line) => line.includes("✕"))
  assert.ok(queryY >= 0, frame())
  await setup.mockMouse.click(queryLines[queryY].indexOf("✕"), queryY)
  await setup.flush()
  assertLayout(1)

  const rowLines = frame().split("\n")
  const rowY = rowLines.findIndex((line) => line.includes("★ Session 7"))
  await setup.mockMouse.moveTo(rowLines[rowY].indexOf("★ Session 7"), rowY)
  await setup.flush()
  const hoverBound = () => [...layers].some((layer) => layer.bindings.some((binding) => binding.key === "alt+d"))
  assert.ok(hoverBound(), "hovering a row binds its shortcuts")
  // Typing into the composer with the pointer resting on a row must hand
  // composer shortcuts such as Option-D (delete word) back to the composer.
  await setup.mockInput.typeText("x")
  await setup.flush()
  assert.ok(!hoverBound(), "an unhandled keypress must release hover shortcuts")
  await setup.mockMouse.moveTo(rowLines[rowY].indexOf("★ Session 7") + 1, rowY)
  await setup.flush()
  assert.ok(hoverBound(), "moving the pointer over the row restores hover")
  press("alt+d")
  await setup.flush()
  assert.match(frame(), /option\+d again/)
  await resize(80, 22)
  assert.equal(layers.size, 0, "a hidden row must release its armed delete and hover captures")
  await resize(80, 24)
  assert.doesNotMatch(frame(), /option\+d again/)

  await resize(120, 40)
  const expandedLines = frame().split("\n")
  const hiddenRowY = expandedLines.findIndex((line) => line.includes("Session 4"))
  await setup.mockMouse.moveTo(expandedLines[hiddenRowY].indexOf("Session 4"), hiddenRowY)
  await setup.flush()
  press("alt+d")
  await setup.flush()
  await resize(80, 24)
  assertLayout(1)
  assert.equal(layers.size, 0, "a row removed by the limit must release captures even when the list stays visible")

  publish({ entries: [], failed: false })
  await setup.flush()
  assertLayout(0)
  assert.match(frame(), /none yet, option\+o to browse/)
  publish({ entries: [], failed: true })
  await setup.flush()
  assert.match(frame(), /list unavailable, will retry/)
} finally {
  await setup.dispose()
}
assert.ok(pollDisposed, "home list must unsubscribe from polling")
assert.equal(layers.size, 0, "home list must release its keyboard captures")
assert.equal(setup.renderer.listenerCount("resize"), resizeListeners, "home list must remove its resize listener")
console.log("tui home layout tests passed (multiline/wrapped prompts, resize, narrow rows, pins, search, empty/error states, cleanup)")
