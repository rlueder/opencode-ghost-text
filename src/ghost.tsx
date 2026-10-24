import { TextRenderable } from "@opentui/core"
import type { CliRenderer, EditBufferRenderable, RGBA, Renderable } from "@opentui/core"

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
  let attached: { editor: PromptEditor; parent: Renderable; preview: TextRenderable; text: string; ready: boolean } | undefined

  function current(checkOcclusion = true) {
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
    const x = editor.x + visual.visualCol
    const y = editor.y + visual.visualRow
    const end = Math.min(editor.x + editor.width, options.renderer.width)
    if (x < 0 || y < 0 || y >= options.renderer.height || x >= end) return
    // Check the completed frame before accepting text: overlays can begin after
    // the cursor. The preview shares its editor's scene parent, not a global painter.
    if (checkOcclusion) {
      if (attached?.editor !== editor || !attached.ready || !attached.preview.visible) return
      for (let col = x; col < end; col++) {
        const owner = options.renderer.hitTest(col, y)
        if (owner !== editor.num && !(attached?.editor === editor && owner === attached.preview.num)) return
      }
    }
    return { editor, suffix: suggestion.slice(text.length), text, visual }
  }

  function detach() {
    if (!attached) return
    if (!attached.preview.isDestroyed) attached.preview.destroy()
    attached = undefined
  }
  function observe(afterLayout = false) {
    const editor = promptEditor(options.renderer)
    if (attached?.editor !== editor || attached?.parent !== editor?.parent) detach()
    if (disposed || !editor?.parent) return
    if (!attached) {
      const preview = new TextRenderable(options.renderer, {
        position: "absolute", left: 0, top: 0, width: 1, height: 1,
        fg: options.color, bg: options.background, wrapMode: "none",
        selectable: false, visible: false, zIndex: editor.zIndex,
      })
      editor.parent.add(preview)
      attached = { editor, parent: editor.parent, preview, text: "", ready: false }
    }
    if (afterLayout) attached.ready = true
    const state = current(false)
    const preview = attached.preview
    preview.visible = !!state && attached.ready
    if (!state) return
    preview.left = state.editor.x - attached.parent.x + state.visual.visualCol
    preview.top = state.editor.y - attached.parent.y + state.visual.visualRow
    preview.zIndex = state.editor.zIndex
    preview.width = state.editor.width - state.visual.visualCol
    const text = state.suffix.split(/\r?\n/, 1)[0]!
    if (attached.text !== text) {
      preview.content = text
      attached.text = text
    }
  }
  const beforeFrame = async () => observe()
  const afterFrame = () => observe(true)
  observe()
  options.renderer.setFrameCallback(beforeFrame)
  // Recheck layout after resize. This only updates a scene node for the next
  // frame; it never writes onto the fully composed buffer.
  options.renderer.addPostProcessFn(afterFrame)
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
      options.renderer.removePostProcessFn(afterFrame)
      options.renderer.removeFrameCallback(beforeFrame)
      detach()
      options.renderer.requestRender()
    },
  }
}
