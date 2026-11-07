#!/usr/bin/env bun
// Render the real picker, /sesh-needs, /sesh-costs and sidebar through tui()
// with a mock host: layout regressions on small terminals cannot be caught by
// the data-layer tests. An optional argument points at another tui.tsx.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHarness, session, sourcePath } from "./dialog-harness.mjs"

const source = readFileSync(process.argv[2] ?? sourcePath, "utf8")
const failures = []
async function check(name, fn) {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures.push(name)
    console.log(`not ok - ${name}\n${error.message}`)
  }
}

const longTitle = (index) => `Session number ${index} with a fairly long descriptive title that keeps going and going for ages`
const sessions = Array.from({ length: 12 }, (_, index) => session(index, longTitle(index)))

for (const [width, height] of [[44, 14], [80, 14], [80, 24], [80, 20], [60, 24], [44, 24], [120, 40], [100, 30], [200, 60]]) {
  await check(`picker ${width}x${height} keeps its header, a list row and the footer on screen`, async () => {
    const harness = await createHarness({ width, height, sessions, source })
    try {
      const dialog = await harness.command("sesh")
      const frame = await harness.show(dialog, Math.min(116, width - 2))
      for (const text of ["Sessions (12)", "esc", "Search title", "Project: all", "nput", "Pin", "▾ /work/project", "Session number 0", "esc close"]) {
        assert.ok(frame.includes(text), `missing ${JSON.stringify(text)}\n${frame}`)
      }
      const lines = frame.split("\n")
      assert.ok(lines.findIndex((line) => line.includes("Sessions (12)")) >= 0 && lines[0].trim() !== "esc close", frame)
      if (width >= 60) {
        const row = lines.find((line) => /[├└].*Session/.test(line))
        assert.match(row, /…\s+\S+\s*$/, "long picker titles retain an ellipsis and an age gap\n" + frame)
      }
    } finally {
      harness.close()
    }
  })
}

for (const [width, height] of [[44, 14], [44, 24], [60, 24], [80, 24], [120, 40], [200, 60]]) {
  await check(`needs ${width}x${height} preserves titles and its footer`, async () => {
    const harness = await createHarness({ width, height, sessions, waiting: sessions.map((entry) => entry.id), source })
    try {
      const dialog = await harness.command("sesh-needs")
      const frame = await harness.show(dialog, Math.min(88, width - 2))
      assert.ok(frame.includes("Session number"), frame)
      assert.ok(frame.includes(width < 80 ? "answer" : "awaiting answer"), frame)
      assert.ok(frame.includes("esc close"), frame)
      for (let i = 0; i < sessions.length; i++) harness.press("down")
      await harness.setup.flush()
      assert.ok(harness.setup.captureCharFrame().includes("Session number 0"), "keyboard selection must scroll into view")
    } finally { harness.close() }
  })
}

for (const [width, height] of [[44, 14], [60, 20], [80, 24], [200, 60]]) {
  await check(`costs ${width}x${height} scrolls and preserves its footer`, async () => {
    const costRows = Array.from({ length: 30 }, (_, index) => ({ directory: `/work/project${index}`, cost: index + 0.4 }))
    const harness = await createHarness({ width, height, sessions, costRows, source })
    try {
      const dialog = await harness.command("sesh-costs")
      const frame = await harness.show(dialog, Math.min(88, width - 2))
      assert.ok(frame.includes("Cost digest") && frame.includes("esc close"), frame)
      assert.ok(frame.includes("$29.40"), frame)
      const scrollboxes = []
      const walk = (node) => {
        if (typeof node.scrollTo === "function") scrollboxes.push(node)
        for (const child of node.getChildren?.() ?? []) walk(child)
      }
      walk(harness.setup.renderer.root)
      assert.ok(scrollboxes.length, "cost rows must have a scrollbox")
      scrollboxes[0].scrollTo(10000)
      await harness.setup.flush()
      assert.ok(harness.setup.captureCharFrame().includes("$0.40"), "last project must be reachable by scrolling")
    } finally { harness.close() }
  })
}

