// Tool registry. Each tool exposes a JSON-Schema-shaped definition the model
// can see, and an `execute(args)` that runs the side effect and returns a
// short string fed back to the model on its next turn.
//
// makeTools() is called per-message in app.js so the closures can capture
// the right Slack channel for uploads, the right fetch implementation, etc.

import { generateImage } from './image.js';
import {
  ASIMOV_RULES,
  RICKROLL_BLOCKS,
  TIKTOK_BLOCKS,
  buildDancePartyMessage,
  buildHelpText,
  fetchDadJoke,
  formatDadJoke,
} from './responses.js';

export function makeTools({
  geminiClient,
  geminiImageModel,
  slackUploadImage,
  slackPostBlocks,
  fetch: fetchImpl,
  botName,
  rng = Math.random,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  return [
    {
      name: 'generate_image',
      description:
        'Generate an image with Gemini and post it to the current channel. Use whenever the user asks you to draw, create, generate, or show them a picture, illustration, drawing, or image.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'Detailed visual description of the image to generate. Include subject, style, mood, composition.',
          },
        },
        required: ['prompt'],
      },
      async execute({ prompt }) {
        if (!geminiClient) {
          return 'Image generation is unavailable: GEMINI_API_KEY is not configured.';
        }
        const buffer = await generateImage(prompt, {
          client: geminiClient,
          model: geminiImageModel,
        });
        await slackUploadImage({ buffer, prompt });
        return `Image generated and posted to the channel for prompt: "${prompt}".`;
      },
    },
    {
      name: 'tell_dad_joke',
      description:
        'Fetch a random dad joke from icanhazdadjoke.com and post it to the channel. Use when the user asks for a joke or the conversation calls for one.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const raw = await fetchDadJoke(fetchImpl);
        const { joke, zinger } = formatDadJoke(raw, rng);
        await slackPostBlocks(joke);
        if (zinger) {
          await sleep(10000);
          await slackPostBlocks(zinger);
        }
        return `Posted a dad joke: ${raw}`;
      },
    },
    {
      name: 'state_asimovs_laws',
      description:
        "Recite Asimov's Three (plus Zeroth) Laws of Robotics. Use when the user asks about 'the rules' or robot ethics.",
      parameters: { type: 'object', properties: {} },
      async execute() {
        await slackPostBlocks(ASIMOV_RULES);
        return "Recited Asimov's laws.";
      },
    },
    {
      name: 'show_help',
      description:
        'Show the bot help text listing trigger words, slash commands, and example queries. Use when the user asks for help or how to use the bot.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        await slackPostBlocks(buildHelpText(botName));
        return 'Posted the help text.';
      },
    },
    {
      name: 'start_dance_party',
      description:
        'Post a random emoji dance party message. Use when the user asks for a dance party or celebration.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        await slackPostBlocks(buildDancePartyMessage(rng));
        return 'Started a dance party.';
      },
    },
    {
      name: 'play_rickroll',
      description: 'Post a Rickroll link button. Use when the user asks to be rickrolled.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        await slackPostBlocks(RICKROLL_BLOCKS);
        return 'Posted the rickroll.';
      },
    },
    {
      name: 'play_tiktok',
      description:
        'Post a TikTok-themed party-mode message with a button. Use when the user asks for tiktok or party mode.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        await slackPostBlocks(TIKTOK_BLOCKS);
        return 'Posted TikTok party mode.';
      },
    },
  ];
}
