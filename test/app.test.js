import test from 'node:test';
import assert from 'node:assert';

import { runChatTurn, runThreadSummary, makeStreamSink, registerHandlers, start } from '../app.js';

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

test('makeStreamSink reports not posted when stop fails before anything is visible', async () => {
  const streamer = makeFakeStreamer({ stopThrows: true });
  const sink = makeStreamSink(() => streamer);
  await sink.push('x');
  streamer.ts = undefined;
  assert.strictEqual(await sink.finish(), false);
});

// --- Vision: image extraction (fetch is the external boundary) --------------

function fakeFetchResponse({ ok = true, status = 200, body = 'png-bytes' } = {}) {
  return {
    ok,
    status,
    async arrayBuffer() {
      return new TextEncoder().encode(body).buffer;
    },
    async text() {
      return body;
    },
  };
}

test('runChatTurn fetches supported image attachments with the bot token and passes them to chat', async (t) => {
  const fetchCalls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    fetchCalls.push({ url, opts });
    if (url.endsWith('/bad')) return fakeFetchResponse({ ok: false, status: 403 });
    if (url.endsWith('/boom')) throw new Error('network down');
    return fakeFetchResponse({ body: 'img' });
  });
  const deps = makeDeps();
  const say = makeSay();

  await runChatTurn({
    message: {
      ...baseMessage,
      text: 'what is this?',
      files: [
        { id: 'F1', mimetype: 'image/png', url_private: 'https://files/ok' },
        { id: 'F2', mimetype: 'image/jpeg', url_private: 'https://files/bad' },
        { id: 'F3', mimetype: 'image/gif', url_private: 'https://files/boom' },
        { id: 'F4', mimetype: 'application/pdf', url_private: 'https://files/pdf' },
      ],
    },
    say,
    deps,
    errorLabel: 'test:',
  });

  assert.strictEqual(fetchCalls.length, 3);
  assert.deepStrictEqual(fetchCalls[0].opts, { headers: { Authorization: 'Bearer xoxb-test' } });
  const userTurn = deps.chat.calls[0].messages.at(-1);
  assert.deepStrictEqual(userTurn.images, [
    { mimeType: 'image/png', data: Buffer.from('img').toString('base64') },
  ]);
  assert.deepStrictEqual(say.calls, ['Affirmative.']);
});

test('runChatTurn skips unsupported attachments without fetching', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => fakeFetchResponse());
  const deps = makeDeps();
  const say = makeSay();

  await runChatTurn({
    message: {
      ...baseMessage,
      files: [{ id: 'F1', mimetype: 'text/plain', url_private: 'https://files/txt' }],
    },
    say,
    deps,
    errorLabel: 'test:',
  });

  assert.strictEqual(fetchMock.mock.callCount(), 0);
  assert.strictEqual(deps.chat.calls[0].messages.at(-1).images, undefined);
});

test('runChatTurn tolerates a failing reaction removal', async () => {
  const app = makeFakeApp();
  app.client.reactions.remove = async () => {
    throw new Error('no_reaction');
  };
  const deps = makeDeps({ app });
  const say = makeSay();

  await runChatTurn({ message: { ...baseMessage }, say, deps, errorLabel: 'test:' });

  assert.deepStrictEqual(say.calls, ['Affirmative.']);
});

// --- runThreadSummary -------------------------------------------------------

function makeFakeSlackClient({ messages = [], repliesThrows = false } = {}) {
  const streams = [];
  return {
    streams,
    conversations: {
      async replies() {
        if (repliesThrows) throw new Error('channel_not_found');
        return { messages };
      },
    },
    users: {
      async info({ user }) {
        return { user: { profile: { display_name: `name-${user}` } } };
      },
    },
    chatStream(args) {
      const s = makeFakeStreamer();
      s.args = args;
      streams.push(s);
      return s;
    },
  };
}

const threadMessages = [
  { ts: '100.0', user: 'U1', text: 'We should ship Friday' },
  { ts: '100.1', user: 'U2', text: 'Agreed' },
];

