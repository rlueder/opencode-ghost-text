// Live quality checks use synthetic text and ONLY the explicitly local model.
// No sessions, tools, commits, PRs, or paid fallback calls are created.
import { OpenCode, type SessionMessageInfo } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { homedir } from "node:os"
import { join } from "node:path"
import { DEFAULT_MODEL, parseModel } from "../src/prediction"
import { wordCompletion, wordPrompt } from "../src/word"
import { wordAbstains } from "../src/word"
import { generateWithFallback, modelChain } from "../src/fallback"

const endpoint = await Service.discover()
if (!endpoint) throw new Error("No running OpenCode service")
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
await client.model.list({ location: { directory: join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode") } })
const fallback = process.argv.includes("--fallback")
const model = parseModel(process.argv[2] && process.argv[2] !== "--fallback" ? process.argv[2] : DEFAULT_MODEL)
if (!["lmstudio", "ollama", "vllm"].includes(model.providerID)) throw new Error("Quality check permits local providers only")
const messages: SessionMessageInfo[] = [
  { id: "u1", type: "user", time: { created: 1 }, text: "Implement next-word autocomplete and fallback on our plugin." },
  { id: "a1", type: "assistant", agent: "build", model, time: { created: 2, completed: 3 }, finish: "stop", content: [{ type: "text", text: "Next-word mode works: Add reg gets regression, and Tab inserts only the rest of regression. All 97 tests pass. Regression tests cover the parser and regression completion. Implemented and enabled. The fallback is Qwen, local Granite, then the coding model. Nothing has been committed or published." }] },
]
const results = []
for (const draft of ["commit and ", "commit and op", "commit and open ", "Please update the doc", "Add reg"]) {
  const started = performance.now()
  let used = model
  const output = await generateWithFallback({
    models: fallback ? modelChain(model, [parseModel("lmstudio/ibm/granite-4.1-8b")]) : [model],
    signal: AbortSignal.timeout(15000), timeoutMs: 5000,
    generate: async (candidate, signal) => {
      used = candidate
      const text = (await client.generate.text({ model: candidate, prompt: wordPrompt(messages, draft) }, { signal })).text
      if (fallback && !wordCompletion(text, draft) && !wordAbstains(text)) throw new Error("Unusable completion")
      return text
    },
  })
  const result = { model: `${used.providerID}/${used.id}`, draft, output, completion: wordCompletion(output, draft), elapsedMs: Math.round(performance.now() - started) }
  results.push(result)
  console.log(JSON.stringify(result))
}
await Bun.write(new URL("./artifacts/word-quality.json", import.meta.url), JSON.stringify(results, null, 2))
