# OpenCode Ghost Text

An experimental OpenCode V2 terminal plugin that suggests your next prompt as muted inline text. Press **Tab** to turn it into an editable draft; nothing is sent until you submit it yourself.

Independently built with goals similar to [existing next-prompt plugins](#related-projects). This is not an official OpenCode component or a claim to a new kind of autocomplete.

## Features

- Predicts one likely follow-up after an assistant turn, or when opening a completed conversation with an empty draft.
- Paints a preview at the editor's visual cursor without putting it into the draft, selection, or undo history.
- Empty field: **Tab** accepts the whole next-prompt suggestion. Once you type: a fresh draft-aware prediction completes **one word** at a time.
- **Escape** dismisses/cancels. Clearing the field restores the cached full-prompt suggestion for that turn.
- Lets you choose an autocomplete model independently of your coding model.
- Uses OpenCode's generation infrastructure, not direct provider API calls. Optional fallback tries a configured local alternate, then your current coding model.

**Tested compatibility: OpenCode 2.0.25 and OpenTUI 0.5.16.** Other versions require verification; this is experimental, not production-hardened.

## Install from source

You need [Bun](https://bun.sh), a compatible OpenCode installation, and a text-generation model configured in OpenCode.

Source repository: <https://github.com/rlueder/opencode-ghost-text>. There is **no published npm package**.

```sh
git clone https://github.com/rlueder/opencode-ghost-text.git
cd opencode-ghost-text
bun install
pwd
```

Add an entry to the existing `plugins` array in `~/.config/opencode/cli.json`, preserving your other settings and plugins. If `XDG_CONFIG_HOME` is set, use `$XDG_CONFIG_HOME/opencode/cli.json` instead. Replace the example path with the absolute checkout directory printed by `pwd`, **not** its `src` directory or a file path.

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-ghost-text",
      "options": {
        "model": "lmstudio/qwen/qwen3-4b-2507",
        "timeoutMs": 10000
      }
    }
  ]
}
```

Restart the OpenCode terminal client. This is a CLI-only plugin: configure it in `cli.json`, not the server's `opencode.json`. The root `tui.ts` provides local-directory discovery.

### Git package alternative

Current [OpenCode V2 package documentation](https://opencode.ai/v2/docs/plugins#manage) supports GitHub package specifications, and [CLI plugins](https://opencode.ai/v2/docs/cli/plugins) belong in `cli.json`. An alternative entry is:

```json
{
  "plugins": ["github:rlueder/opencode-ghost-text"]
}
```

This Git-package route has **not been smoke-tested with this project on 2.0.25**; the local-checkout recipe above is the verified development route. Do not register both copies. Pin a full commit with `#<full-commit-hash>` for reproducibility.

## Use it

Open a conversation and let the assistant finish. With the normal prompt empty, a suggestion may appear—for example, `Add regression tests.`

| Action | Result |
| --- | --- |
| **Tab**, empty field | Inserts the full next-prompt suggestion as editable text. Does not submit. |
| Type `Add reg`, pause, then **Tab** | Requests a fresh word prediction, such as `regression`, and inserts only the missing `ression`. |
| **Tab**, nonempty field | Accepts one predicted word; another prediction can follow after the idle delay. |
| **Escape** | Dismisses the preview or cancels pending generation. |
| Type any response, such as `Actually check ` | Predicts the next word from that actual draft, not from the cached full sentence. |
| Type different text, then clear the draft | Hides, then restores a ready cached suggestion without another model call. |
| **Ctrl+P** → **Ghost text: choose model** | Selects and saves an autocomplete model. |
| **Ctrl+P** → **Ghost text: refresh suggestion** | Requests another prediction for the current completed turn. |

Enter submits only real draft text, never the unaccepted preview. Clearing a nonempty draft can also restore an accepted or dismissed full-prompt suggestion for the same turn. If typing canceled that full-prompt request before it finished, there is no cached result to restore; use refresh. Accepting a whole prompt waits for another edit before offering words, rather than extending the accepted sentence automatically.