test('runThreadSummary summarizes via say() when not streaming', async () => {
  const deps = makeDeps({ chat: makeFakeChat({ reply: 'Briefing.' }), botName: 'Data' });
  const client = makeFakeSlackClient({ messages: threadMessages });
  const say = makeSay();

  await runThreadSummary({
    message: { channel: 'C1', ts: '100.9', thread_ts: '100.0' },
    deps,
    client,
    context: { botUserId: 'B1' },
    say,
  });

  assert.deepStrictEqual(say.calls, ['Briefing.']);
  assert.match(deps.chat.calls[0].messages[0].content, /name-U1: We should ship Friday/);
  assert.strictEqual(deps.app.added.length, 1);
  assert.strictEqual(deps.app.removed.length, 1);
});

test('runThreadSummary streams the summary when a stream factory is provided', async () => {
  const streamer = makeFakeStreamer();
  const deps = makeDeps({ chat: makeFakeStreamingChat({ reply: 'Briefing.' }) });
  const client = makeFakeSlackClient({ messages: threadMessages });
  const say = makeSay();

  await runThreadSummary({
    message: { channel: 'C1', ts: '100.0' },
    deps,
    client,
    context: { botUserId: 'B1' },
    say,
    streamFactory: () => streamer,
  });

  assert.strictEqual(say.calls.length, 0);
  assert.strictEqual(streamer.appends.map((a) => a.markdown_text).join(''), 'Briefing.');
  assert.strictEqual(streamer.stops.length, 1);
});

test('runThreadSummary replies with the generic error when the Slack fetch fails', async () => {
  const deps = makeDeps();
  const client = makeFakeSlackClient({ repliesThrows: true });
  const say = makeSay();

  await runThreadSummary({
    message: { channel: 'C1', ts: '100.9', thread_ts: '100.0' },
    deps,
    client,
    context: {},
    say,
  });

  assert.strictEqual(say.calls.length, 1);
  assert.match(say.calls[0], /neural pathways/);
  assert.strictEqual(deps.app.removed.length, 1);
});

// --- registerHandlers -------------------------------------------------------
//
// A fake Bolt app that captures the registered listeners so each handler can
// be invoked directly with fake Bolt args.

function makeFakeBoltApp() {
  const app = makeFakeApp();
  app.handlers = { commands: {} };
  app.userInfoCalls = [];
  app.userInfo = async () => ({ user: { profile: { display_name: 'Geordi' } } });
  app.client.users = {
    info: async (args) => {
      app.userInfoCalls.push(args);
      return app.userInfo(args);
    },
  };
  app.message = (...args) => {
    if (args.length === 1) app.handlers.message = args[0];
    else app.handlers.mention = args[1];
  };
  app.command = (name, fn) => {
    app.handlers.commands[name] = fn;
  };
  return app;
}

function setupHandlers(overrides = {}) {
  const app = makeFakeBoltApp();
  const deps = makeDeps({ app, botName: 'Data', streamReplies: false, ...overrides });
  registerHandlers(deps);
  return { app, deps };
}

function messageArgs(message, { context = {}, client } = {}) {
  const say = makeSay();
  return {
    say,
    args: {
      message,
      say,
      client: client || makeFakeSlackClient({ messages: threadMessages }),
      context: { botUserId: 'B1', teamId: 'T1', userId: 'U1', ...context },
    },
  };
}

test('registerHandlers registers message, mention and slash command listeners', () => {
  const { app } = setupHandlers();
  assert.strictEqual(typeof app.handlers.message, 'function');
  assert.strictEqual(typeof app.handlers.mention, 'function');
  assert.deepStrictEqual(Object.keys(app.handlers.commands).sort(), ['/forget', '/image']);
});

