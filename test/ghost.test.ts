import { afterEach, expect, test } from "bun:test"
import { BoxRenderable, RGBA, TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createGhost } from "../src/ghost.tsx"
import { wordCompletion } from "../src/word"

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()))

async function setup(suggestion = "Run the tests and fix any failures.", width = 60, padding = 0) {
  const term = await createTestRenderer({ width, height: 10 })
  cleanups.push(() => term.renderer.destroy())
  const box = new BoxRenderable(term.renderer, { left: 3, top: 2, width: "100%", height: 4 + padding * 2, padding })
  term.renderer.root.add(box)
  const editor = new TextareaRenderable(term.renderer, {
    width: width - 6, height: 2, placeholder: "Ask anything — placeholder", wrapMode: "char",
    keyBindings: [{ name: "return", action: "submit" }],
  })
  const traits = { owner: "opencode", role: "prompt", capture: ["tab"] as const }
  editor.traits = traits
  box.add(editor)
  editor.focus()
  let enabled = true
  const ghost = createGhost({
    renderer: term.renderer, suggestion: () => suggestion, enabled: () => enabled,
    color: RGBA.fromHex("#666666"), background: RGBA.fromHex("#000000"),
  })
  cleanups.push(ghost.dispose)
  await term.renderOnce()
  await term.renderOnce() // preview waits for the first completed editor layout
  return { ...term, editor, ghost, disable: () => { enabled = false } }
}

test("ghost is inline, muted, and never enters the buffer before acceptance", async () => {
  const t = await setup()
  expect(t.editor.plainText).toBe("")
  expect(t.captureCharFrame()).toContain("Run the tests and fix any failures.")
  expect(t.captureCharFrame()).not.toContain("placeholder")
  const span = t.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("Run the tests"))
  expect(span?.fg).toEqual(RGBA.fromHex("#666666"))
  await t.mockInput.typeText("Run the ")
  await t.renderOnce()
  expect(t.editor.plainText).toBe("Run the ")
  expect(t.captureCharFrame()).toContain("Run the tests and fix any failures.")
  expect(t.ghost.accept()).not.toBe(false)
  expect(t.editor.plainText).toBe("Run the tests and fix any failures.")
  expect(t.ghost.available()).toBe(false)
})

test("Enter submits only real input, not the visible suggestion", async () => {
  const t = await setup()
  await t.mockInput.typeText("Run")
  const submitted: string[] = []
  t.editor.onSubmit = () => { submitted.push(t.editor.plainText) }
  t.mockInput.pressEnter()
  expect(submitted).toEqual(["Run"])
})

test("dismiss, mismatch, cursor motion, selection, autocomplete, and other focus suppress ghosts", async () => {
  const t = await setup()
  t.ghost.dismiss()
  expect(t.ghost.available()).toBe(false)
  await t.mockInput.typeText("R")
  expect(t.ghost.available()).toBe(true)
  t.editor.moveCursorLeft()
  expect(t.ghost.available()).toBe(false)
  t.editor.gotoBufferEnd()
  expect(t.ghost.available()).toBe(true)
  t.editor.selectAll()
  expect(t.ghost.available()).toBe(false)
  t.editor.clearSelection()
  t.editor.gotoBufferEnd()
  t.editor.traits = { ...t.editor.traits, capture: ["tab", "escape"] }
  expect(t.ghost.available()).toBe(false)
  t.editor.traits = { ...t.editor.traits, capture: ["tab"] }
  const dialog = new TextareaRenderable(t.renderer, { width: 20, height: 1 })
  t.renderer.root.add(dialog)
  dialog.focus()
  expect(t.ghost.available()).toBe(false)
  t.editor.focus()
  t.editor.setText("Different")
  t.editor.gotoBufferEnd()
  expect(t.ghost.accept()).toBe(false)
})

test("Unicode input uses native cell coordinates instead of JS string length", async () => {
  const t = await setup("修复 👩‍💻 café tests")
  t.editor.setText("修复 👩‍💻 ")
  t.editor.gotoBufferEnd()
  await t.renderOnce()
  expect(t.ghost.available()).toBe(true)
  expect(t.captureCharFrame()).toContain("café tests")
  t.ghost.accept()
  expect(t.editor.plainText).toBe("修复 👩‍💻 café tests")
})

test("wrapped input and resize clip ghost to input bounds", async () => {
  const t = await setup("Run the tests and fix any failures.", 20)
  t.editor.setText("Run the tests and ")
  t.editor.gotoBufferEnd()
  await t.renderOnce()
  expect(t.captureCharFrame()).toContain("fix any fa")
  t.resize(16, 10)
  t.editor.width = 10
  await t.renderOnce()
  expect(t.editor.plainText).toBe("Run the tests and ")
  expect(t.ghost.available()).toBe(true)
})

