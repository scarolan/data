import test from 'node:test';
import assert from 'node:assert';

import { makeOllamaChat, makeGeminiChat } from '../lib/chat-backends.js';

// --- Ollama --------------------------------------------------------------

function makeFakeOllama(replyOrFn) {
  const calls = [];
  return {
    calls,
    async chat(req) {
      calls.push(req);
      const r = typeof replyOrFn === 'function' ? replyOrFn(req) : replyOrFn;
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

function ollamaReply(content) {
  return { message: { role: 'assistant', content } };
}

test('Ollama adapter prepends the system message and forwards the model', async () => {
  const ollama = makeFakeOllama(ollamaReply('hello'));
  const chat = makeOllamaChat({
    model: 'llama3.1',
    systemMessage: 'You are Data.',
    client: ollama,
  });

  const { text } = await chat.chat({ messages: [{ role: 'user', content: 'hi' }] });

  assert.strictEqual(text, 'hello');
  assert.strictEqual(ollama.calls[0].model, 'llama3.1');
  assert.strictEqual(ollama.calls[0].stream, false);
  assert.deepStrictEqual(ollama.calls[0].messages, [
    { role: 'system', content: 'You are Data.' },
    { role: 'user', content: 'hi' },
  ]);
});

test('Ollama adapter strips Llama tokenizer artifacts from replies', async () => {
  const ollama = makeFakeOllama(ollamaReply('<|begin_of_text|>clean me<|eot_id|>'));
  const chat = makeOllamaChat({ model: 'llama3.1', client: ollama });
  const { text } = await chat.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(text, 'clean me');
});

test('Ollama adapter omits the system message when none is configured', async () => {
  const ollama = makeFakeOllama(ollamaReply('ok'));
  const chat = makeOllamaChat({ model: 'llama3.1', client: ollama });
  await chat.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.deepStrictEqual(ollama.calls[0].messages, [{ role: 'user', content: 'hi' }]);
});

test('Ollama adapter returns empty string when the response has no content', async () => {
  const ollama = {
    async chat() {
      return { message: { role: 'assistant' } };
    },
  };
  const chat = makeOllamaChat({ model: 'llama3.1', client: ollama });
  const { text } = await chat.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(text, '');
});

test('Ollama adapter propagates errors from the underlying client', async () => {
  const ollama = makeFakeOllama(new Error('connection refused'));
  const chat = makeOllamaChat({ model: 'llama3.1', client: ollama });
  await assert.rejects(() => chat.chat({ messages: [{ role: 'user', content: 'hi' }] }), {
    message: 'connection refused',
  });
});

test('Ollama adapter passes think through and surfaces message.thinking', async () => {
  const ollama = makeFakeOllama({
    message: { role: 'assistant', content: 'Four.', thinking: 'computing 2+2' },
  });
  const chat = makeOllamaChat({ model: 'qwq', client: ollama, think: true });
  const { text, thinking } = await chat.chat({
    messages: [{ role: 'user', content: '2+2?' }],
  });
  assert.strictEqual(text, 'Four.');
  assert.strictEqual(thinking, 'computing 2+2');
  assert.strictEqual(ollama.calls[0].think, true);
});

test('Ollama adapter omits think param when not configured', async () => {
  const ollama = makeFakeOllama(ollamaReply('ok'));
  const chat = makeOllamaChat({ model: 'llama3.1', client: ollama });
  await chat.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(ollama.calls[0].think, undefined);
});

test('Ollama adapter translates images on the user turn to native base64 strings', async () => {
  const ollama = makeFakeOllama(ollamaReply('I see a cat.'));
  const chat = makeOllamaChat({ model: 'llava', client: ollama });
  await chat.chat({
    messages: [
      {
        role: 'user',
        content: 'what is this?',
        images: [
          { mimeType: 'image/png', data: 'YWJj' },
          { mimeType: 'image/jpeg', data: 'eHl6' },
        ],
      },
    ],
  });
  assert.deepStrictEqual(ollama.calls[0].messages[0], {
    role: 'user',
    content: 'what is this?',
    images: ['YWJj', 'eHl6'],
  });
});

// --- Gemini --------------------------------------------------------------

function makeFakeGeminiClient(replyOrFn) {
  const calls = [];
  return {
    calls,
    models: {
      async generateContent(req) {
        calls.push(req);
        const r = typeof replyOrFn === 'function' ? replyOrFn(req) : replyOrFn;
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
}

test('Gemini adapter translates roles and lifts the system message', async () => {
  const client = makeFakeGeminiClient({ text: 'hi back' });
  const chat = makeGeminiChat({
    client,
    model: 'gemini-3-flash-latest',
    systemMessage: 'You are Data.',
  });

  const { text } = await chat.chat({
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'how are you?' },
    ],
  });

  assert.strictEqual(text, 'hi back');
  const req = client.calls[0];
  assert.strictEqual(req.model, 'gemini-3-flash-latest');
  assert.deepStrictEqual(req.contents, [
    { role: 'user', parts: [{ text: 'hello' }] },
    { role: 'model', parts: [{ text: 'hi' }] },
    { role: 'user', parts: [{ text: 'how are you?' }] },
  ]);
  assert.deepStrictEqual(req.config, { systemInstruction: 'You are Data.' });
});

test('Gemini adapter omits config when no system message is configured', async () => {
  const client = makeFakeGeminiClient({ text: 'ok' });
  const chat = makeGeminiChat({ client, model: 'gemini-3-flash-latest' });
  await chat.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(client.calls[0].config, undefined);
});

test('Gemini adapter throws if constructed without a client', () => {
  assert.throws(
    () => makeGeminiChat({ client: null, model: 'gemini-3-flash-latest' }),
    /GEMINI_API_KEY/
  );
});

test('Gemini adapter translates images on the user turn to inlineData parts', async () => {
  const client = makeFakeGeminiClient({ text: 'I see a cat.' });
  const chat = makeGeminiChat({ client, model: 'gemini-3-flash-latest' });
  await chat.chat({
    messages: [
      {
        role: 'user',
        content: 'what is this?',
        images: [
          { mimeType: 'image/png', data: 'YWJj' },
          { mimeType: 'image/jpeg', data: 'eHl6' },
        ],
      },
    ],
  });
  assert.deepStrictEqual(client.calls[0].contents[0], {
    role: 'user',
    parts: [
      { text: 'what is this?' },
      { inlineData: { mimeType: 'image/png', data: 'YWJj' } },
      { inlineData: { mimeType: 'image/jpeg', data: 'eHl6' } },
    ],
  });
});

test('Gemini adapter accepts an image-only user turn (no text part)', async () => {
  const client = makeFakeGeminiClient({ text: 'A cat.' });
  const chat = makeGeminiChat({ client, model: 'gemini-3-flash-latest' });
  await chat.chat({
    messages: [{ role: 'user', content: '', images: [{ mimeType: 'image/png', data: 'YWJj' }] }],
  });
  assert.deepStrictEqual(client.calls[0].contents[0].parts, [
    { inlineData: { mimeType: 'image/png', data: 'YWJj' } },
  ]);
});
