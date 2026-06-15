# Data - a Bolt-JS Slack Chatbot

![Lt. Commander Data and his cat, Spot](data_and_spot.png)

## Overview

This is an AI-powered Slack chatbot built on the Bolt JS framework. The bot includes canned responses and falls back to a language model for messages that don't match a predefined pattern. Chat is powered by **Ollama** (default, self-hosted) or **Gemini**; image generation uses **Gemini**. You can customize the bot's personality and responses to suit your needs.

## Prerequisites

- **Node.js 22+** (LTS).
- A **Redis** installation to persist the bot's conversation memory. On Ubuntu:

  ```zsh
  sudo apt -y install redis-server
  ```

- A chat backend:
  - **Ollama** (default) — a running [Ollama](https://ollama.com) instance with a model pulled (e.g. `ollama pull llama3.1`). Point the bot at it with `OLLAMA_HOST`.
  - **or Gemini** — set `CHAT_BACKEND=gemini` and supply a `GEMINI_API_KEY`.
- A **`GEMINI_API_KEY`** is required for the `/image` slash command regardless of which chat backend you use.

## Installation

### 0. Create a new Slack App

- Go to https://api.slack.com/apps
- Click **Create App**
- Choose a workspace
- Copy the manifest.yaml contents into the input box
- Update the name and display name settings
- Click **Create**

Once the app is created click **Install to Workspace**
Then scroll down in Basic Info and click **Generate Token and Scopes** with all three scopes enabled.

### 1. Setup environment variables

#### For Linux/Mac

The easiest way is to copy `.env.example` to `.env` and fill it in; the bot loads it via dotenv. Or export them in your shell:

```zsh
# Replace with your bot and tokens
export SLACK_BOT_TOKEN=<your-bot-token> # from the OAuth section
export SLACK_APP_TOKEN=<your-app-level-token> # from the Basic Info App Token Section
export SLACK_BOT_USER_NAME=<your-bot-username> # must match the short name of your bot user
export GEMINI_API_KEY=<your-gemini-api-key> # for /image, and for chat if CHAT_BACKEND=gemini
export BOT_PERSONALITY="Your custom bot personality prompt here" # Optional: Set a custom personality for your bot

# Optional: choose and configure the chat backend (defaults to local Ollama)
# export CHAT_BACKEND=ollama
# export OLLAMA_HOST=http://localhost:11434
# export OLLAMA_MODEL=llama3.1
```

#### For Windows PowerShell

```powershell
# Replace with your bot and tokens
$env:SLACK_BOT_TOKEN = "xoxb-your-bot-token"
$env:SLACK_APP_TOKEN = "xapp-your-app-token"
$env:SLACK_BOT_USER_NAME = "Data" # Change to match your bot's name
$env:GEMINI_API_KEY = "your-gemini-api-key"
$env:BOT_PERSONALITY = "Your custom bot personality prompt here" # Optional: Set a custom personality for your bot

# Optional: Set Redis URL if you're using a custom Redis instance
# $env:REDIS_URL = "redis://localhost:6379"

# Start the bot
npm start
```

### 2. Setup your local project

```zsh
# Clone this project onto your machine
git clone https://github.com/scarolan/data.git
```

The bot's personality is now configurable via the BOT_PERSONALITY environment variable. You can set this in your script or directly in your environment:

```zsh
# Example of customizing the bot's personality
export BOT_PERSONALITY="You are a helpful assistant with a cheerful disposition. You love to tell jokes and answer questions clearly and concisely."
```

If you don't set the BOT_PERSONALITY variable, the bot will use a default Star Trek "Data" personality.

```zsh
# Change into the project
cd data

# Install the dependencies
npm install
```

### 3. Start the chatbot application

```zsh
npm run start
```

### 4. Test

Go to the installed workspace and DM your new bot, or `@`-mention it in a channel.

Direct mention example (in a channel or DM):

```text
@Data help
```

Slash command example (image generation):

```text
/image An image of Lt. Commander Data and his cat
```

### 5. Deploy to production

You'll need a Linux server, container, or application platform that supports nodejs to keep the bot running. Slack has a tutorial for getting an app running on the Glitch platform: https://api.slack.com/tutorials/hello-world-bolt

## Image Generation

The bot generates images with **Gemini** (Nano Banana) through the `/image` slash command.

### How Image Generation Works

When using the `/image` slash command:

1. The bot acknowledges your request and shows an ephemeral "generating" message
2. Image generation happens asynchronously in the background
3. When complete, the image is posted directly to the channel

## Environment Variables

| Variable            | Required        | Description                                                          |
| ------------------- | --------------- | -------------------------------------------------------------------- |
| SLACK_BOT_TOKEN     | Yes             | Your Slack bot token from the OAuth section                          |
| SLACK_APP_TOKEN     | Yes             | Your Slack app-level token (Socket Mode)                             |
| SLACK_BOT_USER_NAME | Yes             | Must match the short name of your bot user                           |
| GEMINI_API_KEY      | Yes             | Used for `/image`; also for chat when `CHAT_BACKEND=gemini`          |
| CHAT_BACKEND        | No              | `ollama` (default) or `gemini`                                       |
| OLLAMA_HOST         | No              | Ollama endpoint (default: `http://localhost:11434`)                  |
| OLLAMA_MODEL        | No              | Ollama chat model (default: `gemma4:31b`)                            |
| GEMINI_CHAT_MODEL   | No              | Gemini chat model (default: `gemini-3-flash-latest`)                 |
| GEMINI_IMAGE_MODEL  | No              | Override the default image model                                     |
| BOT_PERSONALITY     | No              | Custom personality prompt for your bot                               |
| REDIS_URL           | No              | Custom Redis URL (default: `redis://localhost:6379`)                 |
| MEMORY_TTL_HOURS    | No              | Conversation memory lifetime in hours (default: 24)                  |

See `.env.example` for a copy-pasteable template.