for (const width of [24, 30, 36, 42, 60]) {
  await check(`sidebar ${width}x24 keeps its heading on one line and truncates titles`, async () => {
    const harness = await createHarness({ width, height: 24, sessions, waiting: [sessions[0].id, sessions[1].id], source })
    try {
      const frame = await harness.sidebar()
      assert.ok(frame.includes("Sessions"), frame)
      assert.ok(!frame.split("\n").some((line) => /^\s*input\s*$/.test(line)), frame)
      const rows = frame.split("\n").filter((line) => /[├└]/.test(line))
      assert.ok(rows.length, frame)
      for (const row of rows) assert.match(row, /…\s+\S+\s*$/, frame)
    } finally { harness.close() }
  })
}

await check("picker preview 44x24 keeps metadata and the back hint", async () => {
  const harness = await createHarness({ width: 44, height: 24, sessions, source })
  try {
    const dialog = await harness.command("sesh")
    await harness.show(dialog, 42)
    harness.press("alt+p")
    await harness.setup.flush()
    const frame = harness.setup.captureCharFrame()
    assert.ok(frame.includes("/work/project"), frame)
    assert.ok(frame.includes("esc back"), frame)
  } finally { harness.close() }
})

await check("picker transcript excerpts retain an ellipsis on narrow screens", async () => {
  const harness = await createHarness({ width: 60, height: 24, sessions, source,
    transcript: "needle " + "a long transcript excerpt with more words than the line can fit ".repeat(8) })
  try {
    const dialog = await harness.command("sesh")
    await harness.show(dialog, 58)
    await harness.setup.mockInput.typeText("needle")
    await harness.setup.flush()
    await harness.setup.flush()
    const frame = harness.setup.captureCharFrame()
    const excerpt = frame.split("\n").find((line) => line.includes("↳"))
    assert.ok(excerpt, frame)
    assert.match(excerpt, /…\s*$/, frame)
  } finally { harness.close() }
})

await check("picker preserves scope, needs-input filters and two-step delete", async () => {
  const harness = await createHarness({ width: 80, height: 24, sessions, waiting: [sessions[0].id], source })
  try {
    const dialog = await harness.command("sesh")
    await harness.show(dialog, 78)
    harness.press("ctrl+g")
    harness.press("alt+w")
    await harness.setup.flush()
    assert.ok(harness.setup.captureCharFrame().includes("● Needs input"))
    harness.press("alt+d")
    await harness.setup.flush()
    assert.ok(harness.setup.captureCharFrame().includes("y confirm"))
    harness.press("n")
    await harness.setup.flush()
    assert.ok(!harness.setup.captureCharFrame().includes("y confirm"))
    harness.press("enter")
    assert.ok(harness.navigations.some(([route]) => route === "session"), "Enter opens a session")
  } finally { harness.close() }
})

const sessionRows = (frame) => frame.split("\n").filter((line) => /[├└]/.test(line)).length

for (const [width, height, minRows] of [[44, 14, 4], [80, 24, 6]]) {
  await check(`picker ${width}x${height} shows at least ${minRows} session rows`, async () => {
    const harness = await createHarness({ width, height, sessions, source })
    try {
      const frame = await harness.show(await harness.command("sesh"), Math.min(116, width - 2))
      assert.ok(sessionRows(frame) >= minRows, frame)
      assert.ok(!/transcripts/.test(frame), "a complete index takes no status line\n" + frame)
      assert.equal(frame.split("\n").filter((line) => /esc close/.test(line)).length, 1, "one-line footer\n" + frame)
    } finally { harness.close() }
  })
}

await check("picker keeps indexing progress visible, then gives its row back", async () => {
  const harness = await createHarness({ width: 80, height: 24, sessions, source, indexDelay: 400 })
  try {
    const dialog = await harness.command("sesh")
    const busy = await harness.show(dialog, 78)
    assert.match(busy, /indexing transcripts \d+\/12/, busy)
    await new Promise((resolve) => setTimeout(resolve, 700))
    await harness.setup.flush()
    await harness.setup.flush()
    const done = harness.setup.captureCharFrame()
    assert.ok(!/transcripts/.test(done), done)
    assert.ok(sessionRows(done) > sessionRows(busy), "the freed status row goes to the list")
  } finally { harness.close() }
})

