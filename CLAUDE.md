# CLAUDE.md

## Project Overview

**Data** is an LLM-powered Slack chatbot with a Star Trek personality (Lt. Commander Data). It uses the Slack Bolt framework with **Ollama** (default) or **Gemini** as the chat backend, and Gemini (Nano Banana 2) for image generation.

The chat layer talks to each provider's native SDK — no OpenAI chat/completions compatibility shim. Conversation history is owned by the bot (persisted in Redis via Keyv), not by the LLM provider.

## Quick Reference

```bash
npm install      # Install dependencies
npm start        # Run the bot
npm test         # Run tests (node --test)
npm run lint     # Check code style
npm run lint:fix # Auto-fix linting issues
npm run format   # Format with Prettier
```

## Architecture

- **`app.js` is a thin glue layer** (~300 lines) that wires Bolt handlers onto pure helpers in `lib/`
- **Socket Mode**: no public URL required; uses WebSocket connection
- **Persistence**: Redis-backed via Keyv for conversation context (per-user message history)
- **Node.js 18+** (CI matrices on 18, 20, 22; production runs 18 but it's EOL)
- ESM modules throughout

## Layout

```
app.js                     # Bolt handler wiring + start()
lib/
  responses.js             # Pure trigger-word matchers, help text, dad joke, Asimov rules
  chat.js                  # handleMessage — backend-agnostic, history in convoStore
  chat-backends.js         # makeOllamaChat() / makeGeminiChat() adapter factories
  image.js                 # generateImage via Gemini (client + model injected)
  deps.js                  # buildDeps() factory, validateRequiredEnv()
test/
  responses.test.js        # Matcher + helper coverage
  chat.test.js             # handleMessage + convoStore persistence
  chat-backends.test.js    # Ollama + Gemini adapter wire-format translation (incl. vision, thinking)
  image.test.js            # generateImage with mocked Gemini
  app.test.js              # Import-safety smoke test
  package.test.js          # package.json sanity checks
manifest.yaml              # Slack app configuration
package.json               # Dependencies and scripts
.env.example               # Environment variable template
ARCHITECTURE.md            # Detailed architecture documentation
AGENTS.md                  # Conventions for AI agents working in this repo
.github/workflows/ci.yml   # Lint + tests + syntax check + audit on Node 18/20/22
```

## Key Exports

`app.js` only boots the bot when run as the main module (`import.meta.url === \`file://${process.argv[1]}\``); importing it from tests is safe. It re-exports the unit-testable functions from `lib/`:

| Export | Source | Purpose |
|--------|--------|---------|
| `handleMessage(msg, { chat, convoStore })` | `lib/chat.js` | Route Slack message through the chat adapter; returns `{ text, thinking? }` |
| `generateImage(prompt, { client, model })` | `lib/image.js` | Call Gemini and return a PNG `Buffer` |
| `registerHandlers(deps)` | `app.js` | Attach all Bolt listeners to `deps.app` |
| `start(deps)` | `app.js` | Wire signals + register handlers + `app.start()` |

## Chat backends

`lib/chat-backends.js` exposes two factories that each return an object with a uniform `chat({ messages }) → { text }` method. `handleMessage` only ever calls this method — it has no idea which provider it's talking to.

| Backend | SDK | Model env | Notes |
|---------|-----|-----------|-------|
| `ollama` (default) | `ollama` npm package | `OLLAMA_MODEL` (default `llama3.1`) | Talks to `OLLAMA_HOST`. Strips Llama tokenizer artifacts. Room to extend with `think`, `tools`, `format`, vision. |
| `gemini` | `@google/genai` | `GEMINI_CHAT_MODEL` (default `gemini-3-flash-latest`) | Reuses the same client as image generation. Translates roles (`assistant` → `model`) and lifts the system message into `config.systemInstruction`. |

Pick the backend with `CHAT_BACKEND=ollama|gemini`. System message is bound at adapter construction time, not passed per call.

## Message Handlers

1. **General messages** (`app.message()`) — DMs, channel messages, MPIM
2. **Direct mentions** (`app.message(directMention())`) — `@Data` mentions
3. **Slash commands** (`app.command('/image')`) — Image generation via Gemini

## Environment Variables

Loaded from `.env` via dotenv (see `.env.example`).

**Required:**
- `SLACK_BOT_TOKEN` — Bot OAuth token (`xoxb-...`)
- `SLACK_APP_TOKEN` — App-level token for Socket Mode (`xapp-...`)
- `SLACK_BOT_USER_NAME` — Bot's display name in Slack
- `GEMINI_API_KEY` — required for the `/image` slash command, and for chat when `CHAT_BACKEND=gemini`

**Optional:**
- `CHAT_BACKEND` — `ollama` (default) or `gemini`
- `OLLAMA_HOST` — Ollama endpoint (default: `http://localhost:11434`)
- `OLLAMA_MODEL` — Ollama chat model (default: `llama3.1`)
- `OLLAMA_THINK` — surface model thinking traces: `true|low|medium|high` (requires a reasoning model — qwq, gpt-oss, deepseek-r1, etc.)
- `GEMINI_CHAT_MODEL` — Gemini chat model (default: `gemini-3-flash-latest`)
- `GEMINI_IMAGE_MODEL` — override the default image model (default: `gemini-3.1-flash-image`)
- `BOT_PERSONALITY` — Custom system prompt
- `REDIS_URL` — Redis connection (default: `redis://localhost:6379`)
- `MEMORY_TTL_HOURS` — Conversation memory lifetime (default: 24)

## Code Style

- ESM modules (`import`/`export`)
- Prettier: 2-space indent, 100 char width, trailing commas (ES5)
- ESLint with Prettier integration
- Async/await for all async operations

## External APIs

- **Slack** (Bolt SDK) — Messaging, file uploads, events
- **Ollama** (`ollama` npm package) — Native chat API, default backend
- **Google Gemini** (`@google/genai`) — Image generation (`gemini-3.1-flash-image`, "Nano Banana 2") and optional chat backend (`gemini-3-flash-latest`)
- **icanhazdadjoke.com** — Dad jokes endpoint
- **Redis** — Conversation history persistence

## Vision

When an incoming message has image attachments, `app.js::extractMessageImages` fetches each via the Slack file URL with the bot token, base64-encodes them, and attaches as `images: [{ mimeType, data }]` on the canonical user turn. Adapters translate to Ollama's `message.images` (base64 strings) or Gemini's `inlineData` parts. Image bytes are not persisted to history.

## Reactions UX

While Data is thinking, the bot adds a `:brain:` reaction to the user's message (via `reactions.add`) and removes it before posting the reply. Requires `reactions:read` and `reactions:write` scopes — see `manifest.yaml`.

## Thread-aware replies

Channel @-mentions reply in-thread: if the mention is inside an existing thread, the reply continues that thread; otherwise a new thread is started rooted at the mention. Tool side effects (image uploads, joke posts) also land in-thread. DMs reply flat as before.

## Canned Responses

Pattern matchers live in `lib/responses.js` as pure functions; the Bolt handlers in `app.js` are thin shims that call `say()` with the result:

- `"i love you"` → `"I know."`
- `"open the pod bay door"` → HAL 9000 reference
- `"danceparty"` → Emoji celebration
- `"rickroll"` / `"tiktok"` → button to external page
- `"help"` (when @-mentioned) → command list
- `"the rules"` (when @-mentioned) → Asimov's laws
- `"dad joke"` (when @-mentioned) → fetched from icanhazdadjoke.com

## Testing

- Uses Node.js built-in test runner (`node --test`)
- Tests live under `test/` — one `*.test.js` per source module
- **Tests must not require any env vars or external services.** Mock the external clients (Slack/Bolt, Ollama, Gemini, fetch) at the boundary; test real internal logic directly. See `test/chat.test.js` for the convoStore + adapter mock pattern.
- CI: lint → tests → syntax-check `app.js` and every `lib/*.js` → `npm audit --omit=dev --audit-level=high` (non-blocking)

## Common Tasks

**Adding a new canned response:** Add a matcher + helper to `lib/responses.js`, write a unit test for it in `test/responses.test.js`, then add a thin call site inside `registerHandlers()` in `app.js`.

**Modifying bot personality:** Set `BOT_PERSONALITY` env var, or edit the default in `buildDeps()` in `lib/deps.js`. Personality is bound at adapter construction; restart to pick up changes.

**Adding a new chat backend:** Add a `make<Backend>Chat(...)` factory in `lib/chat-backends.js` that returns `{ async chat({ messages }) → { text, thinking? } }`. Wire backend selection in `buildDeps()`. Add tests in `test/chat-backends.test.js` that assert the wire-format translation.

**Note: tool calling is intentionally not part of the architecture.** It was experimented with (see git history around PR #30 and the revert that followed) and removed: the gemma family — Data's preferred backend for its strong vision — emits tool calls as inline text rather than Ollama's structured `tool_calls` field, and most of the original tool registry just duplicated regex matchers that already worked. Image generation is the `/image` slash command (Data also nudges users toward it when they ask for an image in chat via `isImageRequest` + `IMAGE_REQUEST_GUIDANCE`).

## Model selection notes (lessons from PR #30)

These are practical, hard-earned notes about which Ollama models do what well, and what's worth knowing when picking `OLLAMA_MODEL`. Save your future self a debugging session.

### gemma4:31b (current default)
- **Vision: excellent.** Identified a "communist cat meme" correctly including the hammer-and-sickle symbolism and explained the joke premise unprompted. Strong recognition + sophisticated comprehension.
- **Tool calling: broken.** Knows what tools are, knows their schemas, but emits calls as plain text — e.g. `<call:generate_image{prompt:"..."}><tool_call|>` — instead of populating Ollama's structured `message.tool_calls` field. Wire-format / template issue, not a prompting issue. Same behavior on `gemma4-openhands:latest` (the agent fine-tune of the same family), so it's a family-wide limitation, not a base-model thing.
- **Thinking: emits `message.thinking` even when `think:` param is NOT sent.** Found this the hard way when the inline thinking block appeared in Slack despite `OLLAMA_THINK` being unset.
- Verdict: use for chat + vision. Don't try to use it for tools.

### qwen3.6:27b
- **Tool calling: reliable.** Tested against `generate_image` and a 7-tool registry; structured `tool_calls` came back cleanly with rich, well-formed args.
- **Vision: not confirmed.** Likely no (Qwen vision is a separate `qwen2.5-vl` family). Didn't test live.
- Verdict: pick this when tools matter and vision doesn't.

### What's pulled on `kepler.local`
As of this writing: `gemma4:latest`, `gemma4:31b`, `gemma4-openhands:latest`, `llama3.3:70b-instruct-q8_0` (75GB, slow), `qwen3.6:27b`, `qwen3.6-openhands:latest`, `qwen3.6:35b-a3b`, `qwen3-coder-next:latest`, `qwen3-coder-openhands:latest`, `devstral-small-2:latest`, `nomic-embed-text:latest`. None of these are vision+tools-in-one. If you ever want both natively, pull something like `qwen2.5-vl:32b` or `mistral-small3.1` and try.

### Why tool calling was removed
1. **6 of 7 tools duplicated regex matchers** (`tell_dad_joke`, `state_asimovs_laws`, `show_help`, `start_dance_party`, `play_rickroll`, `play_tiktok`) — slower and less reliable than the existing exact-phrase triggers.
2. The one tool that did benefit from LLM intent extraction (`generate_image`) was unreliable on gemma — and gemma is the right model for everything else.
3. `/image` slash command already covers image generation reliably with no LLM round-trip.
4. The tool registry + dispatch loop was ~800 lines of code for net-negative reliability.

If you ever bring tools back: make sure the model in production actually emits structured `tool_calls` before you wire it up. Test live against a 2-tool registry first.

### Lessons from shipping vision (#26)
- Slack tags file uploads with `subtype: 'file_share'`. The pre-#26 handler had `if (message.subtype) return;` which silently dropped every upload. Fix: allow `file_share` through, skip only the genuinely-noise subtypes.
- Image fetch needs the bot token as a bearer header against `file.url_private` — these aren't anonymous URLs.
- Don't persist image bytes to convoStore. The Slack URLs expire and the bytes are big. Persist only the text portion of the user turn.
- Add explicit log lines around vision (`Vision: extracted ...`, `Ollama chat -> model with N image(s)`). When the pipeline silently dropped uploads pre-fix, we had NO observability — the bot just looked broken.

### Lessons from shipping reactions UX (#28)
- Requires `reactions:read` and `reactions:write` scopes in `manifest.yaml`.
- After adding scopes, you MUST re-sync the manifest in api.slack.com AND reinstall the app to the workspace. Failure mode: `missing_scope` errors on every `reactions.add` call, no reaction ever appears, bot looks unresponsive while it's actually working fine.

### Why thinking-trace rendering was suppressed (#27)
- gemma4 emits `message.thinking` even without `think:` set, and the traces are *long* (full chain-of-thought paragraphs).
- The inline Block Kit rendering — italicized "Thinking: …" context block above the reply — made every message a wall of text.
- The `:brain:` reaction is enough of an "I'm working on this" UI. The trace plumbing is still there (`result.thinking` is captured by the adapter and surfaced by `handleMessage`); we just don't render it.

**Adding a new slash command:** Register with `app.command('/commandname')` inside `registerHandlers()` in `app.js`, and add the entry to `manifest.yaml`. Remember to re-sync the manifest to the Slack app and reinstall before Slack will route the new command.

**Adding a function that calls an external API:** Don't instantiate the client at module scope. Add it to `buildDeps()` in `lib/deps.js`, pass it through `deps`, and accept the client as a parameter on the function so tests can inject a fake (see `generateImage` for the pattern).
