import { afterEach, expect, test } from "bun:test"
import { DEFAULT_MODEL, parseModel, type PredictionState } from "../src/prediction"
import { createWordPredictor, wordAbstains, wordCompletion, wordPrompt } from "../src/word"

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))
const base: PredictionState = { sessionID: "s1", turnID: "a1", busy: false, eligible: true, draft: "Add " }
const tick = () => Bun.sleep(15)

function setup(debounceMs = 1, cooldownMs = 1) {
  const calls: { draft: string; signal: AbortSignal; resolve: (text: string) => void }[] = []
  const words = createWordPredictor({
    model: parseModel(DEFAULT_MODEL), debounceMs, cooldownMs, timeoutMs: 1000, changed: () => {},
    generate: ({ draft, signal }) => new Promise<string>((resolve) => { calls.push({ draft, signal, resolve }) }),
  })
  cleanups.push(words.dispose)
  return { words, calls }
}

test.each([
  ["regression", "Add reg", "Add regression"],
  ["tests", "Add ", "Add tests"],
  ["tests", "Add", "Add tests"],
  ["ahead", "go ", "go ahead"],
  ["alteração", "essa alt", "essa alteração"],
  ["tests.", "Add ", "Add tests."],
  ["regression", "Add regression", ""],
  ["tests", "", ""],
  ["测试", "添加", "添加测试"],
])("one word/suffix: %s + %s", (output, draft, expected) => {
  expect(wordCompletion(output, draft)).toBe(expected)
})

test.each(["NONE", "null", "two words", "<think>word", "```word", "user: tests", "!rm", "/run", "@agent", "...", "x".repeat(101)])("reject malformed word: %s", (text) => {
  expect(wordCompletion(text, "Add ")).toBe("")
})

test("word prompt prioritizes literal draft over conversation and has no topic-bearing toy examples", () => {
  const prompt = wordPrompt([], "Actually check the pars")
  expect(prompt).toContain('"Actually check the pars"')
  expect(prompt).toContain("draft is the strongest evidence")
  expect(prompt).toContain("never as the assistant")
  expect(prompt).toContain("JSON STRING")
  expect(prompt).not.toContain("regression")
  expect(prompt).not.toContain('draft "Add')
})

test("typed prediction omits assistant explanations and quoted autocomplete examples", () => {
  const prompt = wordPrompt([
    { id: "u", type: "user", time: { created: 1 }, text: "Finish the implementation" },
    { id: "a", type: "assistant", time: { created: 2, completed: 3 }, agent: "build", model: parseModel(DEFAULT_MODEL), content: [{ type: "text", text: "Add reg becomes regression. Regression example again." }] },
  ], "commit and ")
  expect(prompt).toContain("Finish the implementation")
  expect(prompt).not.toContain("regression")
})

test("JSON string completion preserves partial word boundaries", () => {
  expect(wordCompletion(JSON.stringify("commit and open a PR"), "commit and op")).toBe("commit and open")
  expect(wordCompletion(JSON.stringify("Add regression tests"), "Add reg")).toBe("Add regression")
})

test("decode quoted local-model completion without copying labels or explanations", () => {
  expect(wordCompletion('CURRENT_USER_DRAFT_JSON: "commit and open a PR"', "commit and op")).toBe("commit and open")
  expect(wordCompletion('"Add regression tests."\n\nNote: explanation', "Add reg")).toBe("Add regression")
  expect(wordCompletion('"commit and op"', "commit and op")).toBe("")
  expect(wordCompletion('{"text":"Add regression tests"}', "Add reg")).toBe("Add regression")
  expect(wordCompletion('```json\n{"completedDraft":"commit and open a PR"}\n```', "commit and op")).toBe("commit and open")
})

test.each(["", "NONE", "null", '""', '"NONE"', '{"completion":""}', '{"text":""}', '{"suffix":""}'])("explicit abstention does not escalate: %s", (text) => {
  expect(wordAbstains(text)).toBe(true)
})

test.each(['"commit and op"', '{"completion":42}', '{"suffix":', "unusable response"])("unusable non-abstention can escalate: %s", (text) => {
  expect(wordAbstains(text)).toBe(false)
})

test.each([
  ["commit and ", "open a PR", "commit and open"],
  ["commit and op", "en a PR", "commit and open"],
  ["commit", " and open a PR", "commit and"],
  ["Add reg", "ression tests for the parser", "Add regression"],
  ["Add ", "regression tests", "Add regression"],
  ["Add ", " regression tests", "Add regression"],
  ["essa alt", "eração está pronta", "essa alteração"],
  ["添加", "测试 用例", "添加测试"],
])("extract only first missing word from continuation of %s", (draft, suffix, expected) => {
  expect(wordCompletion(JSON.stringify({ suffix }), draft)).toBe(expected)
})

test.each([
  '{"suffix":', '{"suffix":42}', '{"wrong":"open"}', '{"suffix":""}',
  JSON.stringify({ suffix: "commit and open a PR" }),
  JSON.stringify({ suffix: "open\na PR" }),
  JSON.stringify({ suffix: "x".repeat(241) }),
  JSON.stringify({ suffix: "!rm" }),
])("reject malformed, copied, or unsafe continuations: %s", (text) => {
  expect(wordCompletion(text, "commit and ")).toBe("")
})

