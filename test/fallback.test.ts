import { expect, test } from "bun:test"
import { generateWithFallback, modelChain } from "../src/fallback"
import { parseModel } from "../src/prediction"
import { wordAbstains, wordCompletion } from "../src/word"

const primary = parseModel("lmstudio/primary")
const alternate = parseModel("lmstudio/alternate")
const coding = parseModel("openai/coding")
const models = [primary, alternate, coding]

test("explicit local-then-session chain deduplicates and excludes cloud alternates", () => {
  expect(modelChain(primary, [primary, coding, alternate], coding)).toEqual(models)
  expect(modelChain(primary, [alternate], primary)).toEqual([primary, alternate])
  expect(modelChain(primary, [coding])).toEqual([primary])
})

test("fallback uses local alternate before coding model", async () => {
  const calls: string[] = []
  const used: string[] = []
  const result = await generateWithFallback({ models, timeoutMs: 100, signal: new AbortController().signal,
    fallback: (model) => used.push(model.id),
    generate: async (model) => {
      calls.push(model.id)
      if (model !== coding) throw new Error("Unavailable")
      return "tests"
    },
  })
  expect(result).toBe("tests")
  expect(calls).toEqual(["primary", "alternate", "coding"])
  expect(used).toEqual(["alternate", "coding"])
})

test("successful local fallback never calls coding model", async () => {
  const calls: string[] = []
  await generateWithFallback({ models, timeoutMs: 100, signal: new AbortController().signal,
    generate: async (model) => { calls.push(model.id); if (model === primary) throw new Error("Unavailable"); return "tests" },
  })
  expect(calls).toEqual(["primary", "alternate"])
})

test.each(["NONE", "", "tests"])("valid API response %s never triggers fallback", async (text) => {
  let calls = 0
  expect(await generateWithFallback({ models, timeoutMs: 100, signal: new AbortController().signal,
    generate: async () => { calls++; return text },
  })).toBe(text)
  expect(calls).toBe(1)
})

test("per-model timeout advances to local alternate even if backend ignores abort", async () => {
  const signals: AbortSignal[] = []
  const result = await generateWithFallback({ models, timeoutMs: 10, signal: new AbortController().signal,
    generate: async (model, signal) => {
      signals.push(signal)
      if (model === primary) return new Promise<string>(() => {})
      return "tests"
    },
  })
  expect(result).toBe("tests")
  expect(signals).toHaveLength(2)
  expect(signals[0]!.aborted).toBe(true)
})

test("user cancellation stops the entire chain, never disclosing draft to coding fallback", async () => {
  const controller = new AbortController()
  const calls: string[] = []
  const request = generateWithFallback({ models, timeoutMs: 1000, signal: controller.signal,
    generate: async (model) => { calls.push(model.id); return new Promise<string>(() => {}) },
  })
  await Bun.sleep(5)
  controller.abort(new Error("User typed"))
  await expect(request).rejects.toThrow("User typed")
  expect(calls).toEqual(["primary"])
})

test("no implicit server default when the explicitly configured chain fails", async () => {
  const calls: string[] = []
  await expect(generateWithFallback({ models: [primary, alternate], timeoutMs: 100, signal: new AbortController().signal,
    generate: async (model) => { calls.push(model.id); throw new Error("Unavailable") },
  })).rejects.toThrow("All configured autocomplete models failed")
  expect(calls).toEqual(["primary", "alternate"])
})

test("no-progress partial-word echo advances to local alternate, not coding model", async () => {
  const calls: string[] = []
  const draft = "commit and op"
  const output = await generateWithFallback({ models, timeoutMs: 100, signal: new AbortController().signal,
    generate: async (model) => {
      calls.push(model.id)
      const text = model === primary ? '"commit and op"' : 'CURRENT_USER_DRAFT_JSON: "commit and open a PR"'
      if (!wordCompletion(text, draft) && !wordAbstains(text)) throw new Error("No progress")
      return text
    },
  })
  expect(calls).toEqual(["primary", "alternate"])
  expect(wordCompletion(output, draft)).toBe("commit and open")
})
