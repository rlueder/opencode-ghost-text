import { Plugin } from "@opencode/plugin/tui"
import { createGhost, promptEditor } from "./ghost.tsx"
import { appendFileSync } from "node:fs"
import { createEffect, createRoot } from "solid-js"
import { cleanPrediction, conversation, createPredictor, DEFAULT_MODEL, parseModel, predictionPrompt } from "./prediction"
import type { ModelRef } from "@opencode/client"
import { createWordPredictor, wordAbstains, wordCompletion, wordPrompt } from "./word"
import { generateWithFallback, localModel, modelChain } from "./fallback"

export default Plugin.define({
  id: "rafael.ghost-text-spike",
  setup(context) {
    const [settings, saveSettings] = context.storage.store("prediction-settings", { initial: { model: "" } })
    let selected = typeof context.options.model === "string" ? context.options.model : settings.model || DEFAULT_MODEL
    const wordModel = typeof context.options.wordModel === "string" ? context.options.wordModel : undefined
    const timeoutMs = typeof context.options.timeoutMs === "number" && Number.isFinite(context.options.timeoutMs)
      ? Math.max(100, Math.min(60000, context.options.timeoutMs)) : 10000
    const demo = typeof context.options.suggestion === "string" ? context.options.suggestion : undefined
    const wordTimeoutMs = typeof context.options.wordTimeoutMs === "number" && Number.isFinite(context.options.wordTimeoutMs)
      ? Math.max(100, Math.min(20000, context.options.wordTimeoutMs)) : 3000
    const debounceMs = typeof context.options.wordDebounceMs === "number" && Number.isFinite(context.options.wordDebounceMs)
      ? Math.max(100, Math.min(5000, context.options.wordDebounceMs)) : 500
    const cooldownMs = typeof context.options.wordCooldownMs === "number" && Number.isFinite(context.options.wordCooldownMs)
      ? Math.max(100, Math.min(10000, context.options.wordCooldownMs)) : 1000
    const localFallbacks = Array.isArray(context.options.fallbackModels)
      ? context.options.fallbackModels.filter((value): value is string => typeof value === "string").map(parseModel) : []
    if (localFallbacks.some((model) => !localModel(model))) throw new Error("fallbackModels must use lmstudio, ollama, or vllm providers")
    const fallbackNotices = new Set<string>()
    let warned = false
    const failed = () => {
      if (warned) return
      warned = true
      context.ui.toast.show({ message: "Ghost text: configured models unavailable. Choose a model or refresh from the command palette.", variant: "warning" })
    }
    async function generate(input: { sessionID: string; turnID: string; model: ModelRef; signal: AbortSignal; draft?: string }) {
      const messages = context.data.session.message.list(input.sessionID)
      const turn = messages.findIndex((message) => message.id === input.turnID)
      if (turn < 0) return ""
      const captured = messages.slice(0, turn + 1)
      const latestAssistantText = conversation(captured).findLast((message) => message.role === "assistant")?.text
      const sessionModel = context.options.fallbackToSessionModel === true ? context.data.session.get(input.sessionID)?.model : undefined
      const models = modelChain(input.model, input.draft === undefined ? localFallbacks : [parseModel(selected), ...localFallbacks], sessionModel)
      const prompt = input.draft === undefined ? predictionPrompt(captured) : wordPrompt(captured, input.draft)
      const output = await generateWithFallback({
        models, signal: input.signal, timeoutMs: input.draft === undefined ? timeoutMs : wordTimeoutMs,
        generate: async (model, signal) => {
          const text = (await context.client.generate.text({ model, prompt }, { signal })).text
          if (input.draft !== undefined && !wordCompletion(text, input.draft) && !wordAbstains(text)) {
            throw new Error("Unusable or unchanged word completion")
          }
          return text
        },
        fallback: (model) => {
          const name = `${model.providerID}/${model.id}`
          if (fallbackNotices.has(name)) return
          fallbackNotices.add(name)
          context.ui.toast.show({ message: `Ghost text using ${localModel(model) ? "local" : "coding-model"} fallback: ${name}`, variant: "info" })
        },
      })
      return input.draft === undefined ? cleanPrediction(output, latestAssistantText) : output
    }
    const predictor = createPredictor({
      model: parseModel(selected),
      timeoutMs: timeoutMs * 3 + 250,
      generate,
      changed: () => context.renderer.requestRender(),
      failed,
    })
    const words = createWordPredictor({
      model: parseModel(wordModel ?? selected), debounceMs, cooldownMs, timeoutMs: wordTimeoutMs * 3 + 250,
      generate, changed: () => context.renderer.requestRender(), failed,
    })
    let watched: ReturnType<typeof promptEditor>
    let fallbackSession: string | undefined
    let fallbackModel = ""
    const contentChanged = () => observe()
    function observe() {
      const editor = promptEditor(context.renderer)
      if (editor !== watched) {
        watched?.editBuffer.off("content-changed", contentChanged)
        watched?.editBuffer.off("cursor-changed", contentChanged)
        watched = editor
        watched?.editBuffer.on("content-changed", contentChanged)
        watched?.editBuffer.on("cursor-changed", contentChanged)
      }
      const route = context.ui.router.current()
      const sessionID = route.type === "session" ? route.sessionID : undefined
      const outcome = sessionID ? context.data.session.get(sessionID)?.outcome : undefined
      const codingModel = JSON.stringify(sessionID ? context.data.session.get(sessionID)?.model : null)
      if (context.options.fallbackToSessionModel === true && fallbackSession === sessionID && fallbackModel && fallbackModel !== codingModel) {
        predictor.refresh()
        words.refresh()
      }
      fallbackSession = sessionID
      fallbackModel = codingModel
      const messages = sessionID ? context.data.session.message.list(sessionID) : []
      const last = messages.findLast((message) => message.type === "user" || message.type === "assistant")
      const turnID = last?.type === "assistant" && last.time.completed && !last.error && last.finish !== "tool-calls" && last.finish !== "error" ? last.id : undefined
      const state = {
        sessionID,
        turnID,
        busy: !!sessionID && context.data.session.status(sessionID) !== "idle",
        draft: editor?.plainText ?? "",
        eligible: demo === undefined && !!editor && context.keymap.mode.current() === "base" && route.type === "session"
          && outcome !== "failed" && outcome !== "interrupted"
          && editor.traits.status !== "SHELL" && !editor.traits.capture?.includes("escape"),
      }
      predictor.observe(state)
      const cursor = editor?.logicalCursor
      const atEnd = !!editor && cursor?.row === editor.lineCount - 1 && cursor.col === editor.editBuffer.getEOL().col
      words.observe({ ...state, eligible: state.eligible && context.options.wordPrediction !== false && atEnd && !editor?.hasSelection() })
    }
    context.renderer.addPostProcessFn(observe)
    const disposeEffect = createRoot((dispose) => {
      createEffect(observe)
      return dispose
    })
    const stops = [
      context.data.on("session.execution.started", (event) => {
        const route = context.ui.router.current()
        if (route.type !== "session" || route.sessionID !== event.data.sessionID) return
        predictor.observe({ sessionID: route.sessionID, busy: true, eligible: false, draft: "" })
        words.observe({ sessionID: route.sessionID, busy: true, eligible: false, draft: "" })
      }),
      context.data.on("session.execution.succeeded", () => {
        // Allow the host's message/status cache to settle before reading it.
        context.renderer.requestRender()
      }),
    ]
    let previous = ""
    const diagnostic = () => {
      if (typeof context.options.debug !== "string") return
      const editor = context.renderer.currentFocusedEditor
      const value = JSON.stringify({
        version: context.app.version,
        mode: context.keymap.mode.current(),
        route: context.ui.router.current().type,
        predictionLength: suggestion().length,
        predictionKind: promptEditor(context.renderer)?.plainText ? "word" : "prompt",
        editor: editor && { focused: editor.focused, visible: editor.visible, traits: editor.traits,
          x: editor.x, y: editor.y, width: editor.width, height: editor.height, cursor: editor.visualCursor },
      })
      if (value !== previous) appendFileSync(context.options.debug, value + "\n")
      previous = value
    }
    context.renderer.addPostProcessFn(diagnostic)
    function suggestion() {
      if (demo !== undefined) return demo
      return promptEditor(context.renderer)?.plainText ? words.value() : predictor.value()
    }
    function dismiss() {
      predictor.consume()
      words.suppress()
    }
    const ghost = createGhost({
      renderer: context.renderer,
      suggestion,
      accepted: demo === undefined ? (previousDraft) => {
        if (previousDraft) return // the content-change listener schedules the next word
        predictor.consume()
        words.suppress() // a full-prompt acceptance waits for a subsequent edit
      } : undefined,
      dismissed: demo === undefined ? dismiss : undefined,
      enabled: () => {
        const route = context.ui.router.current()
        return context.keymap.mode.current() === "base" && (
          route.type === "home" || (route.type === "session" && context.data.session.status(route.sessionID) === "idle")
        )
      },
      color: context.theme.text.muted,
      background: context.theme.decrease(context.theme.background.raised.base),
    })
    context.keymap.layer(() => ({
      priority: 100,
      commands: [
        { id: "ghost.accept", title: "Accept inline suggestion", bind: "tab", run: ghost.accept },
        { id: "ghost.dismiss", title: "Dismiss inline suggestion", bind: "escape", run: () => {
          const result = ghost.dismiss()
          dismiss()
          return result
        } },
      ],
    }))
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "ghost.model", title: "Ghost text: choose model", palette: true,
          run: async () => {
            const result = await context.client.model.list({ location: context.location ?? context.data.location.default() })
            const choice = await context.ui.dialog.select({
              title: "Autocomplete model (independent of your coding model)",
              current: selected,
              options: result.data.filter((model) => model.enabled && model.capabilities.output.includes("text")).map((model) => ({
                title: model.name, value: `${model.providerID}/${model.id}`, category: model.providerID,
                description: `${model.providerID}/${model.id}`,
              })),
            })
            if (!choice) return
            selected = choice
            warned = false
            predictor.setModel(parseModel(choice))
            words.setModel(parseModel(wordModel ?? choice))
            await saveSettings((draft) => { draft.model = choice })
            context.ui.toast.show({ message: `Autocomplete model: ${choice}`, variant: "success" })
          },
        },
        { id: "ghost.refresh", title: "Ghost text: refresh suggestion", palette: true, run: () => { predictor.refresh(); words.refresh() } },
      ],
    }))
    return () => {
      disposeEffect()
      stops.forEach((stop) => stop())
      watched?.editBuffer.off("content-changed", contentChanged)
      watched?.editBuffer.off("cursor-changed", contentChanged)
      context.renderer.removePostProcessFn(observe)
      predictor.dispose()
      words.dispose()
      context.renderer.removePostProcessFn(diagnostic)
      ghost.dispose()
    }
  },
})
