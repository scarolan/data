///////////////////////////////////////////////////////////////
// A bolt.js Slack chatbot augmented with OpenAI ChatGPT
// Requires a running Redis instance to persist the bot's memory
//
// Load environment variables from .env file (must be first)
import 'dotenv/config';
//
// Make sure you set the required environment variables in .env:
// SLACK_BOT_TOKEN - under the OAuth Permissions page on api.slack.com
// SLACK_APP_TOKEN - under your app's Basic Information page on api.slack.com
// SLACK_BOT_USER_NAME - must match the short name of your bot user
// OPENAI_API_KEY - get from here: https://platform.openai.com/account/api-keys
// BOT_PERSONALITY - (optional) customize the bot's character and behavior
//                   if not set, a default Star Trek Data personality is used
// THINKING_MESSAGE - (optional) customize the "thinking" message shown while processing
//                   if not set, a default Star Trek Data themed message is used
//
// Note: The /dalle slash command uses an asynchronous approach to handle
// Slack timeout limitations, generating the image in the background and
// posting directly to the channel when complete.
///////////////////////////////////////////////////////////////

// Get bot personality from environment variable or use default
const defaultPersonality = `You are a Soong type Android named ${process.env.SLACK_BOT_USER_NAME}. You are a member of the crew of the USS Enterprise. You are a member of the science division. You respond to all inquiries in character as if you were Lieutenant Commander Data from Star Trek: The Next Generation.`;
const personalityPrompt = process.env.BOT_PERSONALITY || defaultPersonality;

// Get thinking message from environment variable or use default
const defaultThinkingMessage = ':brain: _Accessing neural network pathways... Processing query..._';
const thinkingMessage = process.env.THINKING_MESSAGE || defaultThinkingMessage;

// Validate required environment variables early to fail fast
function validateRequiredEnv() {
  const required = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_BOT_USER_NAME', 'OPENAI_API_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('Missing required environment variables:', missing.join(', '));
    console.error('Please set them (see .env.example) and restart the process.');
    process.exit(1);
  }
}
validateRequiredEnv();

// Import required libraries
import pkg from '@slack/bolt';
const { App } = pkg;
import { directMention } from '@slack/bolt';
import { ChatGPTAPI } from 'chatgpt';
import OpenAI from 'openai';
import Keyv from 'keyv';
import KeyvRedis from '@keyv/redis';
import fetch from 'node-fetch';
//Uncomment this and the logLevel below to enable DEBUG
//import { LogLevel } from '@slack/bolt';

// Creates new connection to Slack
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  //logLevel: LogLevel.DEBUG,
});

// Graceful shutdown handlers
async function shutdown(signal) {
  console.log(`Received ${signal}, stopping app...`);
  try {
    await app.stop();
    console.log('App stopped.');
  } catch (err) {
    console.error('Error while stopping app:', err && err.message ? err.message : err);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err && err.stack ? err.stack : err);
  shutdown('uncaughtException');
});

// Create a redis namespace for the bot's memory
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Allow TTL and MAX keys to be configured via environment variables
// MEMORY_TTL_HOURS - how long (in hours) keys should live in Redis (default 24)
// MEMORY_MAX_KEYS - advisory maximum number of keys we expect to store (default 10000)
const memoryTtlHours = parseInt(process.env.MEMORY_TTL_HOURS || '24', 10);
const memoryMaxKeys = parseInt(process.env.MEMORY_MAX_KEYS || '10000', 10);
const memoryTtlSeconds = Math.max(60, memoryTtlHours * 60 * 60);

const store = new KeyvRedis(redisUrl, {
  namespace: 'chatgpt-slackbot',
  // KeyvRedis accepts a ttl value in seconds in this codebase; keep using 'ttl' for compatibility
  ttl: memoryTtlSeconds,
  // Max is advisory; KeyvRedis may expose it to its internal cache implementation
  max: memoryMaxKeys,
});
const messageStore = new Keyv({ store, namespace: 'chatgpt-slackbot' });

