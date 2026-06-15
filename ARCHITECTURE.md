# Architecture Overview — Data Slack Chatbot

This document explains the high-level architecture of the `data` Slack chatbot: main components, runtime flows, and extension points.

## Goals
- Keep the bot simple and easy to understand for new developers.
- Provide a single source of truth for message flows, storage, and third-party integrations.
- Document where to change behavior safely (handlers, image generation, persistence, chat backends).

## Components

- **`app.js`** — Bolt handler wiring + `start()`. Imports pure helpers from `lib/`; only boots the bot when run as the main module so the test suite can import it safely.
- **`lib/responses.js`** — pure matchers and content builders for canned trigger words (love-you, pod-bay-door, danceparty, tiktok, rickroll, help text, Asimov rules, dad-joke fetch).
- **`lib/chat.js`** — `handleMessage()`. Backend-agnostic. Reads/writes per-user message history in `convoStore`, hands the chat adapter a list of messages, returns the text reply.
- **`lib/chat-backends.js`** — `makeOllamaChat()` and `makeGeminiChat()` factories. Each returns `{ async chat({ messages }) → { text } }`. Translation between the canonical message shape and each provider's native wire format lives here.
- **`lib/image.js`** — `generateImage()`. Takes the Gemini client and model name via `deps`.
- **`lib/deps.js`** — `buildDeps()` factory + `validateRequiredEnv()`. Constructs the Slack `App`, the Keyv/Redis `convoStore`, the `GoogleGenAI` client, and the selected chat adapter; tests can override any of them.
- **Slack (Bolt JS)** — receives events in Socket Mode and dispatches them to the handlers registered by `registerHandlers(deps)`.
- **Ollama (`ollama` npm package)** — default chat backend. Native SDK; no OpenAI compat shim. Talks to `OLLAMA_HOST` (default `http://localhost:11434`). Supports vision (base64 images); strips Llama tokenizer artifacts at the adapter boundary.
- **Gemini (`@google/genai`)** — image generation (`gemini-3.1-flash-image`, "Nano Banana 2") and optional chat backend (`gemini-3-flash-latest`). One client serves both.
- **Persistence (Keyv + KeyvRedis)** — stores per-user conversation history (`{role, content}` arrays) keyed by `convo:<userId>`, backed by Redis (`REDIS_URL`). TTL via `MEMORY_TTL_HOURS`. History survives process restarts.
- **Tests** — under `test/` run with `node --test`; see `test/chat.test.js` and `test/chat-backends.test.js` for the adapter + convoStore mock patterns.
- **CI** — GitHub Actions matrix on Node 22/24: install, lint, tests, syntax-check of `app.js` + every `lib/*.js`, and a non-blocking `npm audit` at high severity.

## Message flows

1. Incoming message arrives via Bolt Socket Mode.
2. The general message handler (`app.message(...)`) checks pure matchers from `lib/responses.js` in order (love-you → pod-bay → danceparty → tiktok → rickroll). On a match it calls `say()` with the helper output and returns.
3. If no canned match and the channel is a DM or MPIM, the handler adds a `:brain:` reaction to the user's message, extracts any image attachments (`extractMessageImages`), calls `handleMessage(msg, { chat, convoStore })`, removes the reaction, and replies with the result.
4. Direct-mention handler (`app.message(directMention(), ...)`) checks for `help`, `the rules`, `dad joke`, and image-request guidance before falling through to `handleMessage()` with the same reaction UX. Channel @-mentions reply in-thread (continuing an existing thread or starting one rooted at the mention); DMs reply flat.
5. Slash command `/image`:
   - `ack()` immediately to avoid Slack timeouts.
   - Respond with an ephemeral progress message.
   - Schedule the heavy work via `queueMicrotask`: call `generateImage(prompt, { client: geminiClient, model })`, then upload the returned `Buffer` to the channel with `files.uploadV2()`.
6. Slash command `/forget` — calls `clearHistory(user_id, { convoStore })` to wipe the invoking user's stored conversation, replying ephemerally.

## Chat backend selection

