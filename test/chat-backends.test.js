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

function ollamaReply(content, toolCalls = null) {
  const message = { role: 'assistant', content };
  if (toolCalls) message.tool_calls = toolCalls;
  return { message };
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

test('Ollama adapter translates tools to native shape and surfaces tool_calls', async () => {
  const ollama = makeFakeOllama(
    ollamaReply('', [{ function: { name: 'do_thing', arguments: { x: 1 } } }])
  );
  const chat = makeOllamaChat({ model: 'llama3.1', client: ollama });

  const tools = [
    {
      name: 'do_thing',
      description: 'does the thing',
      parameters: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
    },
  ];

  const { text, toolCalls } = await chat.chat({
    messages: [{ role: 'user', content: 'go' }],
    tools,
  });

  assert.strictEqual(text, '');
  assert.deepStrictEqual(toolCalls, [{ name: 'do_thing', args: { x: 1 } }]);

  // Wire format: tools wrapped in {type:'function', function:{...}}.
  assert.deepStrictEqual(ollama.calls[0].tools, [
    {
      type: 'function',
      function: {
        name: 'do_thing',
        description: 'does the thing',
        parameters: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
      },
    },
  ]);
});

test('Ollama adapter translates assistant turns with tool_calls + tool-role results', async () => {
  const ollama = makeFakeOllama(ollamaReply('done'));
  const chat = makeOllamaChat({ model: 'llama3.1', client: ollama });
  await chat.chat({
    messages: [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ name: 'do_thing', args: { x: 1 } }],
      },
      { role: 'tool', toolName: 'do_thing', content: 'result-1' },
    ],
  });
  const wire = ollama.calls[0].messages;
  assert.deepStrictEqual(wire[1], {
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name: 'do_thing', arguments: { x: 1 } } }],
  });
  assert.deepStrictEqual(wire[2], { role: 'tool', content: 'result-1', tool_name: 'do_thing' });
});

test('Ollama adapter omits tools when none provided', async () => {
  const ollama = makeFakeOllama(ollamaReply('ok'));
  const chat = makeOllamaChat({ model: 'llama3.1', client: ollama });
  await chat.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(ollama.calls[0].tools, undefined);
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

test('Gemini adapter omits config when no system message and no tools', async () => {
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

test('Gemini adapter translates tools to functionDeclarations and surfaces functionCall', async () => {
  const client = makeFakeGeminiClient({
    candidates: [
      {
        content: {
          parts: [{ functionCall: { name: 'do_thing', args: { x: 1 } } }],
        },
      },
    ],
    text: '',
  });
  const chat = makeGeminiChat({ client, model: 'gemini-3-flash-latest' });

  const tools = [
    {
      name: 'do_thing',
      description: 'does the thing',
      parameters: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
    },
  ];

  const { toolCalls } = await chat.chat({
    messages: [{ role: 'user', content: 'go' }],
    tools,
  });

  assert.deepStrictEqual(toolCalls, [{ name: 'do_thing', args: { x: 1 } }]);
  assert.deepStrictEqual(client.calls[0].config.tools, [
    {
      functionDeclarations: [
        {
          name: 'do_thing',
          description: 'does the thing',
          parameters: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
        },
      ],
    },
  ]);
});

test('Gemini adapter translates assistant tool calls and tool-role results to parts', async () => {
  const client = makeFakeGeminiClient({ text: 'done' });
  const chat = makeGeminiChat({ client, model: 'gemini-3-flash-latest' });
  await chat.chat({
    messages: [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ name: 'do_thing', args: { x: 1 } }],
      },
      { role: 'tool', toolName: 'do_thing', content: 'result-1' },
    ],
  });
  const contents = client.calls[0].contents;
  assert.deepStrictEqual(contents[1], {
    role: 'model',
    parts: [{ functionCall: { name: 'do_thing', args: { x: 1 } } }],
  });
  assert.deepStrictEqual(contents[2], {
    role: 'user',
    parts: [{ functionResponse: { name: 'do_thing', response: { result: 'result-1' } } }],
  });
});
