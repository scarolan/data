// Pure helpers and matchers for canned trigger-word responses.
// Bolt handlers in app.js are thin shims around these functions.

// In-character apology shown when a turn fails hard. Single source of truth:
// both the chat layer (backend errors) and the Bolt handlers (reply failures)
// import this so the two error paths always speak with one voice.
export const GENERIC_ERROR_TEXT =
  'I apologize, but I am currently experiencing technical difficulties. My neural pathways appear to be experiencing a temporary malfunction. Please try again later.';

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
  return (
    text.length <= 240 &&
    /(?:can you |could you |please )?(?:create|generate|make|draw)\b.+\b(?:image|picture|drawing|illustration)\b/i.test(
      text
    )
  );
}

export const IMAGE_REQUEST_GUIDANCE = `For image generation, please use the \`/image\` slash command followed by your prompt. For example: \`/image a sunset over the Enterprise\``;

// Strip Slack mention tokens (<@U123>) so trigger matchers see only the
// human-typed words, not the "@Data" that prefixes every direct mention.
function stripMentions(text) {
  return (text || '').replace(/<@[^>]+>/g, ' ');
}

// The help menu is a command, not a topic. Trigger it only when "help" is
// essentially the whole message — NOT when the word appears mid-sentence.
// A bare includes('help') used to hijack "help me debug this" and even
// "that was helpful", swallowing real chat before it reached the LLM.
export function isHelpRequest(text) {
  return /^\s*help[\s.!?]*$/i.test(stripMentions(text));
}

// Asimov's-laws easter egg. Matches "the rules" as a standalone phrase
// (word-boundaried) rather than as an arbitrary substring.
export function isTheRules(text) {
  return /\bthe rules\b/i.test(stripMentions(text));
}

export function buildHelpText(botName) {
  const commandsList = [
    `# Trigger words that work without @${botName}`,
    'i love you            - You already know how I feel',
    'open the pod bay door - A classic sci-fi refusal',
    'danceparty            - Random emoji dance party',
    'tiktok                - Wake up in the morning feeling like a party...',
    'rickroll              - Never gonna give you up, never gonna let you down.',
    '',
    '# Slash commands:',
    '/image <prompt> - Generate an image with Gemini',
    '/forget         - Erase my memory of our conversation',
    '',
    `# Address the bot directly with @${botName} syntax:`,
    `@${botName} help      - Show this help message`,
    `@${botName} the rules - Explains Asimov's laws of robotics`,
    `@${botName} dad joke  - Provides a random dad joke`,
    '',
    `# All other queries are answered by my language model, so you can ask me anything!`,
    `@${botName} what is the capital of Australia?`,
    `@${botName} what is the square root of 9?`,
    `@${botName} write me a bash script to install nginx`,
    '',
    `# I can see images too — attach one and ask me about it.`,
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
