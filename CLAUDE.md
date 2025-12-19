# CLAUDE.md

## Project Overview

**Data** is an LLM-powered Slack chatbot with a Star Trek personality (Lt. Commander Data). It uses the Slack Bolt framework with ChatGPT for conversations and DALL-E for image generation.

## Quick Reference

```bash
npm install      # Install dependencies
npm start        # Run the bot
npm test         # Run tests
npm run lint     # Check code style
npm run lint:fix # Auto-fix linting issues
npm run format   # Format with Prettier
```

## Architecture

- **Single-file design**: All logic lives in `app.js` (~900 lines)
- **Socket Mode**: No public URL required; uses WebSocket connection
- **Persistence**: Redis-backed via Keyv for conversation context
- **Node.js 18+** required, uses ESM modules

## Key Components in app.js

| Function | Lines | Purpose |
|----------|-------|---------|
| `handleMessage()` | 176-222 | Process messages with ChatGPT, maintain conversation context |
| `generateImage()` | 118-169 | DALL-E image generation |
| `postThinking()` | 226-246 | Show processing indicator |
| `clearThinking()` | 249-256 | Remove ephemeral messages |

## Message Handlers

1. **General messages** (`app.message()`) - DMs and channel messages
2. **Direct mentions** (`app.message(directMention())`) - `@Data` mentions
3. **Slash commands** (`app.command('/dalle')`) - Image generation

## Environment Variables

Environment variables are automatically loaded from `.env` file via dotenv (see `.env.example` for template).

**Required:**
- `SLACK_BOT_TOKEN` - Bot OAuth token (xoxb-...)
- `SLACK_APP_TOKEN` - App-level token for Socket Mode (xapp-...)
- `SLACK_BOT_USER_NAME` - Bot's display name in Slack
- `OPENAI_API_KEY` - OpenAI API key

**Optional:**
- `BOT_PERSONALITY` - Custom system prompt for ChatGPT
- `THINKING_MESSAGE` - Custom processing indicator text
- `REDIS_URL` - Redis connection (default: redis://localhost:6379)
- `MEMORY_TTL_HOURS` - Conversation memory lifetime (default: 24)
- `MEMORY_MAX_KEYS` - Max stored message IDs (default: 10000)

## Code Style

- ESM modules (`import`/`export`)
- Prettier: 2-space indent, 100 char width, trailing commas (ES5)
- ESLint with Prettier integration
- Async/await for all async operations

## External APIs

- **Slack** (Bolt SDK) - Messaging, file uploads, events
- **OpenAI ChatGPT** (`gpt-4o`) - Conversations via `chatgpt` package
- **OpenAI DALL-E** (`gpt-image-1`) - Image generation via official SDK
- **icanhazdadjoke.com** - Dad jokes endpoint
- **Redis** - Conversation context persistence

## Canned Responses

Pattern matching happens before ChatGPT calls:
- `"i love you"` → `"I know."`
- `"open the pod bay door"` → Star Trek reference
- `"danceparty"` → Emoji celebration
- `"rickroll"` / `"tiktok"` → Rick Astley button

## Testing

- Uses Node.js built-in test runner
- Tests in `test/package.test.js`
- CI runs: lint → test → syntax check (`node --check ./app.js`)

## Common Tasks

**Adding a new canned response:** Add pattern matching in `app.message()` handler before the DM/mention handlers.

**Modifying bot personality:** Set `BOT_PERSONALITY` env var or edit the default in app.js (~line 60).

**Adding a new slash command:** Register with `app.command('/commandname')`, add to manifest.yaml.

## Files

```
app.js              # Main application (all bot logic)
manifest.yaml       # Slack app configuration
package.json        # Dependencies and scripts
.env.example        # Environment variable template
ARCHITECTURE.md     # Detailed architecture documentation
```
