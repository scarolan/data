import test from 'node:test';
import assert from 'node:assert';

import { handleMessage } from '../lib/chat.js';

// Minimal in-memory convoStore that quacks like Keyv (async get/set).
function makeFakeConvoStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(key) {
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
      return true;
    },
  };
}

function makeFakeChat({ reply = 'pong', shouldThrow = null } = {}) {
  const calls = [];
  return {
    calls,
    async chat({ messages }) {
      calls.push({ messages });
      if (shouldThrow) throw shouldThrow;
      return { text: reply };
    },
  };
}

// A chat fake that walks through a predetermined sequence of responses
// (each call consumes one). Lets tests script multi-turn tool dispatch.
function makeScriptedChat(responses) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async chat({ messages, tools }) {
      calls.push({ messages, tools });
      const next = responses[Math.min(i, responses.length - 1)];
      i++;
      return next;
    },
  };
}

test('handleMessage returns an apology for empty text without calling chat', async () => {
  const chat = makeFakeChat();
  const result = await handleMessage(
    { text: '', user: 'U1' },
    { chat, convoStore: makeFakeConvoStore() }
  );
  assert.match(result, /cannot process an empty message/);
  assert.strictEqual(chat.calls.length, 0);
});

test('handleMessage persists per-user history across calls', async () => {
  const chat = makeFakeChat({ reply: 'hi back' });
  const convoStore = makeFakeConvoStore();

  const first = await handleMessage({ text: 'hi', user: 'U1' }, { chat, convoStore });
  assert.strictEqual(first, 'hi back');
  assert.deepStrictEqual(chat.calls[0].messages, [{ role: 'user', content: 'hi' }]);

  const second = await handleMessage({ text: 'still there?', user: 'U1' }, { chat, convoStore });
  assert.strictEqual(second, 'hi back');
  assert.deepStrictEqual(chat.calls[1].messages, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hi back' },
    { role: 'user', content: 'still there?' },
  ]);

  const stored = await convoStore.get('convo:U1');
  assert.strictEqual(stored.length, 4);
  assert.strictEqual(stored[3].content, 'hi back');
});

test('handleMessage keeps per-user history isolated', async () => {
  const chat = makeFakeChat({ reply: 'reply' });
  const convoStore = makeFakeConvoStore();

  await handleMessage({ text: 'hi from U1', user: 'U1' }, { chat, convoStore });
  await handleMessage({ text: 'hi from U2', user: 'U2' }, { chat, convoStore });

  assert.deepStrictEqual(chat.calls[1].messages, [{ role: 'user', content: 'hi from U2' }]);
});

test('handleMessage trims history to the configured limit', async () => {
  const chat = makeFakeChat({ reply: 'r' });
  const convoStore = makeFakeConvoStore();

  for (let i = 0; i < 5; i++) {
    await handleMessage({ text: `msg ${i}`, user: 'U1' }, { chat, convoStore, historyLimit: 4 });
  }

  const stored = await convoStore.get('convo:U1');
  assert.strictEqual(stored.length, 4);
  assert.strictEqual(stored[0].content, 'msg 3');
  assert.strictEqual(stored[2].content, 'msg 4');
});

test('handleMessage rehydrates history from convoStore on cold start', async () => {
  const convoStore = makeFakeConvoStore({
    'convo:U1': [
      { role: 'user', content: 'remember this' },
      { role: 'assistant', content: 'noted' },
    ],
  });
  const chat = makeFakeChat({ reply: 'ack' });

  await handleMessage({ text: 'do you remember?', user: 'U1' }, { chat, convoStore });
  assert.deepStrictEqual(chat.calls[0].messages, [
    { role: 'user', content: 'remember this' },
    { role: 'assistant', content: 'noted' },
    { role: 'user', content: 'do you remember?' },
  ]);
});

test('handleMessage returns a friendly rephrase message on content/policy errors', async () => {
  const err = new Error('blocked by safety filter');
  const chat = makeFakeChat({ shouldThrow: err });
  const result = await handleMessage(
    { text: 'hi', user: 'U1' },
    { chat, convoStore: makeFakeConvoStore() }
  );
  assert.match(result, /rephrase your request/);
});

test('handleMessage falls back to the generic apology on other errors', async () => {
  const chat = makeFakeChat({ shouldThrow: new Error('boom') });
  const result = await handleMessage(
    { text: 'hi', user: 'U1' },
    { chat, convoStore: makeFakeConvoStore() }
  );
  assert.match(result, /neural pathways/);
});

test('handleMessage does not persist history when the backend errors', async () => {
  const convoStore = makeFakeConvoStore({
    'convo:U1': [{ role: 'user', content: 'prior' }],
  });
  const chat = makeFakeChat({ shouldThrow: new Error('boom') });
  await handleMessage({ text: 'hi', user: 'U1' }, { chat, convoStore });

  const stored = await convoStore.get('convo:U1');
  assert.deepStrictEqual(stored, [{ role: 'user', content: 'prior' }]);
});

// --- Tool dispatch ---------------------------------------------------------