test('message handler ignores undefined, bot-mentioning, subtype and bot messages', async () => {
  const { app, deps } = setupHandlers();
  const cases = [
    undefined,
    { ...baseMessage, channel_type: 'im', text: 'hi <@B1>' },
    { ...baseMessage, channel_type: 'im', subtype: 'message_changed' },
    { ...baseMessage, channel_type: 'im', bot_id: 'BX' },
    { ...baseMessage, channel_type: 'im', bot_profile: {} },
  ];
  for (const message of cases) {
    const { say, args } = messageArgs(message);
    await app.handlers.message(args);
    assert.strictEqual(say.calls.length, 0);
  }
  assert.strictEqual(deps.chat.calls.length, 0);
});

test('message handler answers canned trigger words', async () => {
  const { app } = setupHandlers();
  const run = async (text) => {
    const { say, args } = messageArgs({ ...baseMessage, channel_type: 'channel', text });
    await app.handlers.message(args);
    return say.calls;
  };

  assert.deepStrictEqual(await run('I love you, Data'), ['I know.']);
  assert.deepStrictEqual(await run('open the pod bay door'), [
    "I'm sorry Geordi, I'm afraid I can't do that.",
  ]);
  assert.strictEqual(app.userInfoCalls[0].token, 'xoxb-test');
  assert.strictEqual((await run('danceparty')).length, 1);
  assert.match((await run('tiktok')).at(0).text, /Party mode/);
  assert.match((await run('rickroll')).at(0).text, /Rickroll/);
});

test('message handler pod bay falls back to real_name, then "Dave" on users.info failure', async () => {
  const { app } = setupHandlers();
  app.userInfo = async () => ({ user: { profile: {}, real_name: 'Jean-Luc' } });
  let { say, args } = messageArgs({ ...baseMessage, text: 'open the pod bay door' });
  await app.handlers.message(args);
  assert.match(say.calls[0], /Jean-Luc/);

  app.userInfo = async () => {
    throw new Error('ratelimited');
  };
  ({ say, args } = messageArgs({ ...baseMessage, text: 'open the pod bay door' }));
  await app.handlers.message(args);
  assert.match(say.calls[0], /Dave/);
});

test('message handler ignores non-trigger channel messages', async () => {
  const { app, deps } = setupHandlers();
  const { say, args } = messageArgs({ ...baseMessage, channel_type: 'channel' });
  await app.handlers.message(args);
  assert.strictEqual(say.calls.length, 0);
  assert.strictEqual(deps.chat.calls.length, 0);
});

test('message handler routes DMs (including file_share) to the chat turn', async () => {
  const { app, deps } = setupHandlers();
  const { say, args } = messageArgs({ ...baseMessage, channel_type: 'im', subtype: 'file_share' });
  await app.handlers.message(args);
  assert.deepStrictEqual(say.calls, ['Affirmative.']);
  assert.strictEqual(deps.chat.calls.length, 1);
});

test('message handler streams DM replies rooted at the user message when enabled', async () => {
  const { app } = setupHandlers({
    streamReplies: true,
    chat: makeFakeStreamingChat({ reply: 'Streamed.' }),
  });
  const client = makeFakeSlackClient();
  const { say, args } = messageArgs({ ...baseMessage, channel_type: 'mpim' }, { client });
  await app.handlers.message(args);

  assert.strictEqual(say.calls.length, 0);
  assert.strictEqual(client.streams.length, 1);
  assert.deepStrictEqual(client.streams[0].args, {
    channel: 'C1',
    thread_ts: '111.222',
    recipient_team_id: 'T1',
    recipient_user_id: 'U1',
    buffer_size: 64,
  });
});

test('message handler gives summary guidance for a DM summary request outside a thread', async () => {
  const { app, deps } = setupHandlers();
  const { say, args } = messageArgs({
    ...baseMessage,
    channel_type: 'im',
    text: 'summarize this thread',
  });
  await app.handlers.message(args);
  assert.strictEqual(say.calls.length, 1);
  assert.match(say.calls[0], /from within the thread/);
  assert.strictEqual(deps.chat.calls.length, 0);
});

