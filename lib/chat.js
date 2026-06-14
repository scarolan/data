// Backend-agnostic chat orchestration. `chat` is one of the adapters from
// lib/chat-backends.js; conversation history lives in `convoStore` (Keyv in
// prod, in-memory shim in tests) keyed by Slack user id.
//
// When `tools` is provided, handleMessage runs a small dispatch loop: send
// user turn → if the model returns tool calls, execute them and feed the
// results back as tool-role messages → repeat until the model returns plain
// text. Capped at MAX_TOOL_ITERATIONS to prevent runaways.
//
// Return shape: { text, thinking? }. The caller decides how to render the
// thinking trace (Slack context block, thread reply, dropped on the floor).

const GENERIC_ERROR_TEXT =
  'I apologize, but I am currently experiencing technical difficulties. My neural pathways appear to be experiencing a temporary malfunction. Please try again later.';

const DEFAULT_HISTORY_LIMIT = 20;
const MAX_TOOL_ITERATIONS = 5;

function convoKey(userId) {
  return `convo:${userId}`;
}

function looksLikeContentError(error) {
  if (!error) return false;
  const msg = (error.message || '').toLowerCase();
  return (
    msg.includes('content') ||
    msg.includes('policy') ||
    msg.includes('moderation') ||
    msg.includes('safety')
  );
}

async function dispatchToolCalls(toolCalls, tools) {
  const byName = new Map((tools || []).map((t) => [t.name, t]));
  const results = [];
  for (const call of toolCalls) {
    const tool = byName.get(call.name);
    if (!tool) {
      results.push({
        role: 'tool',
        toolName: call.name,
        content: `Error: unknown tool "${call.name}".`,
      });
      continue;
    }
    try {
      const out = await tool.execute(call.args || {});
      results.push({
        role: 'tool',
        toolName: call.name,
        content: typeof out === 'string' ? out : JSON.stringify(out),
      });
    } catch (err) {
      console.error(`Tool "${call.name}" threw:`, err);
      results.push({
        role: 'tool',
        toolName: call.name,
        content: `Error executing ${call.name}: ${err.message || 'unknown error'}`,
      });
    }
  }
  return results;
}

export async function handleMessage(
  message,
  { chat, convoStore, tools, historyLimit = DEFAULT_HISTORY_LIMIT }
) {
  const text = message.text || '';
  const images = message.images || [];
  if (!text && !images.length) {
    return { text: 'I apologize, but I cannot process an empty message. How may I assist you?' };
  }

  const key = convoKey(message.user);
  const history = (await convoStore.get(key)) || [];
  const userTurn = { role: 'user', content: text };
  if (images.length) userTurn.images = images;

  // Working set includes the persisted history plus this turn's ephemeral
  // tool dispatch traffic. Only the final assistant text is folded back into
  // the persisted history at the end.
  const working = [...history, userTurn];

  try {
    let finalText = '';
    let finalThinking = '';
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      const result = await chat.chat({ messages: working, tools });
      const { text: turnText, toolCalls, thinking } = result;

      if (!toolCalls?.length) {
        finalText = turnText || '';
        finalThinking = thinking || '';
        break;
      }

      working.push({ role: 'assistant', content: turnText || '', toolCalls });
      const toolResults = await dispatchToolCalls(toolCalls, tools);
      working.push(...toolResults);

      if (iter === MAX_TOOL_ITERATIONS - 1) {
        // Force one final non-tool response so the user sees something.
        const wrap = await chat.chat({ messages: working });
        finalText = wrap.text || '';
        finalThinking = wrap.thinking || '';
      }
    }

    // Persist the text portion of the user turn — image bytes are big and the
    // Slack file URLs they originated from will eventually expire, so we don't
    // try to keep them. Thinking traces are likewise ephemeral.
    const persistedUserTurn = { role: 'user', content: text };
    const nextHistory = [
      ...history,
      persistedUserTurn,
      { role: 'assistant', content: finalText },
    ].slice(-historyLimit);
    await convoStore.set(key, nextHistory);

    const out = { text: finalText };
    if (finalThinking) out.thinking = finalThinking;
    return out;
  } catch (error) {
    console.error('Error in handleMessage:', error);
    if (looksLikeContentError(error)) {
      return {
        text: 'I apologize, but I encountered an issue processing your message. Could you please rephrase your request?',
      };
    }
    return { text: GENERIC_ERROR_TEXT };
  }
}