const rowAt = (frame, title) => {
  const lines = frame.split("\n")
  const y = lines.findIndex((line) => line.includes(title))
  assert.ok(y >= 0, `no row ${title}\n${frame}`)
  return { x: lines[y].indexOf(title), y }
}

for (const [width, height] of [[44, 14], [80, 24]]) {
  for (const cmux of [false, true]) {
    await check(`picker right-click opens the action menu at ${width}x${height} ${cmux ? "inside" : "outside"} cmux`, async () => {
      const harness = await createHarness({ width, height, sessions, source })
      harness.setCmux(cmux)
      try {
        const dialog = await harness.command("sesh")
        const before = await harness.show(dialog, Math.min(116, width - 2))
        const at = rowAt(before, "Session number 1")
        await harness.setup.mockMouse.click(at.x, at.y, 2)
        await harness.setup.flush()
        await harness.setup.flush()
        const frame = harness.setup.captureCharFrame()
        for (const label of ["Open", "Preview transcript", "Fork", "Pin", "Delete"]) assert.ok(frame.includes(label), `missing ${label}\n${frame}`)
        assert.equal(frame.includes("Open in new cmux workspace"), cmux, frame)
        for (const kept of ["Sessions (12)", "Search title", "Project: all"]) {
          assert.ok(frame.includes(kept), `the menu must not cover ${kept}\n${frame}`)
        }
        assert.equal(harness.cleared, 0, "right-click must not close the picker")
        assert.equal(harness.navigations.length, 0)
        assert.equal(harness.spawns.length, 0, "opening the menu never runs cmux")
      } finally { harness.close() }
    })
  }
}

await check("picker menu workspace item runs cmux only inside cmux, through the stubbed spawn", async () => {
  const harness = await createHarness({ width: 80, height: 24, sessions, source })
  harness.setCmux(true)
  try {
    const dialog = await harness.command("sesh")
    const at = rowAt(await harness.show(dialog, 78), "Session number 2")
    await harness.setup.mockMouse.click(at.x, at.y, 2)
    await harness.setup.flush()
    harness.press("down")
    harness.press("down")
    harness.press("enter")
    await harness.setup.flush()
    assert.equal(harness.spawns.length, 1)
    assert.equal(harness.spawns[0][0], "cmux")
    assert.ok(harness.spawns[0][1].includes("opencode --session ses_dlg2"))
    assert.ok(harness.cleared >= 1, "the picker closes before the workspace opens")
  } finally { harness.close() }
})

await check("without cmux the workspace action is absent and nothing is spawned", async () => {
  const harness = await createHarness({ width: 80, height: 24, sessions, source })
  harness.setCmux(false)
  try {
    const dialog = await harness.command("sesh")
    const at = rowAt(await harness.show(dialog, 78), "Session number 2")
    await harness.setup.mockMouse.click(at.x, at.y, 2)
    await harness.setup.flush()
    harness.press("down")
    harness.press("down")
    harness.press("enter")
    await harness.setup.flush()
    assert.equal(harness.spawns.length, 0)
  } finally { harness.close() }
})

await check("picker menu: Esc closes the menu first, Enter chooses its item without opening a row", async () => {
  const harness = await createHarness({ width: 80, height: 24, sessions, source })
  try {
    const dialog = await harness.command("sesh")
    const before = await harness.show(dialog, 78)
    const at = rowAt(before, "Session number 2")
    await harness.setup.mockMouse.click(at.x, at.y, 2)
    await harness.setup.flush()
    assert.ok(harness.setup.captureCharFrame().includes("Preview transcript"))
    harness.press("escape")
    await harness.setup.flush()
    assert.ok(!harness.setup.captureCharFrame().includes("Preview transcript"), "Esc closes the menu")
    assert.equal(harness.cleared, 0, "the first Esc must not close the picker")

    await harness.setup.mockMouse.click(at.x, at.y, 2)
    await harness.setup.flush()
    harness.press("enter")
    await harness.setup.flush()
    assert.equal(harness.navigations.length, 1, "Enter chooses the menu's first item (Open) exactly once")
    assert.equal(harness.spawns.length, 0)
  } finally { harness.close() }
})

