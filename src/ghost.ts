import type { CliRenderer, EditBufferRenderable, OptimizedBuffer, RGBA } from "@opentui/core"

export type PromptEditor = EditBufferRenderable

// Host-specific adapter: OpenCode 2.0.25 tags its main prompt with these traits.
// Avoid instanceof: the host and plugin may load different copies of OpenTUI.
export function promptEditor(renderer: CliRenderer): PromptEditor | undefined {
  const editor = renderer.currentFocusedEditor
  if (!editor || editor.isDestroyed) return
  const traits = editor.traits as typeof editor.traits & { owner?: string; role?: string }
  if (traits.owner !== "opencode" || traits.role !== "prompt") return
  return editor
}

export function createGhost(options: {
  renderer: CliRenderer
  suggestion: () => string
  enabled: () => boolean
  color: RGBA
  background: RGBA
  consumed?: () => void
  accepted?: (previousDraft: string) => void
  dismissed?: () => void
}) {
  const dismissed = new WeakMap<PromptEditor, string>()
  let disposed = false

  function current() {
    if (disposed || !options.enabled()) return
    const editor = promptEditor(options.renderer)
    if (!editor || !editor.focused || !editor.visible || editor.hasSelection()) return
    // suspend=true is normal: the host keymap owns the native textarea keys.
    if (editor.traits.status === "SHELL" || editor.traits.capture?.includes("escape")) return
    const text = editor.plainText
    if (dismissed.has(editor) && dismissed.get(editor) !== text) dismissed.delete(editor)
    if (dismissed.get(editor) === text) return
    // Leave all mention, command, and shell completion to OpenCode.
    if (/^[\/!]/.test(text) || /(?:^|\s)@\S*$/.test(text)) return
    const cursor = editor.logicalCursor
    if (cursor.row !== editor.lineCount - 1 || cursor.col !== editor.editBuffer.getEOL().col) return
    const suggestion = options.suggestion()
    if (!suggestion.startsWith(text) || suggestion.length <= text.length) return
    const visual = editor.visualCursor
    if (visual.visualCol >= editor.width || visual.visualRow >= editor.height) return
    return { editor, suffix: suggestion.slice(text.length), text, visual }
  }

  function draw(buffer: OptimizedBuffer) {
    const state = current()
    if (!state) return
    const x = state.editor.x + state.visual.visualCol
    const y = state.editor.y + state.visual.visualRow
    const width = Math.min(state.editor.width - state.visual.visualCol, buffer.width - x)
    if (x < 0 || y < 0 || y >= buffer.height || width <= 0) return
    // Clip to the input's current visual row. Never paint over chrome/other panes.
    // Empty prompts have a host placeholder; erase only that input row.
    buffer.pushScissorRect(x, y, width, 1)
    buffer.fillRect(x, y, width, 1, options.background)
    buffer.drawText(state.suffix.split(/\r?\n/, 1)[0]!, x, y, options.color, options.background)
    buffer.popScissorRect()
  }

  options.renderer.addPostProcessFn(draw)
  options.renderer.requestRender()

  return {
    available: () => !!current(),
    accept() {
      const state = current()
      if (!state) return false as const
      // Insertion preserves attachment extmarks and undo; setText would reset both.
      state.editor.insertText(state.suffix)
      options.accepted?.(state.text)
      options.consumed?.()
      options.renderer.requestRender()
    },
    dismiss() {
      const state = current()
      if (!state) return false as const
      // A prediction controller consumes per-turn state itself; don't carry an
      // empty-draft dismissal into a later turn on the same editor.
      if (!options.consumed && !options.dismissed) dismissed.set(state.editor, state.text)
      options.dismissed?.()
      options.consumed?.()
      options.renderer.requestRender()
    },
    dispose() {
      disposed = true
      options.renderer.removePostProcessFn(draw)
      options.renderer.requestRender()
    },
  }
}
