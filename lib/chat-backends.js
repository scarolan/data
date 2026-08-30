// Chat backend adapters. Each factory returns an object with a uniform
// `chat({ messages }) → { text }` method plus a streaming variant
// `chatStream({ messages, onDelta }) → { text }` that awaits `onDelta(delta)`
// for each text chunk as the model produces it and resolves with the full
// reply. Awaiting onDelta means a slow consumer (e.g. Slack appendStream)
// naturally backpressures the provider stream.
//
// Canonical message shape: { role: 'system'|'user'|'assistant', content, images? }
// where images is an optional `[{ mimeType, data: base64 }]` for vision turns.
//
// Adapters translate to/from each provider's native wire format internally so
// handleMessage stays backend-agnostic.

import { Ollama } from 'ollama';

// Llama-family tokenizers sometimes leak special tokens into the response.
// Strip them at the adapter boundary so they never reach history or Slack.
const LLAMA_TOKEN_REGEX =
  /<\|(?:eot_id|end_of_text|begin_of_text|start_header_id|end_header_id|eos|bos|pad)\|>/g;

function stripLlamaTokens(text) {
  if (!text) return text;
  return text.replace(LLAMA_TOKEN_REGEX, '').trim();
}

// --- Ollama (default) -----------------------------------------------------

function toOllamaMessage(m) {
  const out = { role: m.role, content: m.content };
  if (m.images?.length) {
    // Ollama takes base64 strings (or Uint8Arrays) and ignores mimeType.
    out.images = m.images.map((img) => img.data);
  }
  return out;
}

export function makeOllamaChat({ host, model, systemMessage, client }) {
  const ollama = client || new Ollama({ host });

  function toWire(messages) {
    const wire = systemMessage
      ? [{ role: 'system', content: systemMessage }, ...messages.map(toOllamaMessage)]
      : messages.map(toOllamaMessage);
    const imageCount = wire.reduce((n, m) => n + (m.images?.length || 0), 0);
    if (imageCount) {
      console.log(`Ollama chat -> ${model} with ${imageCount} image(s) attached`);
    }
    return wire;
  }

  return {
    backend: 'ollama',
    model,
    async chat({ messages }) {
      const response = await ollama.chat({
        model,
        messages: toWire(messages),
        stream: false,
        // gemma4 defaults thinking ON and emits a (discarded) reasoning trace,
        // adding latency + tokens for no benefit since we only render content.
        // Explicitly disable it. See CLAUDE.md model-selection notes.
        think: false,
      });
      const text = stripLlamaTokens(response?.message?.content || '');
      return { text };
    },
    async chatStream({ messages, onDelta }) {
      const stream = await ollama.chat({
        model,
        messages: toWire(messages),
        stream: true,
        think: false, // see chat() above
      });
      let full = '';
      for await (const part of stream) {
        const raw = part?.message?.content || '';
        if (!raw) continue;
        full += raw;
        // Strip leaked special tokens per-delta without trimming, so legitimate
        // whitespace between chunks survives. A token split across two chunks
        // would slip through, but that has never been observed in practice; the
        // returned full text gets the strict strip either way.
        const delta = raw.replace(LLAMA_TOKEN_REGEX, '');
        if (delta) await onDelta(delta);
      }
      return { text: stripLlamaTokens(full) };
    },
  };
}

// --- Gemini ---------------------------------------------------------------

function toGeminiContent(m) {
  const parts = [];
  if (m.content) parts.push({ text: m.content });
  if (m.images?.length) {
    for (const img of m.images) {
      parts.push({ inlineData: { mimeType: img.mimeType || 'image/png', data: img.data } });
    }
  }
  if (!parts.length) parts.push({ text: '' });
  return {
    role: m.role === 'assistant' ? 'model' : 'user',
    parts,
  };
}

export function makeGeminiChat({ client, model, systemMessage }) {
  if (!client) {
    throw new Error('Gemini chat backend requires GEMINI_API_KEY to be configured');
  }
  function buildRequest(messages) {
    const contents = messages.map(toGeminiContent);
    const config = {};
    if (systemMessage) config.systemInstruction = systemMessage;
    return { model, contents, ...(Object.keys(config).length ? { config } : {}) };
  }

  return {
    backend: 'gemini',
    model,
    async chat({ messages }) {
      const response = await client.models.generateContent(buildRequest(messages));
      const text = response?.text || '';
      return { text };
    },
    async chatStream({ messages, onDelta }) {
      const stream = await client.models.generateContentStream(buildRequest(messages));
      let full = '';
      for await (const chunk of stream) {
        const delta = chunk?.text || '';
        if (!delta) continue;
        full += delta;
        await onDelta(delta);
      }
      return { text: full };
    },
  };
}
