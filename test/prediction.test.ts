import { afterEach, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { cleanPrediction, conversation, createPredictor, DEFAULT_MODEL, parseModel, predictionPrompt, type PredictionState } from "../src/prediction"

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const idle: PredictionState = { sessionID: "s1", turnID: "a1", busy: false, draft: "", eligible: true }

function setup(timeoutMs = 1000) {
  const calls: { signal: AbortSignal; model: ReturnType<typeof parseModel>; resolve: (text: string) => void; reject: (error: Error) => void }[] = []
  let errors = 0
  const predictor = createPredictor({
    model: parseModel(DEFAULT_MODEL), timeoutMs, changed: () => {}, failed: () => { errors++ },
    generate: ({ signal, model }) => new Promise<string>((resolve, reject) => { calls.push({ signal, model, resolve, reject }) }),
  })
  cleanups.push(predictor.dispose)
  return { predictor, calls, errors: () => errors }
}

test("model parsing preserves slashes in local model names", () => {
  expect(parseModel(DEFAULT_MODEL)).toEqual({ providerID: "lmstudio", id: "qwen/qwen3-4b-2507" })
  expect(() => parseModel("qwen")).toThrow()
  expect(() => parseModel("openai/model#variant")).toThrow()
})

test("context contains only bounded user/assistant text, never reasoning or tools", () => {
  const messages: SessionMessageInfo[] = [
    { id: "u", type: "user", time: { created: 1 }, text: "Please fix the bug" },
    { id: "a", type: "assistant", time: { created: 2, completed: 3 }, agent: "build", model: parseModel(DEFAULT_MODEL), content: [
      { type: "text", text: "The bug is fixed." }, { type: "reasoning", text: "PRIVATE_REASONING" },
      { type: "tool", id: "t", name: "shell", time: { created: 2 }, state: { status: "completed", input: { command: "PRIVATE_COMMAND" }, content: [{ type: "text", text: "PRIVATE_TOOL_OUTPUT" }] } },
    ] },
  ]
  expect(conversation(messages)).toEqual([{ role: "user", text: "Please fix the bug" }, { role: "assistant", text: "The bug is fixed." }])
  expect(predictionPrompt(messages)).not.toContain("PRIVATE_")
  const many = Array.from({ length: 20 }, (_, i): SessionMessageInfo => ({ id: String(i), type: "user", time: { created: i }, text: "x".repeat(10000) }))
  expect(conversation(many).length).toBeLessThanOrEqual(6)
  expect(conversation(many).reduce((sum, message) => sum + message.text.length, 0)).toBeLessThanOrEqual(6000)
})

test.each(["NONE", "null", "", "user: go", "!rm -rf x", "/run", "@agent", "first\nsecond", "<think>reason</think>go", "x".repeat(241)])("reject unsafe/malformed output: %s", (text) => {
  expect(cleanPrediction(text)).toBe("")
})

test("short plain-language prompts are retained", () => {
  expect(cleanPrediction('  "Add regression tests."  ')).toBe("Add regression tests.")
  expect(cleanPrediction("Adicione testes para essa alteração.")).toBe("Adicione testes para essa alteração.")
})

const pdfQuestion = "Should I share the newer local v4 PDF and use its references to populate 2.1–2.4, or use the committed project summary’s smaller reading list?"
const pdfEcho = "Should I share the newer local v4 PDF and use its references to populate 2.1–2.4, or stick with the committed project summary’s readings?"

test("prompt explicitly requests user voice, short answers, and no arbitrary preference", () => {
  const prompt = predictionPrompt([])
  expect(prompt).toContain("Write as the USER")
  expect(prompt).toContain("A short user answer")
  expect(prompt).toContain("Never repeat or paraphrase")
  expect(prompt).toContain("user's preference is unknown; output NONE")
  expect(prompt).not.toContain("Do not answer the conversation")
})

test.each([
  pdfQuestion,
  pdfEcho,
  pdfQuestion.toUpperCase().replaceAll("–", "-").replaceAll("’", "'"),
  pdfQuestion.replace("PDF", "ＰＤＦ").replace("?", "！"),
])("reject whole-question assistant echo: %s", (text) => {
  expect(cleanPrediction(text, pdfQuestion)).toBe("")
  expect(cleanPrediction(text, `I found two reading lists.\n${pdfQuestion}`)).toBe("")
})

test("reject exact whole-sentence echoes within longer assistant text", () => {
  const sentence = "The newer local PDF contains the complete reference list."
  expect(cleanPrediction(sentence, `The search is done. ${sentence} Shall I proceed?`)).toBe("")
})

test.each([
  "Use the newer local v4 PDF.",
  "Use the committed project summary’s smaller reading list.",
  "Why should I share the newer local v4 PDF and use its references to populate 2.1–2.4?",
  "Can you compare the newer local v4 PDF with the committed project summary’s smaller reading list?",
  "Should I share the newer local v4 PDF with the reviewers before tomorrow’s meeting?",
])("retain user reply or new question sharing nouns: %s", (text) => {
  expect(cleanPrediction(text, pdfQuestion)).toBe(text)
})

test("echo rejection is not arbitrary substring or short-phrase rejection", () => {
  const text = "Use the newer local v4 PDF."
  expect(cleanPrediction(text, `Next step: ${text} Then update the citations.`)).toBe(text)
  expect(cleanPrediction("Yes, please.", "Yes, please.")).toBe("Yes, please.")
  expect(cleanPrediction("Add regression tests.", "Add regression tests.")).toBe("Add regression tests.")
})

test("absent context keeps sanitizer behavior and NONE stays empty", () => {
  expect(cleanPrediction(pdfEcho)).toBe(pdfEcho)
  expect(cleanPrediction(pdfEcho, "")).toBe(pdfEcho)
  expect(cleanPrediction("NONE", pdfQuestion)).toBe("")
  expect(cleanPrediction("NONE")).toBe("")
})

test("generation-boundary guard uses captured context and rejection never retries", async () => {
  let assistant = pdfQuestion
  let resolve!: (text: string) => void
  let calls = 0
  const predictor = createPredictor({
    model: parseModel(DEFAULT_MODEL), timeoutMs: 1000, changed: () => {},
    generate: async () => {
      calls++
      const captured = assistant
      const output = await new Promise<string>((done) => { resolve = done })
      return cleanPrediction(output, captured)
    },
  })
  cleanups.push(predictor.dispose)
  predictor.observe(idle)
  await flush()
  assistant = "The unrelated work is finished."
  resolve(pdfEcho)
  await flush()
  expect(predictor.value()).toBe("")
  predictor.observe({ ...idle, draft: "Something else" })
  predictor.observe(idle)
  await flush()
  expect(predictor.value()).toBe("")
  expect(calls).toBe(1)
})

test("one request per turn, prefix typing keeps a completed prediction", async () => {
  const t = setup()
  t.predictor.observe(idle)
  t.predictor.observe(idle)
  await flush()
  expect(t.calls).toHaveLength(1)
  t.calls[0]!.resolve("Add regression tests.")
  await flush()
  expect(t.predictor.value()).toBe("Add regression tests.")
  t.predictor.observe({ ...idle, draft: "Add " })
  expect(t.predictor.value()).toBe("Add regression tests.")
  t.predictor.consume()
  t.predictor.observe({ ...idle, draft: "Add " })
  expect(t.predictor.value()).toBe("")
  expect(t.calls).toHaveLength(1)
})

test("clearing a nonmatching draft restores the cached suggestion without generation", async () => {
  const t = setup()
  t.predictor.observe(idle)
  await flush()
  t.calls[0]!.resolve("Add regression tests.")
  await flush()
  t.predictor.observe({ ...idle, draft: "Actually do something else" })
  expect(t.predictor.value()).toBe("")
  t.predictor.observe(idle)
  expect(t.predictor.value()).toBe("Add regression tests.")
  expect(t.calls).toHaveLength(1)
})

test.each(["accepted", "dismissed"])("clearing a draft restores an %s suggestion", async (action) => {
  const t = setup()
  t.predictor.observe(idle)
  await flush()
  t.calls[0]!.resolve("Add regression tests.")
  await flush()
  if (action === "accepted") t.predictor.observe({ ...idle, draft: "Add regression tests." })
  t.predictor.consume()
  expect(t.predictor.value()).toBe("")
  if (action === "dismissed") t.predictor.observe({ ...idle, draft: "Something else" })
  t.predictor.observe(idle)
  expect(t.predictor.value()).toBe("Add regression tests.")
  expect(t.calls).toHaveLength(1)
  t.predictor.observe({ ...idle, turnID: "a2", draft: "Different next-turn draft" })
  expect(t.predictor.value()).toBe("")
})

test.each(["typing", "type-and-clear", "switch-back", "busy", "dialog", "dispose"])("cancel stale generation: %s", async (action) => {
  const t = setup()
  t.predictor.observe(idle)
  await flush()
  if (action === "typing" || action === "type-and-clear") t.predictor.observe({ ...idle, draft: "x" })
  if (action === "type-and-clear") t.predictor.observe(idle)
  if (action === "switch-back") {
    t.predictor.observe({ busy: false, draft: "", eligible: false })
    t.predictor.observe(idle)
  }
  if (action === "busy") t.predictor.observe({ ...idle, busy: true })
  if (action === "dialog") t.predictor.observe({ ...idle, eligible: false })
  if (action === "dispose") t.predictor.dispose()
  expect(t.calls[0]!.signal.aborted).toBe(true)
  t.calls[0]!.resolve("Stale result")
  await flush()
  expect(t.predictor.value()).toBe("")
  expect(t.calls).toHaveLength(1)
})

test("model change rejects old response and generates using only the selected model", async () => {
  const t = setup()
  t.predictor.observe(idle)
  await flush()
  const next = parseModel("lmstudio/ibm/granite-4.1-8b")
  t.predictor.setModel(next)
  t.predictor.observe(idle)
  await flush()
  expect(t.calls[0]!.signal.aborted).toBe(true)
  expect(t.calls[1]!.model).toEqual(next)
  t.calls[1]!.resolve("New prediction")
  t.calls[0]!.resolve("Old prediction")
  await flush()
  expect(t.predictor.value()).toBe("New prediction")
})

test("new turn replaces old prediction, dismiss doesn't block later turns", async () => {
  const t = setup()
  t.predictor.observe(idle)
  await flush()
  t.calls[0]!.resolve("First suggestion")
  await flush()
  t.predictor.consume()
  t.predictor.observe({ ...idle, turnID: "a2" })
  await flush()
  t.calls[1]!.resolve("Second suggestion")
  await flush()
  expect(t.predictor.value()).toBe("Second suggestion")
})

test("timeout aborts with no retry or fallback, refresh permits one new attempt", async () => {
  const t = setup(10)
  t.predictor.observe(idle)
  await flush()
  await Bun.sleep(25)
  expect(t.calls[0]!.signal.aborted).toBe(true)
  t.predictor.observe(idle)
  expect(t.calls).toHaveLength(1)
  t.predictor.refresh()
  t.predictor.observe(idle)
  await flush()
  expect(t.calls).toHaveLength(2)
  t.calls[1]!.resolve("Try again")
  await flush()
  expect(t.predictor.value()).toBe("Try again")
})

test("failure is non-blocking and never falls back to another model", async () => {
  const t = setup()
  t.predictor.observe(idle)
  await flush()
  t.calls[0]!.reject(new Error("Model unavailable"))
  await flush()
  t.predictor.observe(idle)
  expect(t.errors()).toBe(1)
  expect(t.calls).toHaveLength(1)
  expect(t.predictor.value()).toBe("")
})

test("never generate at home, while busy, with an existing draft, or without a completed turn", async () => {
  const t = setup()
  t.predictor.observe({ ...idle, sessionID: undefined })
  t.predictor.observe({ ...idle, turnID: undefined })
  t.predictor.observe({ ...idle, busy: true })
  t.predictor.observe({ ...idle, draft: "hello" })
  t.predictor.observe({ ...idle, eligible: false })
  await flush()
  expect(t.calls).toHaveLength(0)
})
