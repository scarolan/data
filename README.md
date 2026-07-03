# Data - a Bolt-JS Slack Chatbot

![Lt. Commander Data and his cat, Spot](data_and_spot.png)

## Overview

This is a ChatGPT-powered Slack chatbot built on the Bolt JS framework. The bot includes canned responses, direct-message and mention-based ChatGPT replies, and a `/dalle` slash command for image generation. You can customize the bot's personality and thinking indicator with environment variables.

## Prerequisites

You will need a local Redis installation to persist the bot's conversation memory. You can install Redis server on Ubuntu like this:

```zsh
sudo apt -y install redis-server
```

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

```zsh
# Replace with your bot and tokens
export SLACK_BOT_TOKEN=<your-bot-token> # from the OAuth section
export SLACK_APP_TOKEN=<your-app-level-token> # from the Basic Info App Token Section
export SLACK_BOT_USER_NAME=<your-bot-username> # must match the short name of your bot user
export OPENAI_API_KEY=<your-openai-api-key> # get from here: https://platform.openai.com/account/api-keys
export BOT_PERSONALITY="Your custom bot personality prompt here" # Optional: Set a custom personality for your bot
export THINKING_MESSAGE=":gear: _Processing your request..._" # Optional: Customize the thinking indicator message
```

#### For Windows PowerShell

```powershell
# Replace with your bot and tokens
$env:SLACK_BOT_TOKEN = "xoxb-your-bot-token"
$env:SLACK_APP_TOKEN = "xapp-your-app-token"
$env:SLACK_BOT_USER_NAME = "Data" # Change to match your bot's name
$env:OPENAI_API_KEY = "your-openai-api-key"
$env:BOT_PERSONALITY = "Your custom bot personality prompt here" # Optional: Set a custom personality for your bot
$env:THINKING_MESSAGE = ":gear: _Processing your request..._" # Optional: Customize the thinking indicator message

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

Try the bot in Slack with one of these examples.

Direct mention example:

```text
@Data help
```

Direct message example:

```text
What is the capital of Australia?
```

Slash command example (image generation):

```text
/dalle An image of Lt. Commander Data and his cat
```

Trigger word examples that work without mentioning the bot:

```text
i love you
open the pod bay door
danceparty
rickroll
tiktok
```

### 5. Deploy to production

You'll need a Linux server, container, or application platform that supports nodejs to keep the bot running. Slack has a tutorial for getting an app running on the Glitch platform: https://api.slack.com/tutorials/hello-world-bolt

## Image Generation and Troubleshooting

The bot supports generating images with DALL-E through the `/dalle` slash command.

If you ask the bot to create an image in a DM or direct mention, it will guide you to use `/dalle` instead.

### How Image Generation Works

When using the `/dalle` slash command:

1. The bot acknowledges your request and shows a "generating" message
2. Image generation happens asynchronously in the background
3. When complete, the image is posted directly to the channel

## Supported interactions

### Trigger words

These work in channels without mentioning the bot:

- `i love you`
- `open the pod bay door`
- `danceparty`
- `tiktok`
- `rickroll`

### Direct mentions

These special direct-mention commands are handled before ChatGPT:

- `@Data help`
- `@Data the rules`
- `@Data dad joke`

All other direct mentions fall back to ChatGPT.

### Direct messages and MPIMs

- Non-empty user messages fall back to ChatGPT
- Requests to generate images in chat are redirected to `/dalle`

## Environment Variables

| Variable            | Required | Description                                        |
| ------------------- | -------- | -------------------------------------------------- |
| SLACK_BOT_TOKEN     | Yes      | Your Slack bot token from OAuth section            |
| SLACK_APP_TOKEN     | Yes      | Your Slack app-level token                         |
| SLACK_BOT_USER_NAME | Yes      | Must match the short name of your bot user         |
| OPENAI_API_KEY      | Yes      | Your OpenAI API key                                |
| BOT_PERSONALITY     | No       | Custom personality prompt for your bot             |
| THINKING_MESSAGE    | No       | Custom thinking indicator message                  |
| REDIS_URL           | No       | Redis URL (defaults to `redis://localhost:6379`)   |
| MEMORY_TTL_HOURS    | No       | Conversation-store TTL in hours (default: `24`)    |
| MEMORY_MAX_KEYS     | No       | Advisory maximum stored keys (default: `10000`)    |
