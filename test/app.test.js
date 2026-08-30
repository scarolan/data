import test from 'node:test';
import assert from 'node:assert';

import { runChatTurn, makeStreamSink } from '../app.js';

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

// --- Streaming --------------------------------------------------------------

// Quacks like @slack/web-api's ChatStreamer: append/stop plus a `ts` that is
// undefined until the first successful flush.
function makeFakeStreamer({ appendThrows = false, stopThrows = false } = {}) {
  const streamer = {
    appends: [],
    stops: [],
    ts: undefined,
    async append(args) {
      if (appendThrows) throw new Error('append failed');
      streamer.appends.push(args);
      streamer.ts = streamer.ts || '999.111';
    },
    async stop(args) {
      if (stopThrows) throw new Error('stop failed');
      streamer.stops.push(args ?? null);
      streamer.ts = streamer.ts || '999.111';
    },
  };
  return streamer;
}

// Adapter fake with a chatStream that pushes the reply in two chunks, and
// optionally dies mid-stream.
function makeFakeStreamingChat({ reply = 'Affirmative.', failMidStream = false } = {}) {
  return {
    async chat() {
      return { text: reply };
    },
    async chatStream({ onDelta }) {
      const mid = Math.ceil(reply.length / 2);
      await onDelta(reply.slice(0, mid));
      if (failMidStream) throw new Error('stream died');
      await onDelta(reply.slice(mid));
      return { text: reply };
    },
  };
}

test('runChatTurn streams the reply and does not double-post via say', async () => {
  const streamer = makeFakeStreamer();
  const deps = makeDeps({ chat: makeFakeStreamingChat({ reply: 'Affirmative.' }) });
  const say = makeSay();

  await runChatTurn({
    message: { ...baseMessage },
    say,
    deps,
    errorLabel: 'test:',
    streamFactory: () => streamer,
  });

  assert.strictEqual(say.calls.length, 0);
  assert.deepStrictEqual(streamer.appends.map((a) => a.markdown_text).join(''), 'Affirmative.');
  assert.strictEqual(streamer.stops.length, 1);
  // Reaction UX still applies around the streamed turn.
  assert.strictEqual(deps.app.added.length, 1);
  assert.strictEqual(deps.app.removed.length, 1);
});

test('runChatTurn falls back to say() when streaming fails before anything is visible', async () => {
  const streamer = makeFakeStreamer({ appendThrows: true });
  const deps = makeDeps({ chat: makeFakeStreamingChat({ reply: 'Affirmative.' }) });
  const say = makeSay();

  await runChatTurn({
    message: { ...baseMessage },
    say,
    deps,
    errorLabel: 'test:',
    streamFactory: () => streamer,
  });

  assert.deepStrictEqual(say.calls, ['Affirmative.']);
  assert.strictEqual(streamer.stops.length, 0);
});

test('runChatTurn appends the apology as a trailer when the backend dies mid-stream', async () => {
  const streamer = makeFakeStreamer();
  const deps = makeDeps({ chat: makeFakeStreamingChat({ failMidStream: true }) });
  const say = makeSay();

  await runChatTurn({
    message: { ...baseMessage },
    say,
    deps,
    errorLabel: 'test:',
    streamFactory: () => streamer,
  });

  // Partial content is finalized with the apology appended — no separate say().
  assert.strictEqual(say.calls.length, 0);
  assert.strictEqual(streamer.stops.length, 1);
  assert.match(streamer.stops[0].markdown_text, /neural pathways/);
});

test('runChatTurn with a non-streaming adapter never opens a stream', async () => {
  const streamer = makeFakeStreamer();
  const deps = makeDeps(); // makeFakeChat: chat() only
  const say = makeSay();

  await runChatTurn({
    message: { ...baseMessage },
    say,
    deps,
    errorLabel: 'test:',
    streamFactory: () => streamer,
  });

  assert.deepStrictEqual(say.calls, ['Affirmative.']);
  assert.strictEqual(streamer.appends.length, 0);
  assert.strictEqual(streamer.stops.length, 0);
});

// --- makeStreamSink ---------------------------------------------------------

test('makeStreamSink creates the streamer lazily and reports inactive with no deltas', async () => {
  let created = 0;
  const sink = makeStreamSink(() => {
    created += 1;
    return makeFakeStreamer();
  });
  assert.strictEqual(sink.active, false);
  assert.strictEqual(await sink.finish(), false);
  assert.strictEqual(created, 0);
});

test('makeStreamSink reports posted when stop fails after content is visible', async () => {
  const streamer = makeFakeStreamer({ stopThrows: true });
  const sink = makeStreamSink(() => streamer);
  await sink.push('some content');
  // ts is set (message visible), so a failed stop still counts as posted —
  // returning false here would make the caller double-post via say().
  assert.strictEqual(await sink.finish(), true);
});