test('message handler summarizes a DM thread in-thread without streaming', async () => {
  const { app } = setupHandlers({ chat: makeFakeChat({ reply: 'Briefing.' }) });
  const { say, args } = messageArgs({
    ...baseMessage,
    channel_type: 'im',
    thread_ts: '100.0',
    text: 'summarize',
  });
  await app.handlers.message(args);
  assert.deepStrictEqual(say.calls, [{ text: 'Briefing.', thread_ts: '100.0' }]);
});

test('message handler streams a DM thread summary into the thread when enabled', async () => {
  const { app } = setupHandlers({
    streamReplies: true,
    chat: makeFakeStreamingChat({ reply: 'Briefing.' }),
  });
  const client = makeFakeSlackClient({ messages: threadMessages });
  const { say, args } = messageArgs(
    { ...baseMessage, channel_type: 'im', thread_ts: '100.0', text: 'tl;dr' },
    { client, context: { teamId: undefined, enterpriseId: 'E1' } }
  );
  await app.handlers.message(args);

  assert.strictEqual(say.calls.length, 0);
  assert.strictEqual(client.streams[0].args.thread_ts, '100.0');
  assert.strictEqual(client.streams[0].args.recipient_team_id, 'E1');
});

// --- direct mention handler -------------------------------------------------

function mentionArgs(message, { sayStream } = {}) {
  const { say, args } = messageArgs(message);
  return { say, args: { ...args, sayStream } };
}

test('mention handler ignores undefined, subtype and bot messages', async () => {
  const { app, deps } = setupHandlers();
  for (const message of [
    undefined,
    { ...baseMessage, subtype: 'channel_join' },
    { ...baseMessage, bot_id: 'BX' },
  ]) {
    const { say, args } = mentionArgs(message);
    await app.handlers.mention(args);
    assert.strictEqual(say.calls.length, 0);
  }
  assert.strictEqual(deps.chat.calls.length, 0);
});

test('mention handler replies in-thread with help and the rules', async () => {
  const { app } = setupHandlers();
  let { say, args } = mentionArgs({ ...baseMessage, text: '<@B1> help' });
  await app.handlers.mention(args);
  assert.strictEqual(say.calls[0].thread_ts, '111.222');
  assert.match(say.calls[0].text, /@Data help/);

  ({ say, args } = mentionArgs({ ...baseMessage, thread_ts: '100.0', text: '<@B1> the rules' }));
  await app.handlers.mention(args);
  assert.deepStrictEqual(say.calls[0].thread_ts, '100.0');
  assert.match(say.calls[0].text, /A robot may not/);
});

test('mention handler tells a dad joke and posts the zinger after a delay', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeFetchResponse({ body: 'I am a joke.' }));
  t.mock.method(Math, 'random', () => 0);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { app } = setupHandlers();
  const { say, args } = mentionArgs({ ...baseMessage, text: '<@B1> tell me a dad joke' });

  await app.handlers.mention(args);
  assert.strictEqual(say.calls.length, 1);
  assert.match(say.calls[0].text, /^I am a joke\./);

  t.mock.timers.tick(10000);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(say.calls.length, 2);
  assert.match(say.calls[1].text, /tip your waiter/);
});

test('mention handler logs a failed zinger post without throwing', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeFetchResponse({ body: 'joke' }));
  t.mock.method(Math, 'random', () => 0);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = [];
  t.mock.method(console, 'error', (...a) => errors.push(a));
  const { app } = setupHandlers();
  const { args } = mentionArgs({ ...baseMessage, text: '<@B1> dad joke' });
  let n = 0;
  args.say = async () => {
    n += 1;
    if (n === 2) throw new Error('slack down');
  };

  await app.handlers.mention(args);
  t.mock.timers.tick(10000);
  await new Promise((r) => setImmediate(r));
  assert.match(String(errors.at(-1)[0]), /zinger/);
});

test('mention handler reports dad joke fetch failures in-thread', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('offline');
  });
  const { app } = setupHandlers();
  const { say, args } = mentionArgs({ ...baseMessage, text: '<@B1> dad joke' });
  await app.handlers.mention(args);
  assert.match(say.calls[0].text, /Encountered an error.*offline/);
});

