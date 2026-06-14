// Pure helpers and matchers for canned trigger-word responses.
// Bolt handlers in app.js are thin shims around these functions.

export const ASIMOV_RULES = [
  '0. A robot may not harm humanity, or, by inaction, allow humanity to come to harm.',
  '1. A robot may not injure a human being or, through inaction, allow a human being to come to harm.',
  '2. A robot must obey the orders given it by human beings except where such orders would conflict with the First Law.',
  '3. A robot must protect its own existence as long as such protection does not conflict with the First or Second Law.',
].join('\n');

export const DANCE_PARTY_EMOJI = [
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

export function isLoveYou(text) {
  return !!text && /i love you/i.test(text);
}

export function isPodBayDoor(text) {
  return !!text && /open the pod bay door/i.test(text);
}

export function formatPodBayResponse(displayName) {
  return `I'm sorry ${displayName}, I'm afraid I can't do that.`;
}

export function isDanceParty(text) {
  return !!text && /danceparty|dance party/i.test(text);
}

export function buildDancePartyMessage(rng = Math.random) {
  const numEmoji = Math.floor(rng() * 3) + 10;
  const selected = [];
  while (selected.length < numEmoji) {
    selected.push(DANCE_PARTY_EMOJI[Math.floor(rng() * DANCE_PARTY_EMOJI.length)]);
  }
  return selected.join('');
}

export function isTikTok(text) {
  return !!text && /tiktok|tik tok/i.test(text);
}

export const TIKTOK_BLOCKS = {
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
          text: { type: 'plain_text', text: 'DJ Blow My Speakers Up' },
          url: 'https://scarolan.github.io/rickroll/tiktok.html',
        },
      ],
    },
  ],
};

export function isRickroll(text) {
  return !!text && /rickroll|rick roll|never gonna give you up/i.test(text);
}

export const RICKROLL_BLOCKS = {
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
          text: { type: 'plain_text', text: 'Rickroll Me' },
          url: 'https://scarolan.github.io/rickroll/index.html',
        },
      ],
    },
  ],
};

export function isImageRequest(text) {
  if (!text) return false;
  return /(?:can you |could you |please |)(?:create|generate|make|draw).+(?:image|picture|drawing|illustration)/i.test(
    text
  );
}

export const IMAGE_REQUEST_GUIDANCE = `I'd be happy to assist with image generation. Please use the /image slash command followed by your prompt. For example: \`/image a sunset over mountains\``;

export function buildHelpText(botName) {
  const commandsList = [
    `# Trigger words that work without @${botName}`,
    'danceparty - Random emoji dance party',
    'tiktok     - Wake up in the morning feeling like a party...',
    'rickroll   - Never gonna give you up, never gonna let you down.',
    '',
    '# Slash commands:',
    '/askgpt <question> - Ask ChatGPT and get an ephemeral reply',
    '/image <prompt>    - Generate an image with Gemini',
    '',
    `# Address the bot directly with @${botName} syntax:`,
    `@${botName} the rules - Explains Asimov's laws of robotics`,
    `@${botName} dad joke  - Provides a random dad joke`,
    `@${botName} image <prompt> - Create an image with Gemini`,
    '',
    `# All other queries will be handled by ChatGPT, so you can ask it anything!`,
    `@${botName} what is the capital of Australia?`,
    `@${botName} what is the square root of 9?`,
    `@${botName} write me a bash script to install nginx`,
  ].join('\n');

  return `You can message me in the channel with @${botName} or chat with me directly in a DM.\n\`\`\`${commandsList}\`\`\``;
}

const DAD_JOKE_URL = 'https://icanhazdadjoke.com/';

// Inject `fetch` to make this testable without hitting the network.
export async function fetchDadJoke(fetchImpl) {
  const response = await fetchImpl(DAD_JOKE_URL, { headers: { Accept: 'text/plain' } });
  return response.text();
}

export function formatDadJoke(joke, rng = Math.random) {
  const zinger =
    rng() < 0.05
      ? "\nThanks, I'll be here all week. Be sure and tip your waiter. :rolling_on_the_floor_laughing:"
      : '';
  return {
    joke: `${joke} :sheep::drum_with_drumsticks::snake:`,
    zinger,
  };
}
