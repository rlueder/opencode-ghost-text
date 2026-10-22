// Synthetic conversation for the real-model PTY check; never copies user chats.
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { DEFAULT_MODEL, parseModel, predictionPrompt, cleanPrediction } from "../src/prediction"
import { wordPrompt, wordCompletion } from "../src/word"
import { homedir } from "node:os"
import { join } from "node:path"

const endpoint = await Service.discover()
if (!endpoint) throw new Error("Start OpenCode's service first")
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
const file = Bun.file(new URL("./artifacts/model-fixture.json", import.meta.url))
if (process.argv[2] === "cleanup") {
  const fixture = await file.json()
  if (!fixture.sessionID.startsWith("ses_ghost_test_")) throw new Error("Refusing to remove a non-fixture session")
  await client.session.remove({ sessionID: fixture.sessionID })
  console.log("Removed synthetic autocomplete test session")
  process.exit(0)
}

// Initialize OpenCode's global catalog before the stateless generation route.
await client.model.list({ location: { directory: join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode") } })
const template = await client.session.create({ title: "Autocomplete test template", location: { directory: process.cwd() }, model: parseModel(DEFAULT_MODEL) })
const sessionID = `ses_ghost_test_${crypto.randomUUID().replaceAll("-", "")}`
const now = Date.now()
const messages = [
  { id: `msg_${crypto.randomUUID().replaceAll("-", "")}`, type: "user" as const, time: { created: now - 2000 }, text: "Fix the parser bug. Then I want regression tests; pause and ask for confirmation before adding them." },
  { id: `msg_${crypto.randomUUID().replaceAll("-", "")}`, type: "assistant" as const, agent: "build", model: parseModel(DEFAULT_MODEL), time: { created: now - 1000, completed: now }, finish: "stop" as const, content: [{ type: "text" as const, text: "The parser bug is fixed. Would you like me to add regression tests?" }] },
]
try {
  const predicted = await client.generate.text({ model: parseModel(DEFAULT_MODEL), prompt: predictionPrompt(messages) }, { signal: AbortSignal.timeout(30000) })
  if (!cleanPrediction(predicted.text)) throw new Error("Local model returned no usable prediction")
  console.log("Local model returned a usable next-prompt suggestion through OpenCode")
  const word = await client.generate.text({ model: parseModel("lmstudio/ibm/granite-4.1-8b"), prompt: wordPrompt(messages, "Add reg") }, { signal: AbortSignal.timeout(30000) })
  if (wordCompletion(word.text, "Add reg") !== "Add regression") throw new Error(`Unexpected local word output: ${JSON.stringify(word.text)}`)
  console.log("Local model completed a partial word through OpenCode")
  await client.session.import({ info: { ...template, id: sessionID, title: "Ghost text integration fixture", outcome: "succeeded", time: { created: now, updated: now, idle: now } }, messages })
  await Bun.write(file, JSON.stringify({ sessionID }))
  console.log(`Fixture ready: ${sessionID}`)
} finally {
  // Only this script's newly created empty template is removed.
  await client.session.remove({ sessionID: template.id })
}