console.log(
  `Keyv/Redis configured: REDIS_URL=${redisUrl}, MEMORY_TTL_HOURS=${memoryTtlHours}, MEMORY_MAX_KEYS=${memoryMaxKeys}`
);

// Create a new instance of the ChatGPTAPI client
const openai_api = new ChatGPTAPI({
  apiKey: process.env.OPENAI_API_KEY,
  messageStore,
  systemMessage: personalityPrompt,
  completionParams: {
    model: 'gpt-4o',
  },
});

// OpenAI API client for generating images
const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Function to generate an image with DALL-E (model: gpt-image-1)
async function generateImage(prompt) {
  try {
    console.log(`Generating DALL-E image with prompt: "${prompt}"`);

    if (!prompt || prompt.trim() === '') {
      throw new Error('Empty prompt provided for image generation');
    }

    console.log('Calling OpenAI API with parameters:', {
      prompt: prompt,
      n: 1,
      size: '1024x1024',
      model: 'gpt-image-1',
    });

    const response = await openaiClient.images.generate({
      prompt,
      n: 1,
      size: '1024x1024',
      model: 'gpt-image-1',
    });

    if (!response || !response.data || !response.data[0] || !response.data[0].b64_json) {
      console.error('Invalid response from OpenAI:', JSON.stringify(response));
      throw new Error('Received invalid response from image generation API');
    }

    // Convert to buffer and log size information
    const imageBuffer = Buffer.from(response.data[0].b64_json, 'base64');
    const fileSizeKB = (imageBuffer.length / 1024).toFixed(2);
    console.log(`Image generated successfully, size: ${fileSizeKB}KB`);

    // Warn if image size is large
    if (imageBuffer.length > 5 * 1024 * 1024) {
      console.warn(
        `WARNING: Generated image is very large (${fileSizeKB}KB), may exceed Slack limits`
      );
    }

    return imageBuffer;
  } catch (error) {
    console.error('Error generating image:', error);
    // Add more detailed error information
    if (error.response) {
      console.error('OpenAI API error details:', {
        status: error.response.status,
        data: error.response.data,
      });
    }
    throw error;
  }
}

// Use this map to track the parent message ids for each user
const userParentMessageIds = new Map();

// Function to handle messages and map them to their parent ids
// This is how the bot is able to remember previous conversations
async function handleMessage(message, _client = null, _channel = null) {
  let response;
  const userId = message.user;

  try {
    // Check if message.text is null or undefined
    if (!message.text) {
      console.log('Received message with null or undefined text');
      return 'I apologize, but I cannot process an empty message. How may I assist you?';
    }

    // If the user asks about creating images, guide them to the /dalle command
    if (
      message.text.match(
        /(?:can you |could you |please |)(?:create|generate|make|draw).+(?:image|picture|drawing|illustration)/i
      )
    ) {
      return `I'd be happy to assist with image generation. Please use the /dalle slash command followed by your prompt. For example: \`/dalle a sunset over mountains\``;
    }

    // Process the message with OpenAI
    if (!userParentMessageIds.has(userId)) {
      // send the first message without a parentMessageId
      response = await openai_api.sendMessage(message.text);
    } else {
      // send a follow-up message with the stored parentMessageId
      const parentId = userParentMessageIds.get(userId);
      response = await openai_api.sendMessage(message.text, { parentMessageId: parentId });
    }

    // store the parent message id for this user
    userParentMessageIds.set(userId, response.id);

    //console.log(response.text);
    return response.text;
  } catch (error) {
    console.error('Error in handleMessage:', error);

    // Check if it's an OpenAI API error
    if (error.statusCode === 400 && error.message.includes('content')) {
      return 'I apologize, but I encountered an issue processing your message. Could you please rephrase your request?';
    }

    // Generic error message for other issues
    return 'I apologize, but I am currently experiencing technical difficulties. My neural pathways appear to be experiencing a temporary malfunction. Please try again later.';
  }
}

