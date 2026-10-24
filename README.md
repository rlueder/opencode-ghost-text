# OpenCode Ghost Text

Inline AI suggestions for the OpenCode terminal: a full prompt when the field is empty, or the next word while you type. **Tab** accepts; **Escape** dismisses. Suggestions are never submitted automatically.

Experimental. Tested with **OpenCode 2.0.25 / OpenTUI 0.5.16**.
The scene preview also has a cross-plugin rendering test against OpenTUI 0.6.8
and has loaded successfully in OpenCode 2.1.3. Live model behavior is separate
from these rendering checks.

## Installation

Requires [Bun](https://bun.sh) and a text-generation model configured in OpenCode. No npm package is published yet.

```sh
git clone https://github.com/rlueder/opencode-ghost-text.git
cd opencode-ghost-text
bun install
```

Add this to your existing `~/.config/opencode/cli.json`, replacing the path with your checkout's absolute path:

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-ghost-text",
      "options": {
        "model": "lmstudio/qwen/qwen3-4b-2507",
        "wordModel": "lmstudio/ibm/granite-4.1-8b"
      }
    }
  ]
}
```

Restart OpenCode. These example models require LM Studio running and accessible to your OpenCode server; you can use other configured models instead. With `XDG_CONFIG_HOME`, the config lives under `$XDG_CONFIG_HOME/opencode/`.

## Usage

| Action | Result |
| --- | --- |
| **Tab** in an empty field | Accept the full suggested prompt. |
| Type, pause, then **Tab** | Accept the next predicted word, e.g. `commit and op` → `commit and open`. |
| **Escape** | Dismiss or cancel the suggestion. |
| Clear the field | Restore a ready full-prompt suggestion for the current turn. |
| **Ctrl+P → Ghost text: choose model** | Change the autocomplete model without changing your coding model. |
| **Ctrl+P → Ghost text: refresh suggestion** | Request another suggestion. |

Typed predictions wait for a 500ms pause. Normal typing, shell commands, and OpenCode's own completions take priority.

## Models and fallback

`model` selects full-prompt prediction; optional `wordModel` selects typed completion. Omit `model` to retain your saved picker choice across restarts; explicit configuration overrides it on reload.

Fallback is **off by default**. To enable it, add these options:

```json
"fallbackModels": ["lmstudio/ibm/granite-4.1-8b"],
"fallbackToSessionModel": true
```

Requests try the selected model, one distinct local alternate, then the current coding model. Typed mode considers the full-prompt model as a local alternate first. **The coding-model fallback may send your conversation and typed draft to a paid cloud provider.** Leave `fallbackToSessionModel` off for local-only fallback.

Other options: `wordPrediction` (default `true`), `timeoutMs` (10000 per model), `wordTimeoutMs` (3000), `wordDebounceMs` (500), and `wordCooldownMs` (1000).

## Privacy and limitations

- Uses OpenCode's model infrastructure; no prediction agent sessions or tools are created.
- Sends bounded chat text (up to six messages / 6000 characters) and, for typed completion, your draft (up to 2000 characters). Typed mode excludes assistant text. Pasted secrets are **not** redacted.
- Predictions can be wrong. Preview is clipped to the current row; IME, accessibility, and other OpenCode versions are not fully verified.
- Preview text shares the editor's normal scene layer, so notifications and dialogs paint above it. Tab cannot accept a suggestion while any part of its row is covered. It becomes available again after the covering UI closes.
- Cancellation discards stale suggestions but cannot guarantee provider inference or billing stops immediately. Output validation is not a backend token limit.

## Development

```sh
bun test
bun typecheck
```

Related projects: [opencode-ghost](https://github.com/ozandogrultan/opencode-ghost), [opencode-next-prompt](https://github.com/lenitain/opencode-next-prompt), and [opencode-prompt-completion](https://github.com/pank-su/opencode-prompt-completion).

[MIT License](LICENSE)