`CHAT_BACKEND=ollama` (default) or `CHAT_BACKEND=gemini`. `buildDeps()` constructs the appropriate adapter and binds the system message + model at construction time, so `handleMessage` stays backend-agnostic. Adding a third backend (e.g. Anthropic) is a new factory in `lib/chat-backends.js` plus a branch in `buildDeps()`.

## Concurrency & UX
- Image generation is deferred via `queueMicrotask` so the slash command's `ack()` returns immediately while the upload happens in the background.
- "I'm working on this" UX is a `:brain:` reaction on the user's message: `addThinkingReaction` / `removeThinkingReaction` in `app.js` (requires `reactions:read` + `reactions:write` scopes). Backend reasoning traces are not captured or rendered — that plumbing was removed (see CLAUDE.md, #27).

## Persistence & Conversation Context
- Per-user message history is stored in `Keyv` (backed by `KeyvRedis` when `REDIS_URL` is set) under `convo:<userId>` as a `[{role, content}, ...]` array.
- Each turn appends `{user}` then `{assistant}` and trims to `historyLimit` (default 20 messages = 10 turns).
- TTL is configurable via `MEMORY_TTL_HOURS` (default 24).
- The history pointer is no longer in-process — restarts preserve every user's conversation.

## Error handling & observability
- The app logs lifecycle events and errors with `console`. Consider a structured logger (pino/winston) for production.
- `handleMessage` catches backend errors, distinguishes content/policy/safety/moderation errors (returns a "please rephrase" apology) from generic errors (returns a generic apology). Failed turns are not persisted into history.
- `validateRequiredEnv()` runs at `start()` (not at module load), so missing env fails fast on boot without breaking `import` for tests.
- Graceful shutdown handlers call `app.stop()` on `SIGINT`/`SIGTERM`/`uncaughtException`.

## Security & secrets
- All secrets are passed via environment variables. Use the provided `.env.example` as a template.
- Do not check actual `.env` files into Git (already in `.gitignore`).
- Consider a secrets manager for production deployments (GitHub Secrets, cloud secret stores).

## Extension points

- **Conversation logic** — `lib/chat.js::handleMessage()`. Trim, preprocess, or change how history is built.
- **New chat backend** — add a `make<Backend>Chat()` factory in `lib/chat-backends.js` returning `{ chat({ messages }) → { text } }`. Wire selection in `buildDeps()`. Add tests in `test/chat-backends.test.js`.
- **New canned response** — add a matcher + content to `lib/responses.js`, write a unit test in `test/responses.test.js`, then add a call site inside `registerHandlers()` in `app.js`.
- **New Slack slash command** — register inside `registerHandlers()` (`app.command('/your-command', ...)`) and add it to `manifest.yaml` (then re-sync the manifest to the Slack app and reinstall).
- **Image processing** — `lib/image.js::generateImage()` encapsulates the Gemini call and is the single place to swap providers or add post-processing.
- **New external client** — extend `buildDeps()` in `lib/deps.js` to construct (or accept an override for) the client, then pass it through `deps` to whichever helper needs it. Never instantiate clients at module scope — tests can't override module-level singletons.

## Local development & testing
- Use `.env.example` to create a local `.env`.
- `npm install` then `npm start` to run the bot locally (needs valid Slack and Ollama/Gemini credentials).
- `npm test` runs the suite without requiring any env vars or network access.
- `npm run lint` / `npm run format` for style.

## Deployment
- Socket Mode: host on any Node-capable environment (VM, container, Heroku, etc.). The reference deployment is a `systemd` service (`bot-data.service`) running `npm start`.
- CI runs lint, tests, and syntax checks on every push/PR — see `.github/workflows/ci.yml`.

## Notes and future improvements
- Replace `console` logging with a structured logger and optional remote export.
- Consider an explicit Redis client passed into KeyvRedis to control connection lifecycle.
- Cover the Bolt handlers themselves with integration tests (currently the canned-response *content* is well-tested but the registration glue in `registerHandlers()` is not).
- Surface Ollama's native features (`tools`, `format`, vision) through the adapter interface as features call for it.