test('handleMessage executes a tool call and feeds the result back to the model', async () => {
  const toolCalls = [];
  const tools = [
    {
      name: 'echo',
      description: 'returns its arg',
      parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      async execute({ x }) {
        toolCalls.push(x);
        return `echoed: ${x}`;
      },
    },
  ];
  const chat = makeScriptedChat([
    { text: '', toolCalls: [{ name: 'echo', args: { x: 'hello' } }] },
    { text: 'I echoed it for you.' },
  ]);

  const reply = await handleMessage(
    { text: 'echo hello', user: 'U1' },
    { chat, convoStore: makeFakeConvoStore(), tools }
  );

  assert.strictEqual(reply, 'I echoed it for you.');
  assert.deepStrictEqual(toolCalls, ['hello']);

  // Second model call sees the assistant turn with tool_calls + the tool result.
  const second = chat.calls[1].messages;
  assert.strictEqual(second[1].role, 'assistant');
  assert.deepStrictEqual(second[1].toolCalls, [{ name: 'echo', args: { x: 'hello' } }]);
  assert.strictEqual(second[2].role, 'tool');
  assert.strictEqual(second[2].toolName, 'echo');
  assert.strictEqual(second[2].content, 'echoed: hello');
});

test('handleMessage persists only the final assistant text — tool traffic is ephemeral', async () => {
  const tools = [
    {
      name: 'noop',
      description: 'does nothing',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return 'ok';
      },
    },
  ];
  const chat = makeScriptedChat([
    { text: '', toolCalls: [{ name: 'noop', args: {} }] },
    { text: 'Final answer.' },
  ]);
  const convoStore = makeFakeConvoStore();

  await handleMessage({ text: 'go', user: 'U1' }, { chat, convoStore, tools });

  const stored = await convoStore.get('convo:U1');
  // Only user + final assistant — no tool round-trip in persistent history.
  assert.strictEqual(stored.length, 2);
  assert.deepStrictEqual(stored, [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'Final answer.' },
  ]);
});

test('handleMessage surfaces tool-execution errors as model-visible strings', async () => {
  const tools = [
    {
      name: 'boom',
      description: '',
      parameters: { type: 'object', properties: {} },
      async execute() {
        throw new Error('kaboom');
      },
    },
  ];
  const chat = makeScriptedChat([
    { text: '', toolCalls: [{ name: 'boom', args: {} }] },
    { text: 'Sorry, that did not work.' },
  ]);

  const reply = await handleMessage(
    { text: 'try it', user: 'U1' },
    { chat, convoStore: makeFakeConvoStore(), tools }
  );
  assert.strictEqual(reply, 'Sorry, that did not work.');
  const toolMsg = chat.calls[1].messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /kaboom/);
});

test('handleMessage returns an unknown-tool error message when the model hallucinates a tool', async () => {
  const chat = makeScriptedChat([
    { text: '', toolCalls: [{ name: 'nonexistent', args: {} }] },
    { text: 'Pretend that worked.' },
  ]);

  await handleMessage(
    { text: 'go', user: 'U1' },
    { chat, convoStore: makeFakeConvoStore(), tools: [] }
  );
  const toolMsg = chat.calls[1].messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /unknown tool/);
});

// --- Vision ---------------------------------------------------------------

test('handleMessage attaches images to the user turn and strips them on persist', async () => {
  const chat = makeFakeChat({ reply: 'I see a cat.' });
  const convoStore = makeFakeConvoStore();
  const images = [{ mimeType: 'image/png', data: 'YWJj' }];

  const reply = await handleMessage(
    { text: 'what is this?', user: 'U1', images },
    { chat, convoStore }
  );

  assert.strictEqual(reply, 'I see a cat.');
  // Image was on the wire turn.
  assert.deepStrictEqual(chat.calls[0].messages[0].images, images);
  // History stores only the text portion of the user turn.
  const stored = await convoStore.get('convo:U1');
  assert.deepStrictEqual(stored, [
    { role: 'user', content: 'what is this?' },
    { role: 'assistant', content: 'I see a cat.' },
  ]);
});

test('handleMessage accepts images with empty text', async () => {
  const chat = makeFakeChat({ reply: 'A cat.' });
  const convoStore = makeFakeConvoStore();
  const images = [{ mimeType: 'image/png', data: 'YWJj' }];
  const reply = await handleMessage({ text: '', user: 'U1', images }, { chat, convoStore });
  assert.strictEqual(reply, 'A cat.');
});

test('handleMessage still rejects truly empty (no text, no images) input', async () => {
  const chat = makeFakeChat();
  const reply = await handleMessage(
    { text: '', user: 'U1' },
    { chat, convoStore: makeFakeConvoStore() }
  );
  assert.match(reply, /cannot process an empty message/);
  assert.strictEqual(chat.calls.length, 0);
});

test('handleMessage handles multiple tool calls in one turn', async () => {
  const executed = [];
  const tools = [
    {
      name: 'a',
      description: '',
      parameters: { type: 'object', properties: {} },
      async execute() {
        executed.push('a');
        return 'result-a';
      },
    },
    {
      name: 'b',
      description: '',
      parameters: { type: 'object', properties: {} },
      async execute() {
        executed.push('b');
        return 'result-b';
      },
    },
  ];
  const chat = makeScriptedChat([
    {
      text: '',
      toolCalls: [
        { name: 'a', args: {} },
        { name: 'b', args: {} },
      ],
    },
    { text: 'Both done.' },
  ]);

  await handleMessage(
    { text: 'go', user: 'U1' },
    { chat, convoStore: makeFakeConvoStore(), tools }
  );
  assert.deepStrictEqual(executed, ['a', 'b']);
});