test.each(["/command", "!shell", "@agent", "Ask @agent"])("host completions win: %s", async (text) => {
  const t = await setup(text + " completion")
  t.editor.setText(text)
  t.editor.gotoBufferEnd()
  expect(t.ghost.available()).toBe(false)
})

test("disable and dispose restore placeholder without mutating the prompt", async () => {
  const t = await setup()
  t.disable()
  await t.renderOnce()
  expect(t.captureCharFrame()).toContain("placeholder")
  expect(t.ghost.accept()).toBe(false)
  t.ghost.dispose()
  await t.renderOnce()
  expect(t.editor.plainText).toBe("")
  expect(t.captureCharFrame()).not.toContain("Run the tests")
})

test("managed textarea suspension must not suppress ghost text", async () => {
  const t = await setup()
  t.editor.traits = { ...t.editor.traits, suspend: true }
  expect(t.ghost.available()).toBe(true)
  t.ghost.accept()
  expect(t.editor.plainText).toBe("Run the tests and fix any failures.")
})

test("postprocessing must respect UI covering any part of the editor row", async () => {
  const t = await setup()
  const overlay = new BoxRenderable(t.renderer, {
    position: "absolute", left: t.editor.x + 8, top: t.editor.y,
    width: 20, height: 1, zIndex: 2000, backgroundColor: "#bd93f9",
  })
  t.renderer.root.add(overlay)
  await t.renderOnce()
  expect(t.ghost.available()).toBe(false)
  expect(t.ghost.accept()).toBe(false)
  expect(t.editor.plainText).toBe("")
  const painted = t.captureSpans().lines[t.editor.y]?.spans ?? []
  expect(painted.some((span) => span.bg.equals(RGBA.fromHex("#bd93f9")))).toBe(true)
  expect(t.captureCharFrame()).not.toContain("Run the tests")
  overlay.visible = false
  await t.renderOnce()
  expect(t.ghost.available()).toBe(true)
  expect(t.captureCharFrame()).toContain("Run the tests")
})

test("a fully covered editor never accepts hidden ghost text", async () => {
  const t = await setup()
  t.editor.setText("Run")
  t.editor.gotoBufferEnd()
  const overlay = new BoxRenderable(t.renderer, {
    position: "absolute", left: t.editor.x, top: t.editor.y,
    width: t.editor.width, height: t.editor.height,
    zIndex: 3000, backgroundColor: "#123456",
  })
  t.renderer.root.add(overlay)
  await t.renderOnce()
  expect(t.ghost.available()).toBe(false)
  expect(t.ghost.accept()).toBe(false)
  expect(t.editor.plainText).toBe("Run")
  overlay.destroy()
  await t.renderOnce()
  expect(t.ghost.available()).toBe(true)
  t.ghost.accept()
  expect(t.editor.plainText).toBe("Run the tests and fix any failures.")
})

test("scene preview aligns with an editor in a padded parent and is removed on disposal", async () => {
  const t = await setup("Run the tests and fix any failures.", 60, 1)
  const row = t.captureCharFrame().split("\n")[t.editor.y]!
  expect(row.indexOf("Run the tests")).toBe(t.editor.x)
  const parent = t.editor.parent!
  expect(parent.getChildrenCount()).toBe(2)
  t.ghost.dispose()
  expect(parent.getChildrenCount()).toBe(1)
  await t.renderOnce()
  expect(t.captureCharFrame()).toContain("placeholder")
  expect(t.editor.plainText).toBe("")
})

test("word preview inserts only the missing word suffix and reports previous draft", async () => {
  const t = await setup("")
  t.ghost.dispose()
  t.editor.setText("Add reg")
  t.editor.gotoBufferEnd()
  let accepted = ""
  const word = createGhost({
    renderer: t.renderer,
    suggestion: () => wordCompletion("regression", t.editor.plainText),
    enabled: () => true,
    color: RGBA.fromHex("#666666"), background: RGBA.fromHex("#000000"),
    accepted: (draft) => { accepted = draft },
  })
  cleanups.push(word.dispose)
  await t.renderOnce()
  await t.renderOnce()
  expect(t.captureCharFrame()).toContain("Add regression")
  expect(t.editor.plainText).toBe("Add reg")
  word.accept()
  expect(t.editor.plainText).toBe("Add regression")
  expect(accepted).toBe("Add reg")
  expect(t.editor.plainText).not.toContain("tests")
})