test('mention handler summarizes the thread, streaming via sayStream when enabled', async () => {
  const streamer = makeFakeStreamer();
  const sayStreamArgs = [];
  const { app } = setupHandlers({
    streamReplies: true,
    chat: makeFakeStreamingChat({ reply: 'Briefing.' }),
  });
  const { say, args } = mentionArgs(
    { ...baseMessage, thread_ts: '100.0', text: '<@B1> summarize this thread' },
    {
      sayStream: (a) => {
        sayStreamArgs.push(a);
        return streamer;
      },
    }
  );
  await app.handlers.mention(args);
  assert.strictEqual(say.calls.length, 0);
  assert.deepStrictEqual(sayStreamArgs, [{ buffer_size: 64 }]);
  assert.strictEqual(streamer.stops.length, 1);
});

test('mention handler summarizes via say when streaming is off', async () => {
  const { app } = setupHandlers({ chat: makeFakeChat({ reply: 'Briefing.' }) });
  const { say, args } = mentionArgs({ ...baseMessage, thread_ts: '100.0', text: '<@B1> summary' });
  await app.handlers.mention(args);
  assert.deepStrictEqual(say.calls, [{ text: 'Briefing.', thread_ts: '100.0' }]);
});

test('mention handler routes everything else to an in-thread chat turn', async () => {
  const { app, deps } = setupHandlers();
  const { say, args } = mentionArgs({ ...baseMessage, text: '<@B1> what is warp 9?' });
  await app.handlers.mention(args);
  assert.deepStrictEqual(say.calls, [{ text: 'Affirmative.', thread_ts: '111.222' }]);
  assert.strictEqual(deps.chat.calls.length, 1);
});

test('mention handler streams chat replies via sayStream when enabled', async () => {
  const streamer = makeFakeStreamer();
  const { app } = setupHandlers({
    streamReplies: true,
    chat: makeFakeStreamingChat({ reply: 'Streamed.' }),
  });
  const { say, args } = mentionArgs(
    { ...baseMessage, text: '<@B1> hi' },
    { sayStream: () => streamer }
  );
  await app.handlers.mention(args);
  assert.strictEqual(say.calls.length, 0);
  assert.strictEqual(streamer.appends.map((a) => a.markdown_text).join(''), 'Streamed.');
});

// --- /image -----------------------------------------------------------------

function makeCommandArgs(command, { ackThrows = false, respondThrows = false } = {}) {
  const responses = [];
  const uploads = [];
  let acked = 0;
  return {
    responses,
    uploads,
    get acked() {
      return acked;
    },
    args: {
      command: { channel_id: 'C1', user_id: 'U1', ...command },
      async ack() {
        acked += 1;
        if (ackThrows) throw new Error('ack failed');
      },
      async respond(payload) {
        if (respondThrows) throw new Error('respond failed');
        responses.push(payload);
      },
      client: {
        files: {
          async uploadV2(args) {
            uploads.push(args);
          },
        },
      },
    },
  };
}

const flushMicrotasks = () => new Promise((r) => setImmediate(r));

function makeFakeGemini({ fail = false } = {}) {
  return {
    models: {
      async generateContent() {
        if (fail) throw new Error('quota exceeded');
        return {
          candidates: [
            {
              content: { parts: [{ inlineData: { data: Buffer.from('PNG').toString('base64') } }] },
            },
          ],
        };
      },
    },
  };
}

test('/image asks for a prompt when none is given', async () => {
  const { app } = setupHandlers();
  const cmd = makeCommandArgs({ text: '   ' });
  await app.handlers.commands['/image'](cmd.args);
  assert.strictEqual(cmd.acked, 1);
  assert.match(cmd.responses[0].text, /I need a description/);
  assert.strictEqual(cmd.responses[0].response_type, 'ephemeral');
});