Word requests wait for **500ms of idle time**, with at least **1000ms between dispatches**. Each edit cancels and invalidates the old result, even when you edit away and back to the same text. Predictions require an eligible completed conversation, the cursor at the end, and no selection. Whitespace-only drafts, commands, mentions, and drafts over 2000 JavaScript string units do not trigger word generation.

The overlay yields to shell mode, command/mention completion, selections, cursor movement away from the end, and other focused editors. A suggestion is optional: errors, timeouts, or an unusable model response leave normal input available.

## Choose an autocomplete model

The default is **`lmstudio/qwen/qwen3-4b-2507`**, separate from your coding model. Start the LM Studio server, load that model, and make its provider/model available to the **connected OpenCode server**. Installing this plugin does not configure LM Studio, endpoints, or credentials. With remote OpenCode, a local endpoint must be reachable from that server, not merely from your terminal machine.

The palette picker uses OpenCode's model catalog and saves your choice in plugin storage without changing the coding model. An explicit `options.model` takes precedence over the saved choice **on reload**. Omit `model` if you want the saved palette choice to persist as the effective selection; otherwise the local default applies when no choice is saved.

`model` accepts `providerID/modelID`; model IDs may contain `/`. A `#variant` suffix is not supported in plugin model strings. An inherited session-model reference may include a variant. `timeoutMs` defaults to `10000` **per model attempt** and is clamped to 100–60000 milliseconds.

Optional `wordModel` selects a different model for typed completions; otherwise they use the same model. For example, `"wordModel": "lmstudio/ibm/granite-4.1-8b"` keeps a lighter Qwen model for empty-field prompts but uses Granite for partial-word completion. An explicit `wordModel` is not changed by the primary-model picker. For typed requests, the primary autocomplete model is considered as a local alternate before `fallbackModels`; duplicates and nonlocal alternate providers are skipped. Predictions are probabilistic: `commit and ` can reasonably become `push`; the additional prefix `op` constrains it toward `open`, not a guaranteed intended phrase.

Fallback is **disabled unless configured**. Provider availability for normal chat does not guarantee stateless generation works. Project-only providers may appear in the picker but fail the server-global generation endpoint; configure them globally. If local-model discovery is still starting, wait and refresh.

### Optional local then coding-model fallback

```json
{
  "package": "/absolute/path/to/opencode-ghost-text",
  "options": {
    "model": "lmstudio/qwen/qwen3-4b-2507",
    "fallbackModels": ["lmstudio/ibm/granite-4.1-8b"],
    "fallbackToSessionModel": true,
    "timeoutMs": 10000,
    "wordPrediction": true,
    "wordModel": "lmstudio/ibm/granite-4.1-8b",
    "wordTimeoutMs": 3000,
    "wordDebounceMs": 500,
    "wordCooldownMs": 1000
  }
}
```

Order: **selected autocomplete model → first distinct configured local alternate → current session coding model**. Duplicate model references are skipped. `fallbackModels` accepts `lmstudio`, `ollama`, or `vllm` references; the provider endpoint must actually be local if local-only processing is required. Only one local alternate is used, for at most three attempts. No attempt ever omits the model to use an unrelated server default.

**Privacy/cost:** `fallbackToSessionModel: true` explicitly permits conversation text **and the current typed draft** to go to your coding model, which may be cloud-hosted and billed. Omit/set it to `false` for local-only fallback. A toast identifies a fallback model when first used in that client instance. The coding model itself is never changed.

API/transport errors and per-model timeouts advance the chain. In typed-word mode, malformed completions, a rewritten prefix, or an unchanged draft also try the next model. Explicit `NONE`/empty abstention never escalates; rejected full-prompt text does not escalate either. User cancellation stops the entire chain, including pending cloud fallback. Full-prompt attempts use `timeoutMs`; word attempts use `wordTimeoutMs` (default 3000ms, range 100–20000). Up to three sequential attempts may therefore take roughly 30s / 9s respectively. There is no background retry loop. Set `wordPrediction: false` to disable typed-word inference.

## Context, privacy, and request limits

Prediction uses `context.client.generate.text`: no agent session is created, no tools run, and prediction does not append to the conversation history or change the session model.