await check("picker menu Open opens the right-clicked row", async () => {
  const harness = await createHarness({ width: 80, height: 24, sessions, source })
  try {
    const dialog = await harness.command("sesh")
    const before = await harness.show(dialog, 78)
    const at = rowAt(before, "Session number 3")
    await harness.setup.mockMouse.click(at.x, at.y, 2)
    await harness.setup.flush()
    harness.press("enter")
    await harness.setup.flush()
    assert.deepEqual(harness.navigations.at(-1), ["session", { sessionID: "ses_dlg3" }])
  } finally { harness.close() }
})

await check("home right-click opens the same action menu", async () => {
  const harness = await createHarness({ width: 80, height: 24, sessions, source })
  try {
    const frame = await harness.home()
    const at = rowAt(frame, "Session number 1")
    await harness.setup.mockMouse.click(at.x, at.y, 2)
    await harness.setup.flush()
    await harness.setup.flush()
    const menu = harness.setup.captureCharFrame()
    for (const label of ["Open", "Preview transcript", "Fork", "Pin", "Delete"]) assert.ok(menu.includes(label), `missing ${label}\n${menu}`)
    harness.press("escape")
    await harness.setup.flush()
    assert.ok(!harness.setup.captureCharFrame().includes("Preview transcript"))
  } finally { harness.close() }
})

for (const [width, height] of [[44, 14], [80, 24]]) {
  await check(`needs ${width}x${height} truncates with ellipses and keeps its heading`, async () => {
    const harness = await createHarness({ width, height, sessions, waiting: sessions.map((entry) => entry.id), source })
    try {
      const frame = await harness.show(await harness.command("sesh-needs"), Math.min(88, width - 2))
      const heading = frame.split("\n").find((line) => line.includes("Needs input"))
      assert.match(heading, width < 80 ? /Needs input \(12\)\s*$/ : /\(12 · longest waiting first\)\s*$/, frame)
      const row = frame.split("\n").find((line) => line.includes("Session number 11"))
      assert.match(row, /…/, "long titles end in an ellipsis\n" + frame)
      assert.ok(!frame.includes("time unknown"), frame)
      if (width >= 80) assert.match(frame, /waiting \(start/, "the time stays whole while the directory shortens\n" + frame)
    } finally { harness.close() }
  })
}

await check("picker pins with option+s/r and ctrl+s/d; option+k filters pinned", async () => {
  const harness = await createHarness({ width: 120, height: 40, sessions, source })
  try {
    const dialog = await harness.command("sesh")
    const frame = await harness.show(dialog, 116)
    assert.ok(frame.includes("option+k pinned") && frame.includes("option+s/r pin"), frame)
    assert.ok(!frame.includes("ctrl+s/d"), frame)
    const settle = () => new Promise((resolve) => setTimeout(resolve, 150))
    const last = () => harness.toasts.at(-1)?.message
    harness.press("alt+s")
    await settle()
    assert.equal(last(), "Pinned session")
    harness.press("ctrl+s")
    await settle()
    assert.equal(last(), "Unpinned session")
    harness.press("alt+r")
    await settle()
    assert.equal(last(), "Pinned directory")
    harness.press("ctrl+d")
    await settle()
    assert.equal(last(), "Unpinned directory")
    harness.press("alt+s")
    await settle()
    await harness.setup.flush()
    assert.ok(harness.setup.captureCharFrame().includes("☆ Pinned"), "option+s must not toggle the pinned filter")
    harness.press("alt+k")
    await harness.setup.flush()
    assert.ok(harness.setup.captureCharFrame().includes("★ Pinned"), "option+k toggles the pinned filter")
  } finally { harness.close() }
})

process.exit(failures.length ? 1 : 0)