test('/image generates and uploads the image to the channel', async () => {
  const { app } = setupHandlers({ geminiClient: makeFakeGemini(), geminiImageModel: 'img-model' });
  const cmd = makeCommandArgs({ text: 'a starship' });
  await app.handlers.commands['/image'](cmd.args);
  await flushMicrotasks();

  assert.match(cmd.responses[0].text, /Generating image for prompt: "a starship"/);
  assert.strictEqual(cmd.uploads.length, 1);
  assert.strictEqual(cmd.uploads[0].channel_id, 'C1');
  assert.strictEqual(cmd.uploads[0].token, 'xoxb-test');
  assert.strictEqual(cmd.uploads[0].file.toString(), 'PNG');
  assert.strictEqual(cmd.uploads[0].title, 'a starship');
});

test('/image reports async generation failures ephemerally', async () => {
  const { app } = setupHandlers({ geminiClient: makeFakeGemini({ fail: true }) });
  const cmd = makeCommandArgs({ text: 'a starship' });
  await app.handlers.commands['/image'](cmd.args);
  await flushMicrotasks();

  assert.strictEqual(cmd.uploads.length, 0);
  assert.match(cmd.responses.at(-1).text, /Image generation failed: quota exceeded/);
  assert.strictEqual(cmd.responses.at(-1).replace_original, false);
});

test('/image reports an error when ack fails, and survives respond failing too', async () => {
  const { app } = setupHandlers();
  const cmd = makeCommandArgs({ text: 'x' }, { ackThrows: true });
  await app.handlers.commands['/image'](cmd.args);
  assert.match(cmd.responses[0].text, /Error processing command: ack failed/);

  const both = makeCommandArgs({ text: 'x' }, { ackThrows: true, respondThrows: true });
  await assert.doesNotReject(app.handlers.commands['/image'](both.args));
});

// --- /forget ----------------------------------------------------------------

test('/forget clears the invoking user history and confirms ephemerally', async () => {
  const { app, deps } = setupHandlers();
  await deps.convoStore.set('convo:U1', [{ role: 'user', content: 'hi' }]);
  const cmd = makeCommandArgs({});
  await app.handlers.commands['/forget'](cmd.args);

  assert.strictEqual(await deps.convoStore.get('convo:U1'), undefined);
  assert.match(cmd.responses[0].text, /blank slate/);
  assert.strictEqual(cmd.responses[0].response_type, 'ephemeral');
});

test('/forget reports store failures, and survives respond failing too', async () => {
  const convoStore = makeFakeConvoStore();
  convoStore.delete = async () => {
    throw new Error('redis down');
  };
  const { app } = setupHandlers({ convoStore });
  const cmd = makeCommandArgs({});
  await app.handlers.commands['/forget'](cmd.args);
  assert.match(cmd.responses[0].text, /unable to clear.*redis down/);

  const both = makeCommandArgs({}, { respondThrows: true });
  await assert.doesNotReject(app.handlers.commands['/forget'](both.args));
});

// --- start ------------------------------------------------------------------

test('start registers handlers, starts the app, and wires graceful shutdown', async (t) => {
  const listeners = {};
  t.mock.method(process, 'on', (event, fn) => {
    listeners[event] = fn;
    return process;
  });
  const exit = t.mock.method(process, 'exit', () => {});
  t.mock.method(console, 'error', () => {});

  const app = makeFakeBoltApp();
  let started = null;
  let stops = 0;
  app.start = async (port) => {
    started = port;
  };
  app.stop = async () => {
    stops += 1;
    if (stops === 2) throw new Error('already stopped');
  };

  await start(makeDeps({ app }));

  assert.ok(started !== null);
  assert.strictEqual(typeof app.handlers.message, 'function');
  assert.deepStrictEqual(Object.keys(listeners).sort(), ['SIGINT', 'SIGTERM', 'uncaughtException']);

  await listeners.SIGINT();
  await listeners.SIGTERM();
  listeners.uncaughtException(new Error('kaboom'));
  await flushMicrotasks();
  assert.strictEqual(stops, 3);
  assert.strictEqual(exit.mock.callCount(), 3);
  assert.deepStrictEqual(exit.mock.calls[0].arguments, [0]);
});
