import type { ModelRef } from "@opencode/client"

export function localModel(model: ModelRef) {
  return ["lmstudio", "ollama", "vllm"].includes(model.providerID)
}

export function modelChain(primary: ModelRef, locals: readonly ModelRef[], session?: ModelRef) {
  const seen = new Set<string>()
  const alternate = locals.find((model) => localModel(model) && (model.providerID !== primary.providerID || model.id !== primary.id || model.variant !== primary.variant))
  return [primary, ...(alternate ? [alternate] : []), ...(session ? [session] : [])].filter((model) => {
    const key = JSON.stringify([model.providerID, model.id, model.variant])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function generateWithFallback(options: {
  models: readonly ModelRef[]
  timeoutMs: number
  signal: AbortSignal
  generate: (model: ModelRef, signal: AbortSignal) => Promise<string>
  fallback?: (model: ModelRef) => void
}) {
  for (const [index, model] of options.models.entries()) {
    options.signal.throwIfAborted()
    const controller = new AbortController()
    const abort = () => controller.abort(options.signal.reason)
    options.signal.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error("Autocomplete model deadline exceeded")), options.timeoutMs)
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })
    })
    try {
      if (index) options.fallback?.(model)
      return await Promise.race([
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted()
          return options.generate(model, controller.signal)
        }), cancelled,
      ])
    } catch {
      // Cancellation is not a reason to disclose a draft to the next provider.
      options.signal.throwIfAborted()
    } finally {
      clearTimeout(timer)
      options.signal.removeEventListener("abort", abort)
    }
  }
  throw new Error("All configured autocomplete models failed")
}
