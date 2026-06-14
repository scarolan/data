# Architecture Overview — Data Slack Chatbot

This document explains the high-level architecture of the `data` Slack chatbot: main components, runtime flows, and extension points.

## Goals
- Keep the bot simple and easy to understand for new developers.
- Provide a single source of truth for message flows, storage, and third-party integrations.
- Document where to change behavior safely (handlers, image generation, persistence).

## Components

- **`app.js`** — Bolt handler wiring + `start()`. Imports pure helpers from `lib/`; only boots the bot when run as the main module so the test suite can import it safely.
- **`lib/responses.js`** — pure matchers and content builders for canned trigger words (love-you, pod-bay-door, danceparty, tiktok, rickroll, help text, Asimov rules, dad-joke fetch).
- **`lib/chat.js`** — `handleMessage()` and `cleanLocalLlmResponse()`. Takes the ChatGPT client and parent-id Map via `deps`.
- **`lib/image.js`** — `generateImage()`. Takes the Gemini client and model name via `deps`.
- **`lib/deps.js`** — `buildDeps()` factory + `validateRequiredEnv()`. Constructs the Slack `App`, Keyv/Redis store, ChatGPTAPI client, and `GoogleGenAI` client; tests can override any of them.
- **Slack (Bolt JS)** — receives events in Socket Mode and dispatches them to the handlers registered by `registerHandlers(deps)`.
- **ChatGPT client (`chatgpt` ChatGPTAPI)** — conversational responses with a persistent message store. Transparently supports any OpenAI-compatible endpoint when `LLM_API_BASE_URL` is set (e.g. Ollama at `http://kepler.local:11434/v1`).
- **Gemini (`@google/genai`)** — image generation, model `gemini-3.1-flash-image` ("Nano Banana 2") by default; overridable via `GEMINI_IMAGE_MODEL`.
- **Persistence (Keyv + KeyvRedis)** — stores conversation parent-message-ids keyed by user, backed by Redis (`REDIS_URL`).
- **Tests** — 28 tests under `test/` run with `node --test`; see `test/chat.test.js` and `test/image.test.js` for the deps-injection pattern.
- **CI** — GitHub Actions matrix on Node 18/20/22: install, lint, tests, syntax-check of `app.js` + every `lib/*.js`, and a non-blocking `npm audit` at high severity.

## Message flows

1. Incoming message arrives via Bolt Socket Mode.
2. The general message handler (`app.message(...)`) checks pure matchers from `lib/responses.js` in order (love-you → pod-bay → danceparty → tiktok → rickroll). On a match it calls `say()` with the helper output and returns.
3. If no canned match and the channel is a DM or MPIM, the handler posts a "thinking" indicator, calls `handleMessage(msg, { chat, parentIds, isLocalLlm })`, deletes the indicator, and replies with the result.
4. Direct-mention handler (`app.message(directMention(), ...)`) checks for `help`, `the rules`, `dad joke`, and image-request guidance before falling through to `handleMessage()` with the same thinking UX.
5. Slash command `/image`:
   - `ack()` immediately to avoid Slack timeouts.
   - Respond with an ephemeral progress message.
   - Schedule the heavy work via `queueMicrotask`: call `generateImage(prompt, { client: geminiClient, model })`, then upload the returned `Buffer` to the channel with `files.uploadV2()`.

## Concurrency & UX
- Image generation is deferred via `queueMicrotask` so the slash command's `ack()` returns immediately while the upload happens in the background.
- A small thinking helper (`postThinking` / `clearThinking` in `app.js`) centralizes posting and deleting progress messages.

## Persistence & Conversation Context
- The bot stores parent message ids per user in `Keyv` (backed by `KeyvRedis` when `REDIS_URL` is set) so follow-up messages stay in conversation context.
- TTL and advisory `max` keys are configurable via `MEMORY_TTL_HOURS` and `MEMORY_MAX_KEYS`.

## Error handling & observability
- The app logs lifecycle events and errors with `console`. Consider a structured logger (pino/winston) for production.
- `validateRequiredEnv()` runs at `start()` (not at module load), so missing env fails fast on boot without breaking `import` for tests.
- Graceful shutdown handlers call `app.stop()` on `SIGINT`/`SIGTERM`/`uncaughtException`.

## Security & secrets
- All secrets are passed via environment variables. Use the provided `.env.example` as a template.
- Do not check actual `.env` files into Git (already in `.gitignore`).
- Consider a secrets manager for production deployments (GitHub Secrets, cloud secret stores).

## Extension points

- **Conversation logic** — `lib/chat.js::handleMessage()`. Change preprocessing, response cleaning, or how the chat client is called.
- **New canned response** — add a matcher + content to `lib/responses.js`, write a unit test in `test/responses.test.js`, then add a call site inside `registerHandlers()` in `app.js`.
- **New Slack slash command** — register inside `registerHandlers()` (`app.command('/your-command', ...)`) and add it to `manifest.yaml` (then re-sync the manifest to the Slack app and reinstall).
- **Image processing** — `lib/image.js::generateImage()` encapsulates the Gemini call and is the single place to swap providers or add post-processing.
- **New external client** — extend `buildDeps()` in `lib/deps.js` to construct (or accept an override for) the client, then pass it through `deps` to whichever helper needs it. Never instantiate clients at module scope — tests can't override module-level singletons.

## Local development & testing
- Use `.env.example` to create a local `.env`.
- `npm install` then `npm start` to run the bot locally (needs valid Slack and OpenAI/Gemini credentials).
- `npm test` runs the suite without requiring any env vars or network access.
- `npm run lint` / `npm run format` for style.

## Deployment
- Socket Mode: host on any Node-capable environment (VM, container, Heroku, etc.). The reference deployment is a `systemd` service (`bot-data.service`) running `npm start`.
- CI runs lint, tests, and syntax checks on every push/PR — see `.github/workflows/ci.yml`.

## Notes and future improvements
- Replace `console` logging with a structured logger and optional remote export.
- Consider an explicit Redis client passed into KeyvRedis to control connection lifecycle.
- Cover the Bolt handlers themselves with integration tests (currently the canned-response *content* is well-tested but the registration glue in `registerHandlers()` is not).