test.each([
  ["commit and ", "commit and open a PR", "commit and open"],
  ["commit and op", "commit and open a PR", "commit and open"],
  ["commit and open ", "commit and open PR", "commit and open PR"],
  ["Add reg", "Add regression tests", "Add regression"],
  ["Please update the doc", "Please update the documentation", "Please update the documentation"],
  ["Please update the doc", "Please update the doc with the changes", "Please update the doc with"],
])("hard-prefix completion preserves draft %s and accepts one word", (draft, completion, expected) => {
  expect(wordCompletion(JSON.stringify({ completion }), draft)).toBe(expected)
})

test.each(["commit and publish", "open a PR", "Commit and open a PR", "", "commit and op\nen a PR"])("reject completion that rewrites or corrupts typed prefix: %s", (completion) => {
  expect(wordCompletion(JSON.stringify({ completion }), "commit and op")).toBe("")
})

test("debounce uses latest draft and deduplicates repeated frames", async () => {
  const t = setup(30)
  t.words.observe(base)
  await Bun.sleep(5)
  t.words.observe({ ...base, draft: "Add reg" })
  t.words.observe({ ...base, draft: "Add reg" })
  await Bun.sleep(45)
  expect(t.calls).toHaveLength(1)
  expect(t.calls[0]!.draft).toBe("Add reg")
  t.calls[0]!.resolve("regression")
  await tick()
  expect(t.words.value()).toBe("Add regression")
  t.words.observe({ ...base, draft: "Add reg" })
  await tick()
  expect(t.calls).toHaveLength(1)
})

test("changed draft gets fresh inference, even if prefix would match old candidate", async () => {
  const t = setup()
  t.words.observe(base)
  await tick()
  t.calls[0]!.resolve("regression")
  await tick()
  t.words.observe({ ...base, draft: "Add re" })
  expect(t.words.value()).toBe("")
  await tick()
  expect(t.calls[1]!.draft).toBe("Add re")
  t.calls[1]!.resolve("regression")
  await tick()
  expect(t.words.value()).toBe("Add regression")
})

test("acceptance edit schedules a fresh next word; Escape suppresses same draft", async () => {
  const t = setup()
  t.words.observe(base)
  await tick()
  t.calls[0]!.resolve("regression")
  await tick()
  t.words.observe({ ...base, draft: "Add regression" })
  await tick()
  expect(t.calls).toHaveLength(2)
  t.words.suppress()
  expect(t.calls[1]!.signal.aborted).toBe(true)
  t.words.observe({ ...base, draft: "Add regression" })
  await tick()
  expect(t.calls).toHaveLength(2)
  t.words.observe({ ...base, draft: "Add regression " })
  await tick()
  expect(t.calls).toHaveLength(3)
})

test("edit-away-and-back cancels old response with identical draft text", async () => {
  const t = setup()
  t.words.observe(base)
  await tick()
  t.words.observe({ ...base, draft: "Other" })
  t.words.observe(base)
  expect(t.calls[0]!.signal.aborted).toBe(true)
  await tick()
  t.calls[0]!.resolve("stale")
  await tick()
  expect(t.words.value()).toBe("")
  t.calls[1]!.resolve("tests")
  await tick()
  expect(t.words.value()).toBe("Add tests")
})

test.each(["clear", "busy", "cursor", "turn", "route", "model", "dispose"])("invalidate pending word: %s", async (action) => {
  const t = setup()
  t.words.observe(base)
  await tick()
  if (action === "clear") t.words.observe({ ...base, draft: "" })
  if (action === "busy") t.words.observe({ ...base, busy: true })
  if (action === "cursor") t.words.observe({ ...base, eligible: false })
  if (action === "turn") t.words.observe({ ...base, turnID: undefined })
  if (action === "route") t.words.observe({ ...base, sessionID: undefined })
  if (action === "model") t.words.setModel(parseModel("lmstudio/other"))
  if (action === "dispose") t.words.dispose()
  expect(t.calls[0]!.signal.aborted).toBe(true)
  t.calls[0]!.resolve("stale")
  await tick()
  expect(t.words.value()).toBe("")
})

test("cooldown spaces calls even after multiple edits", async () => {
  const t = setup(1, 80)
  t.words.observe(base)
  await tick()
  t.calls[0]!.resolve("tests")
  await tick()
  t.words.observe({ ...base, draft: "Run " })
  await tick()
  expect(t.calls).toHaveLength(1)
  await Bun.sleep(80)
  expect(t.calls).toHaveLength(2)
})

test("no requests for commands, mentions, huge drafts, or empty fields", async () => {
  const t = setup()
  for (const draft of ["", " ", "/command", "!shell", "Ask @agent", "x".repeat(2001)]) t.words.observe({ ...base, draft })
  await tick()
  expect(t.calls).toHaveLength(0)
})