- Context contains **at most six recent user/assistant text messages**, bounded to **6000 text characters total** and **2000 per message**, retaining message endings. These bounds use JavaScript string lengths, not tokens; instructions and JSON serialization add overhead.
- Tool calls/results, reasoning, original system instructions, and file/image attachments are not separately included. **Plain pasted text is still chat text** and can be included, as can sensitive material quoted in ordinary messages. This is not a redaction system or a guarantee about OpenCode/provider logging.
- Full-prompt generation normally runs once per eligible completed turn. Typed-word requests include **earlier user text only** plus the actual draft, capped at **2000 JavaScript string units**; assistant explanations/examples are excluded to reduce topic copying. Manual refresh and model changes allow another attempt. Ready full-prompt predictions are cached in memory; word predictions are regenerated for each settled draft revision.
- Typing during generation, changing sessions/models, starting another turn, opening another input mode, or unloading invalidates pending results. Each fallback attempt has its own deadline. Cancellation does not guarantee the server/provider immediately stops inference or billing.
- Full prompts request one line under 160 characters and reject responses over 240 Unicode code points. An assistant-echo heuristic rejects copied/near-copied sentences, but cannot ensure semantic quality. Typed mode internally generates a short natural completion preserving the exact draft prefix, then displays/inserts **only the first missing word** (at most 100 JavaScript string units). New continuation text is bounded to 240 units. **Neither validation nor context bounds guarantees a backend output-token cap** on OpenCode 2.0.25.

## Compatibility and limitations

The renderer adapter relies on OpenCode 2.0.25's focused-editor traits and OpenTUI frame post-processing. Host integration can change between releases; there is no full-version compatibility guarantee.

Ghost text is clipped to the remaining width of the **current input row**. It follows wrapped real input and resize but does not allocate extra ghost rows; Tab can insert more text than the clipped preview shows. Its background assumes the host's default prompt styling. Other renderer plugins or customized prompt styling can conflict.

The preview is pixels, not accessibility or selectable text. Accessibility, IME composition, all attachment workflows, and interactions with every other plugin have not been verified. Treat suggestions as untrusted text and review before submitting.

## Development and verification

```sh
bun test
bun typecheck
```

The tests cover prediction state/cancellation and actual OpenTUI 0.5.16 native rendering, including insertion, Unicode positioning, clipping, and host-completion guards. They do not require model credentials.

An optional Unix PTY smoke test needs `opencode`, Python, and `uv`:

```sh
uv run --with pyte python spike/smoke.py
```

By default it uses a fixed demo suggestion, sends no chat prompts or prediction requests, and checks Tab insertion, undo, Escape, and the palette. Process-local CLI settings override the plugin list for that run; captures go to ignored `spike/artifacts/`.

The separate `spike/model-fixture.ts` / `GHOST_TEST_SESSION` flow is a **live synthetic-conversation** check that makes real generation requests and creates/removes test sessions. It requires a running local OpenCode service with the Qwen/Granite models used by the fixture; inspect and adapt it before use. Deterministic test success does not establish live model quality or compatibility on other versions.

## Related projects

- [ozandogrultan/opencode-ghost](https://github.com/ozandogrultan/opencode-ghost): a direct V2 equivalent with model-generated next-message placeholders, Tab/Right acceptance, separate model configuration, and clear-to-restore behavior. Its [1.3.10 release manifest](https://github.com/ozandogrultan/opencode-ghost/blob/v1.3.10/package.json) targets OpenCode ≥2.0.25; newer releases have different requirements.
- [lenitain/opencode-next-prompt](https://github.com/lenitain/opencode-next-prompt): a published [V2 next-message predictor](https://github.com/lenitain/opencode-next-prompt/blob/5fc83a67319320366fc2f4efba065fd2f4dbaab0/README.md) with gray placeholders, configurable model/accept key, Right acceptance by default, and clear-to-restore behavior.

This project is an independent implementation with similar goals, not the first or only OpenCode next-prompt plugin. Another related project is [pank-su/opencode-prompt-completion](https://github.com/pank-su/opencode-prompt-completion), which supports typed-draft completion and word acceptance with different defaults.

## License

[MIT](LICENSE).
