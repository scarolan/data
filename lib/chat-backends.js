// Chat backend adapters. Each factory returns an object with a uniform
// `chat({ messages, tools }) → { text, toolCalls? }` method.
//
// Canonical shapes:
//   message:    { role: 'system'|'user'|'assistant'|'tool', content, toolCalls?, toolName? }
//   tool def:   { name, description, parameters }
//   toolCall:   { name, args }
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
  if (m.role === 'tool') {
    return { role: 'tool', content: m.content, tool_name: m.toolName };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || '',
      tool_calls: m.toolCalls.map((tc) => ({
        function: { name: tc.name, arguments: tc.args },
      })),
    };
  }
  const out = { role: m.role, content: m.content };
  if (m.images?.length) {
    // Ollama takes base64 strings (or Uint8Arrays) and ignores mimeType.
    out.images = m.images.map((img) => img.data);
  }
  return out;
}

function toOllamaTools(tools) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function makeOllamaChat({ host, model, systemMessage, think, client }) {
  const ollama = client || new Ollama({ host });
  return {
    backend: 'ollama',
    model,
    async chat({ messages, tools }) {
      const wire = systemMessage
        ? [{ role: 'system', content: systemMessage }, ...messages.map(toOllamaMessage)]
        : messages.map(toOllamaMessage);
      const response = await ollama.chat({
        model,
        messages: wire,
        tools: toOllamaTools(tools),
        ...(think ? { think } : {}),
        stream: false,
      });
      const text = stripLlamaTokens(response?.message?.content || '');
      const thinking = response?.message?.thinking || '';
      const raw = response?.message?.tool_calls || [];
      const toolCalls = raw.map((tc) => ({
        name: tc.function?.name,
        args: tc.function?.arguments || {},
      }));
      const result = { text };
      if (thinking) result.thinking = thinking;
      if (toolCalls.length) result.toolCalls = toolCalls;
      return result;
    },
  };
}

// --- Gemini ---------------------------------------------------------------

function toGeminiContent(m) {
  if (m.role === 'tool') {
    return {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: m.toolName,
            response: { result: m.content },
          },
        },
      ],
    };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    const parts = [];
    if (m.content) parts.push({ text: m.content });
    for (const tc of m.toolCalls) {
      parts.push({ functionCall: { name: tc.name, args: tc.args } });
    }
    return { role: 'model', parts };
  }
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

function toGeminiTools(tools) {
  if (!tools?.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  ];
}

function extractGeminiToolCalls(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  const calls = [];
  for (const p of parts) {
    if (p.functionCall) {
      calls.push({ name: p.functionCall.name, args: p.functionCall.args || {} });
    }
  }
  return calls;
}

export function makeGeminiChat({ client, model, systemMessage }) {
  if (!client) {
    throw new Error('Gemini chat backend requires GEMINI_API_KEY to be configured');
  }
  return {
    backend: 'gemini',
    model,
    async chat({ messages, tools }) {
      const contents = messages.map(toGeminiContent);
      const config = {};
      if (systemMessage) config.systemInstruction = systemMessage;
      const geminiTools = toGeminiTools(tools);
      if (geminiTools) config.tools = geminiTools;
      const response = await client.models.generateContent({
        model,
        contents,
        ...(Object.keys(config).length ? { config } : {}),
      });
      const text = response?.text || '';
      const toolCalls = extractGeminiToolCalls(response);
      return toolCalls.length ? { text, toolCalls } : { text };
    },
  };
}