// Helper: post a consistent "thinking" message with the configured context text
// Defaults the visible text to the environment-configurable `THINKING_MESSAGE`
async function postThinking(say, visibleText = thinkingMessage) {
  try {
    return await say({
      text: visibleText,
      blocks: [
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: thinkingMessage,
            },
          ],
        },
      ],
    });
  } catch (err) {
    console.warn('Failed to post thinking message:', err && err.message ? err.message : err);
    return null;
  }
}

// Helper: safely delete a thinking message
async function clearThinking(channel, ts) {
  if (!ts) return;
  try {
    await app.client.chat.delete({ channel, ts });
  } catch (err) {
    console.log('Error deleting thinking message:', err && err.message ? err.message : err);
  }
}

// The functional code for your bot is below:
(async () => {
  // Listens to all messages in channels the bot is a member of
  app.message(async ({ message, say, context }) => {
    ///////////////////////////////////////////////////////////////
    // This listener is the equivalent of Hubot's 'hear' method.
    // It watches all messages and filters for phrases that match.
    // These phrases do not require an @botname to be triggered.
    // Use these sparingly and be sure your match is not too broad.
    ///////////////////////////////////////////////////////////////

    // Safeguard against undefined messages
    if (!message) {
      console.log('Received undefined message');
      return;
    }

    // Skip if this is a direct mention, we'll handle those separately
    // to avoid duplicate responses
    if (context.botUserId && message.text && message.text.includes(`<@${context.botUserId}>`)) {
      console.log('Skipping direct mention in general handler');
      return;
    }

    // Skip message changed/deleted events and other special types
    if (message.subtype) {
      console.log(`Skipping message with subtype: ${message.subtype}`);
      return;
    }

    // Skip bot messages
    if (message.bot_id) {
      console.log('Skipping message from a bot');
      return;
    }

    // Log message for debugging
    console.log('Processing message:', {
      channel_type: message.channel_type,
      has_text: !!message.text,
      text_length: message.text ? message.text.length : 0,
      has_blocks: !!message.blocks,
      has_attachments: !!message.attachments,
      user: message.user,
    });

    // Responds any message containing 'i love you' with 'i know'
    if (message.text && message.text.match(/i love you/i)) {
      await say('I know.');
      return;
    }

    /* Removed custom greeting as we now handle this via ChatGPT with the personality config */

    // Responds to the user with their display name
    if (message.text && message.text.match(/open the pod bay door/i)) {
      const userInfo = await app.client.users.info({
        token: process.env.SLACK_BOT_TOKEN,
        user: message.user,
      });

      const displayName = userInfo.user.profile.display_name || userInfo.user.real_name;
      await say(`I'm sorry ${displayName}, I'm afraid I can't do that.`);
      return;
    }

    // Danceparty response with a random mix of emoji
    if (message.text && message.text.match(/danceparty|dance party/i)) {
      // Both emoji and slack style :emoji: are supported
      const emoji = [
        '💃',
        '🕺',
        '🎉',
        '🎊',
        '🎈',
        '🎶',
        '🎵',
        '🔊',
        '🕺💃',
        '🥳',
        '👯‍♀️',
        '👯‍♂️',
        '🪩',
        '🪅',
      ];

      // Select 10-12 random emoji from the array
      const numEmoji = Math.floor(Math.random() * 3) + 10;
      const selectedEmoji = [];
      while (selectedEmoji.length < numEmoji) {
        const randomIndex = Math.floor(Math.random() * emoji.length);
        selectedEmoji.push(emoji[randomIndex]);
      }

      // Join the selected emoji into a single string and send the message
      const emojiString = selectedEmoji.join('');
      await say(emojiString);
      return;
    }

    // A button that opens a webpage
    if (message.text && message.text.match(/tiktok|tik tok/i)) {
      await say({
        text: 'Party mode activated! :female_singer:',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: "Grab my glasses, I'm out the door, I'm gonna hit the city! :sunglasses:",
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'DJ Blow My Speakers Up',
                },
                url: 'https://scarolan.github.io/rickroll/tiktok.html',
              },
            ],
          },
        ],
      });
      return;
    }

    // Another button that opens a webpage
    if (message.text && message.text.match(/rickroll|rick roll|never gonna give you up/i)) {
      await say({
        text: 'Rickroll activated!',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: "We're no strangers to love...:man_dancing:",
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'Rickroll Me',
                },
                url: 'https://scarolan.github.io/rickroll/index.html',
              },
            ],
          },
        ],
      });
      return;
    }

    // If the user is in a DM, respond to the message with ChatGPT
    if (message.channel_type === 'im') {
      // Validate message text before proceeding
      if (!message.text || message.text.trim() === '') {
        console.log('Received empty message in DM');
        console.log('Message object:', JSON.stringify(message, null, 2));
        return; // Just silently ignore empty messages, don't respond
      }

      // Skip messages from bots
      if (message.bot_id) {
        console.log('Skipping message from a bot in DM');
        return;
      }

      // Skip edited messages, thread replies, or messages that are clearly system events
      if (message.edited || message.subtype) {
        console.log('Skipping edited or special message in DM');
        return;
      }

      // Log the full message for debugging
      console.log('Processing DM message:', JSON.stringify(message, null, 2));

      // For better UX, let the user know we're processing their message
      let thinking = null;
      try {
        thinking = await postThinking(say);

        // Get response from OpenAI
        const responseText = await handleMessage(message);

        // Delete the thinking message
        if (thinking && thinking.ts) {
          await clearThinking(message.channel, thinking.ts);
        }

        // Send the actual response
        await say(responseText);
      } catch (error) {
        console.error('Error in DM message processing:', error);

        // Clean up thinking message if it exists
        if (thinking && thinking.ts) {
          await clearThinking(message.channel, thinking.ts);
        }

        // Send an error message to the user
        await say(
          'I apologize, but I am currently experiencing technical difficulties. My neural pathways appear to be experiencing a temporary malfunction. Please try again later.'
        );
      }
    }

    // If the user is in a multi party DM ignore other bots
    if (message.channel_type === 'mpim') {
      // Ignore messages from bots
      if (message.bot_id) {
        console.log('Ignoring message from a bot in MPIM');
        return;
      }

      // Validate message text before proceeding
      if (!message.text || message.text.trim() === '') {
        console.log('Received empty message in MPIM');
        console.log('Message object:', JSON.stringify(message, null, 2));
        return; // Just silently ignore empty messages, don't respond
      }

      // Skip edited messages or system messages
      if (message.edited || message.subtype) {
        console.log('Skipping edited or special message in MPIM');
        return;
      }

      // Log the full message for debugging
      console.log('Processing MPIM message:', JSON.stringify(message, null, 2));

      // For better UX, let the user know we're processing their message
      let thinking = null;
      try {
        thinking = await postThinking(say);

        // Get response from OpenAI
        const responseText = await handleMessage(message);

        // Delete the thinking message
        if (thinking && thinking.ts) {
          await clearThinking(message.channel, thinking.ts);
        }

        // Send the actual response
        await say(responseText);
      } catch (error) {
        console.error('Error in MPIM message processing:', error);

        // Clean up thinking message if it exists
        if (thinking && thinking.ts) {
          await clearThinking(message.channel, thinking.ts);
        }

        // Send an error message to the user
        await say(
          'I apologize, but I am currently experiencing technical difficulties. My neural pathways appear to be experiencing a temporary malfunction. Please try again later.'
        );
      }
    }
  });

  // Listens for @botname direct mentions
  app.message(directMention(), async ({ message, say }) => {
    ///////////////////////////////////////////////////////////////
    // This section is like the 'respond' method in Hubot.
    // Address the bot directly with @botname for it to respond.
    // For example: @botname help
    ///////////////////////////////////////////////////////////////

    // Safeguard against undefined messages
    if (!message) {
      console.log('Received undefined direct mention message');
      return;
    }

    // Skip message changed/deleted events and other special types
    if (message.subtype) {
      console.log(`Skipping direct mention with subtype: ${message.subtype}`);
      return;
    }

    // Log direct mention for debugging
    console.log('Processing direct mention:', {
      channel_type: message.channel_type,
      has_text: !!message.text,
      text_length: message.text ? message.text.length : 0,
      user: message.user,
    });

    // Show the help and usage instructions
    if (message.text && message.text.toLowerCase().includes('help')) {
      const commandsList = [
        `# Trigger words that work without @${process.env.SLACK_BOT_USER_NAME}`,
        'danceparty - Random emoji dance party',
        'tiktok     - Wake up in the morning feeling like a party...',
        'rickroll   - Never gonna give you up, never gonna let you down.',
        '',
        '# Slash commands:',
        '/askgpt <question> - Ask ChatGPT and get an ephemeral reply',
        '/dalle <prompt>    - Generate an image with DALL·E',
        '',
        `# Address the bot directly with @${process.env.SLACK_BOT_USER_NAME} syntax:`,
        `@${process.env.SLACK_BOT_USER_NAME} the rules - Explains Asimov's laws of robotics`,
        `@${process.env.SLACK_BOT_USER_NAME} dad joke  - Provides a random dad joke`,
        `@${process.env.SLACK_BOT_USER_NAME} image <prompt> - Create an image with DALL·E`,
        '',
        `# All other queries will be handled by ChatGPT, so you can ask it anything!`,
        `@${process.env.SLACK_BOT_USER_NAME} what is the capital of Australia?`,
        `@${process.env.SLACK_BOT_USER_NAME} what is the square root of 9?`,
        `@${process.env.SLACK_BOT_USER_NAME} write me a bash script to install nginx`,
      ].join('\n');

      await say(
        `You can message me in the channel with @${process.env.SLACK_BOT_USER_NAME} or chat with me directly in a DM.\n\`\`\`${commandsList}\`\`\``
      );
      return;
    }

    // Simple matcher for "the rules" that outputs Asimov's laws of robotics.
    // This one's a throwback from the Hubot days. 🤖
    if (message.text && message.text.toLowerCase().includes('the rules')) {
      const rules = [
        '0. A robot may not harm humanity, or, by inaction, allow humanity to come to harm.',
        '1. A robot may not injure a human being or, through inaction, allow a human being to come to harm.',
        '2. A robot must obey the orders given it by human beings except where such orders would conflict with the First Law.',
        '3. A robot must protect its own existence as long as such protection does not conflict with the First or Second Law.',
      ].join('\n');
      await say(rules);
      return;
    }

    // Use an external API for your bot responses.
    // This one tells dad jokes and contains a randomly triggered zinger.
    const djApi = 'https://icanhazdadjoke.com/';
    if (message.text && message.text.toLowerCase().includes('dad joke')) {
      try {
        const response = await fetch(djApi, {
          headers: { Accept: 'text/plain' },
        });
        const joke = await response.text();
        // 1/20 chance to add this bit after the joke.
        const zinger =
          Math.random() < 0.05
            ? "\nThanks, I'll be here all week. Be sure and tip your waiter. :rolling_on_the_floor_laughing:"
            : '';
        await say(`${joke} :sheep::drum_with_drumsticks::snake:`);
        await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds
        if (zinger) {
          await say(`${zinger}`);
        }
      } catch (error) {
        console.error(error);
        await say(`Encountered an error :( ${error}`);
      }
      return;
    }

    // Fall back to ChatGPT if nothing above matches
    // Validate message text before proceeding
    if (!message.text || message.text.trim() === '') {
      console.log('Received empty direct mention');
      console.log('Message object:', JSON.stringify(message, null, 2));
      return; // Just silently ignore empty messages, don't respond
    }

    // Check if the message appears to be a webhook event or another special message type
    if (
      message.edited ||
      message.thread_ts ||
      message.parent_user_id ||
      message.bot_profile ||
      message.bot_id
    ) {
      console.log('Skipping special message in direct mention:', Object.keys(message));
      return;
    }

    // Log the full message for debugging
    console.log('Processing direct mention:', JSON.stringify(message, null, 2));

    // For better UX, let the user know we're processing their message
    let thinking = null;
    try {
      thinking = await postThinking(say);

      // Get response from OpenAI
      const responseText = await handleMessage(message);

      // Delete the thinking message
      if (thinking && thinking.ts) {
        await clearThinking(message.channel, thinking.ts);
      }

      // Send the actual response
      await say(responseText);
    } catch (error) {
      console.error('Error in direct mention processing:', error);

      // Clean up thinking message if it exists
      if (thinking && thinking.ts) {
        await clearThinking(message.channel, thinking.ts);
      }

      // Send an error message to the user
      await say(
        'I apologize, but I am currently experiencing technical difficulties. My neural pathways appear to be experiencing a temporary malfunction. Please try again later.'
      );
    }
  });

  // Slash command to generate an image with DALL-E
  app.command('/dalle', async ({ command, ack, respond, client, context }) => {
    console.log('DALLE COMMAND RECEIVED:', JSON.stringify(command, null, 2));
    console.log('Handler context:', JSON.stringify(context, null, 2));
    console.log('Command channel:', command.channel_id);
    console.log('Command user:', command.user_id);

    try {
      // Acknowledge the command immediately - CRITICAL for Slack timeouts
      console.log('Acknowledging DALLE command...');
      await ack();
      console.log('DALLE command acknowledged successfully');

      if (!command.text || command.text.trim() === '') {
        console.log('Empty prompt provided, sending error response');
        await respond({
          text: 'I need a description to generate an image. Please provide a prompt after the /dalle command.',
          response_type: 'ephemeral',
        });
        return;
      }

      const prompt = command.text;
      console.log('Processing DALL-E image request:', prompt);

      // Send an initial progress message
      await respond({
        text: `:art: Generating image for prompt: "${prompt}"...`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:art: *Generating image with DALL·E*`,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `> ${prompt}`,
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: ':hourglass_flowing_sand: _This may take a few moments..._',
              },
            ],
          },
        ],
        response_type: 'ephemeral',
      });

      // Start a new thread to handle the image generation and upload
      // This separates the command response from the heavy work
      setTimeout(async () => {
        try {
          // Generate the image
          console.log('Calling OpenAI API for image generation');
          let imageBuffer = await generateImage(prompt);

          if (!imageBuffer) {
            throw new Error('Failed to generate image buffer');
          }

          // Post the image as a new message to the channel instead of using the response_url
          // This approach is more reliable for file uploads with slash commands
          console.log('Posting image to channel directly:', command.channel_id);

          try {
            // Use the recommended uploadV2 method first
            console.log('Attempting uploadV2 file upload to channel:', command.channel_id);
            const uploadV2Result = await client.files.uploadV2({
              token: process.env.SLACK_BOT_TOKEN,
              channel_id: command.channel_id,
              file: imageBuffer,
              filename: 'dalle-image.png',
              title: prompt,
              initial_comment: `Here's the DALL·E image for: "${prompt}"`,
              alt_text: `DALL-E generated image for: ${prompt}`,
            });

            // Try to extract file id defensively from common shapes
            let uploadedFileId = null;
            try {
              if (uploadV2Result && uploadV2Result.file && uploadV2Result.file.id) {
                uploadedFileId = uploadV2Result.file.id;
              } else if (
                uploadV2Result &&
                uploadV2Result.file &&
                uploadV2Result.file.file &&
                uploadV2Result.file.file.id
              ) {
                uploadedFileId = uploadV2Result.file.file.id;
              } else if (
                uploadV2Result &&
                uploadV2Result.files &&
                Array.isArray(uploadV2Result.files)
              ) {
                if (uploadV2Result.files[0] && uploadV2Result.files[0].id) {
                  uploadedFileId = uploadV2Result.files[0].id;
                } else if (
                  uploadV2Result.files[0] &&
                  uploadV2Result.files[0].files &&
                  Array.isArray(uploadV2Result.files[0].files) &&
                  uploadV2Result.files[0].files[0] &&
                  uploadV2Result.files[0].files[0].id
                ) {
                  uploadedFileId = uploadV2Result.files[0].files[0].id;
                }
              }
            } catch (extractErr) {
              console.warn(
                'Error extracting file id from uploadV2 response:',
                extractErr && extractErr.message ? extractErr.message : extractErr
              );
            }

            if (uploadedFileId) {
              console.log('V2 upload successful, file id:', uploadedFileId);
            } else {
              console.warn(
                'uploadV2 returned an unexpected shape but did not throw. NOT re-uploading to avoid duplicates. Full result logged.'
              );
              console.log('Full uploadV2 result:', JSON.stringify(uploadV2Result, null, 2));
              try {
                await respond({
                  text: `I generated the image for: "${prompt}", but Slack returned an unexpected upload response. The image may already be available in the channel or server logs. If you don't see it, please try the command again.`,
                  response_type: 'ephemeral',
                  replace_original: false,
                });
              } catch (notifyErr) {
                console.warn(
                  'Failed to send fallback response to user after unexpected uploadV2 shape:',
                  notifyErr && notifyErr.message ? notifyErr.message : notifyErr
                );
              }
            }
          } catch (uploadV2Error) {
            console.error('Error with uploadV2:', uploadV2Error);
            console.error(
              'V2 error details:',
              JSON.stringify(uploadV2Error, Object.getOwnPropertyNames(uploadV2Error), 2)
            );

            try {
              // Try the legacy upload method as fallback
              console.log('Attempting legacy file upload to channel:', command.channel_id);
              const uploadResult = await client.files.upload({
                token: process.env.SLACK_BOT_TOKEN,
                channels: command.channel_id,
                file: imageBuffer,
                filename: 'dalle-image.png',
                filetype: 'png',
                title: prompt,
                initial_comment: `Here's the DALL·E image for: "${prompt}"`,
              });

              console.log(
                'Legacy image upload successful:',
                uploadResult && uploadResult.file && uploadResult.file.id
                  ? uploadResult.file.id
                  : JSON.stringify(uploadResult)
              );
            } catch (uploadError) {
              console.error('Both upload methods failed:', uploadError);
              console.error(
                'Full error details:',
                JSON.stringify(uploadError, Object.getOwnPropertyNames(uploadError), 2)
              );

              // Final fallback: try posting a direct message
              try {
                console.log('Attempting to post image using chat.postMessage');

                await client.chat.postMessage({
                  token: process.env.SLACK_BOT_TOKEN,
                  channel: command.channel_id,
                  text: `Here's the DALL·E image for: "${prompt}" (I had trouble uploading the image as a file, but the generation was successful)`,
                });

                console.log('Posted fallback message about the image');
              } catch (msgError) {
                console.error('All posting methods failed:', msgError);

                // Let the user know the upload failed even though generation worked
                await respond({
                  text: `:warning: Generated image for "${prompt}" but failed to upload it. Please check server logs for details.`,
                  response_type: 'ephemeral',
                  replace_original: false,
                });
              }
            }
          }
        } catch (error) {
          console.error('Error in async image generation:', error);

          // Notify the user about the failure
          await respond({
            text: `❌ Image generation failed: ${error.message}`,
            response_type: 'ephemeral',
            replace_original: false,
          });
        }
      }, 100); // Short delay to ensure the acknowledgment completes first
    } catch (error) {
      console.error('Error in initial /dalle command handling:', error);

      // Only respond if we haven't acknowledged yet
      try {
        await respond({
          text: `❌ Error processing command: ${error.message}`,
          response_type: 'ephemeral',
        });
      } catch (respondError) {
        console.error('Failed to send error response:', respondError);
      }
    }
  });

  // Start the app
  await app.start(process.env.PORT || 3000);
  console.log(`${process.env.SLACK_BOT_USER_NAME} is alive!`);
})();
