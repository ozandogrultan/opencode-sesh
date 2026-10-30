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
  // OpenCode 2.2's native home has a four-line logo (seven when stacked on
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
            <text height={1} wrapMode="none">project · tab agents · ctrl+p commands</text>
          </box>
        </box>
        <box flexGrow={1} minHeight={0} />
      </box>
      <box width="100%" flexShrink={0}>
        <HomeSessions api={props.api} poll={props.poll} pins={props.pins} onTogglePin={() => {}} />
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
const theme = Object.fromEntries(["text", "textMuted", "warning", "error", "backgroundElement"].map((name) => [name, RGBA.fromHex("#ffffff")]))
const entries = Array.from({ length: 8 }, (_, index) => ({
  id: `ses_home${index}`, title: `Session ${index}`, dir: "/project", group: "/project", updated: Date.now() - index * 1000,
}))
const layers = new Set()
const resizeListeners = setup.renderer.listenerCount("resize")
let publish
let pollDisposed = false
const api = {
  renderer: setup.renderer,
  theme: { current: theme },
  ui: { dialog: { open: false } },
  keymap: { registerLayer(layer) { layers.add(layer); return () => layers.delete(layer) } },
  route: { current: { name: "home" } },
}

function frame() {
  return setup.captureCharFrame()
}

function assertLayout(expectedCount) {
  const captured = frame()
  const lines = captured.split("\n")
  const recent = lines.findIndex((line) => line.includes("Recent sessions"))
  const sessionRows = lines.flatMap((line, index) => line.includes("○") ? [index] : [])
  assert.equal(sessionRows.length, expectedCount, captured)
  if (recent >= 0) {
    assert.ok(recent >= boxes.prompt.y + boxes.prompt.height, "home list must render below the composer\n" + captured)
    assert.ok(sessionRows.every((index) => index > recent), captured)
  }
  assert.match(captured, /Plan · model · high/)
  if (dimensions().width >= 44) {
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
    callback({ entries, failed: false })
    return () => { pollDisposed = true }
  } }), setup.renderer)
  await setup.flush()
  // The screenshot regression: a six-line prompt and six recent sessions used
  // to occupy the same rows in an ordinary 80x24 terminal.
  assertLayout(1)
  for (const word of ["first", "second", "third", "fourth", "fifth", "sixth"]) {
    assert.match(frame(), new RegExp(`${word} line`))
  }

  // Resize in both directions without remounting. Fill the editor to its
  // native maximum, including line wrapping, and keep the native footer visible.
  for (const [width, height, count] of [[120, 40, 6], [80, 32, 6], [80, 30, 5], [80, 24, 1], [80, 22, 0], [44, 24, 1], [28, 30, 5], [120, 40, 6]]) {
    await resize(width, height)
    setMessage(Array.from({ length: Math.max(6, Math.floor(height / 3)) }, (_, i) => `line ${i}`).join("\n"))
    await setup.flush()
    assertLayout(count)
    setMessage("wrapped prompt ".repeat(100))
    await setup.flush()
    assertLayout(count)
  }

  // Long titles/directories must stay on their own row on narrow terminals.
  publish({ entries: entries.map((entry) => ({ ...entry, title: entry.title + " very long title".repeat(10), dir: "/" + "long-directory-name/".repeat(12) })), failed: false })
  await resize(28, 30)
  assertLayout(5)
  assert.doesNotMatch(frame(), /option\+o for all/)

  publish({ entries, failed: false })
  await resize(80, 24)
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
