// Backend-agnostic chat orchestration. `chat` is one of the adapters from
// lib/chat-backends.js; conversation history lives in `convoStore` (Keyv in
// prod, in-memory shim in tests) keyed by Slack user id.
//
// Return shape: { text, thinking? }. The caller decides how to render the
// thinking trace (Slack context block, thread reply, dropped on the floor).

const GENERIC_ERROR_TEXT =
  'I apologize, but I am currently experiencing technical difficulties. My neural pathways appear to be experiencing a temporary malfunction. Please try again later.';

const DEFAULT_HISTORY_LIMIT = 20;

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

export async function handleMessage(
  message,
  { chat, convoStore, historyLimit = DEFAULT_HISTORY_LIMIT }
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

  try {
    const result = await chat.chat({ messages: [...history, userTurn] });
    const reply = result.text || '';

    // Persist the text portion of the user turn — image bytes are big and the
    // Slack file URLs they originated from will eventually expire, so we don't
    // try to keep them. Thinking traces are likewise ephemeral.
    const persistedUserTurn = { role: 'user', content: text };
    const nextHistory = [
      ...history,
      persistedUserTurn,
      { role: 'assistant', content: reply },
    ].slice(-historyLimit);
    await convoStore.set(key, nextHistory);

    const out = { text: reply };
    if (result.thinking) out.thinking = result.thinking;
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
