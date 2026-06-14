// Chat backend adapters. Each factory returns an object with a uniform
// `chat({ messages })` method that takes our canonical message shape
// (`[{ role: 'system' | 'user' | 'assistant', content }]`) and returns
// `{ text }`. The handleMessage code in lib/chat.js never has to know
// which backend it is talking to.
//
// Backends bind model + system message at construction time so handleMessage
// stays thin and the adapter owns all wire-format translation.

import { Ollama } from 'ollama';

// Llama-family tokenizers sometimes leak special tokens into the response
// text. Strip them at the adapter boundary so the rest of the app never sees
// them — including the message we write back into conversation history.
const LLAMA_TOKEN_REGEX =
  /<\|(?:eot_id|end_of_text|begin_of_text|start_header_id|end_header_id|eos|bos|pad)\|>/g;

function stripLlamaTokens(text) {
  if (!text) return text;
  return text.replace(LLAMA_TOKEN_REGEX, '').trim();
}

// --- Ollama (default) -----------------------------------------------------
// Native Ollama SDK. Supports `think`, native tool calling, vision via
// `images`, structured output via `format`, and free telemetry. We only use
// the basic chat path for now; the adapter shape leaves room to surface the
// rest.
export function makeOllamaChat({ host, model, systemMessage, client }) {
  const ollama = client || new Ollama({ host });
  return {
    backend: 'ollama',
    model,
    async chat({ messages }) {
      const wire = systemMessage
        ? [{ role: 'system', content: systemMessage }, ...messages]
        : messages;
      const response = await ollama.chat({ model, messages: wire, stream: false });
      return { text: stripLlamaTokens(response?.message?.content || '') };
    },
  };
}

// --- Gemini ---------------------------------------------------------------
// Uses the @google/genai client already constructed for image generation.
// Gemini's wire shape is different: the role is 'model' (not 'assistant'),
// messages are `{ role, parts: [{ text }] }`, and the system message lives in
// `config.systemInstruction` rather than the contents array.
export function makeGeminiChat({ client, model, systemMessage }) {
  if (!client) {
    throw new Error('Gemini chat backend requires GEMINI_API_KEY to be configured');
  }
  return {
    backend: 'gemini',
    model,
    async chat({ messages }) {
      const contents = messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
      const response = await client.models.generateContent({
        model,
        contents,
        ...(systemMessage ? { config: { systemInstruction: systemMessage } } : {}),
      });
      return { text: response?.text || '' };
    },
  };
}
