import test from 'node:test';
import assert from 'node:assert';

import { runChatTurn } from '../app.js';

// Importing app.js MUST be safe with no env set and no Slack/Redis available.
// If validateRequiredEnv or the IIFE ever sneaks back in unguarded, this fails.
test('importing app.js does not boot the bot or require env vars', async () => {
  const app = await import('../app.js');
  // Smoke-check that the public surface is exported.
  assert.strictEqual(typeof app.handleMessage, 'function');
  assert.strictEqual(typeof app.generateImage, 'function');
});

// --- runChatTurn ----------------------------------------------------------
//
// The shared pipeline behind both the DM and @-mention handlers. It drives the
// real handleMessage against injected chat/convoStore fakes (same pattern as
// chat.test.js) plus a fake Bolt app for the :brain: reaction and a recording
// `say`. No message.files, so extractMessageImages short-circuits with no fetch.

function makeFakeApp({ addThrows = false } = {}) {
  const added = [];
  const removed = [];
  return {
    added,
    removed,
    client: {
      reactions: {
        async add(args) {
          if (addThrows) throw new Error('missing_scope');
          added.push(args);
        },
        async remove(args) {
          removed.push(args);
        },
      },
    },
  };
}

function makeFakeConvoStore() {
  const data = new Map();
  return {
    async get(key) {
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
      return true;
    },
    async delete(key) {
      return data.delete(key);
    },
  };
}

function makeFakeChat({ reply = 'Affirmative.' } = {}) {
  const calls = [];
  return {
    calls,
    async chat({ messages }) {
      calls.push({ messages });
      return { text: reply };
    },
  };
}

function makeSay({ throwOnce = false } = {}) {
  const calls = [];
  let thrown = false;
  const fn = async (payload) => {
    calls.push(payload);
    if (throwOnce && !thrown) {
      thrown = true;
      throw new Error('slack unavailable');
    }
  };
  fn.calls = calls;
  return fn;
}

function makeDeps(overrides = {}) {
  return {
    app: makeFakeApp(),
    chat: makeFakeChat(),
    convoStore: makeFakeConvoStore(),
    botToken: 'xoxb-test',
    ...overrides,
  };
}

const baseMessage = { text: 'hello there', user: 'U1', channel: 'C1', ts: '111.222' };

test('runChatTurn adds a reaction, routes to chat, removes the reaction, and replies', async () => {
  const deps = makeDeps();
  const say = makeSay();

  await runChatTurn({ message: { ...baseMessage }, say, deps, errorLabel: 'test:' });

  assert.deepStrictEqual(say.calls, ['Affirmative.']);
  assert.strictEqual(deps.chat.calls.length, 1);
  assert.deepStrictEqual(deps.app.added, [{ channel: 'C1', timestamp: '111.222', name: 'brain' }]);
  assert.deepStrictEqual(deps.app.removed, [
    { channel: 'C1', timestamp: '111.222', name: 'brain' },
  ]);
});

test('runChatTurn still replies when the reaction fails to land, and skips removal', async () => {
  const deps = makeDeps({ app: makeFakeApp({ addThrows: true }) });
  const say = makeSay();

  await runChatTurn({ message: { ...baseMessage }, say, deps, errorLabel: 'test:' });

  assert.deepStrictEqual(say.calls, ['Affirmative.']);
  assert.strictEqual(deps.app.added.length, 0);
  assert.strictEqual(deps.app.removed.length, 0);
});

test('runChatTurn ignores messages with no text and no files', async () => {
  const deps = makeDeps();
  const say = makeSay();

  await runChatTurn({
    message: { ...baseMessage, text: '   ' },
    say,
    deps,
    errorLabel: 'test:',
  });

  assert.strictEqual(say.calls.length, 0);
  assert.strictEqual(deps.chat.calls.length, 0);
  assert.strictEqual(deps.app.added.length, 0);
});

test('runChatTurn ignores edited messages', async () => {
  const deps = makeDeps();
  const say = makeSay();

  await runChatTurn({
    message: { ...baseMessage, edited: { ts: '111.999' } },
    say,
    deps,
    errorLabel: 'test:',
  });

  assert.strictEqual(say.calls.length, 0);
  assert.strictEqual(deps.chat.calls.length, 0);
});

test('runChatTurn nudges image requests to /image without hitting the chat backend', async () => {
  const deps = makeDeps();
  const say = makeSay();

  await runChatTurn({
    message: { ...baseMessage, text: 'draw me a picture of the Enterprise' },
    say,
    deps,
    errorLabel: 'test:',
  });

  assert.strictEqual(say.calls.length, 1);
  assert.match(say.calls[0], /\/image/);
  assert.strictEqual(deps.chat.calls.length, 0);
  assert.strictEqual(deps.app.added.length, 0);
});

test('runChatTurn falls back to the generic error text and clears the reaction when a reply throws', async () => {
  const deps = makeDeps();
  const say = makeSay({ throwOnce: true });

  await runChatTurn({ message: { ...baseMessage }, say, deps, errorLabel: 'test:' });

  assert.strictEqual(say.calls.length, 2);
  assert.match(say.calls[1], /neural pathways/);
  // Reaction removed once in the try (before the throwing say) and again in the catch.
  assert.strictEqual(deps.app.removed.length, 2);
});
