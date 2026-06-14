// Chat helpers: clean LLM responses and route messages through ChatGPTAPI.
// Dependencies are passed in so tests can substitute fakes.

const LOCAL_LLM_TOKENS =
  /<\|(?:eot_id|end_of_text|begin_of_text|start_header_id|end_header_id|eos|bos|pad)\|>/g;

export function cleanLocalLlmResponse(text, isLocalLlm = false) {
  if (!isLocalLlm || !text) return text;
  return text.replace(LOCAL_LLM_TOKENS, '').trim();
}

const GENERIC_ERROR_TEXT =
  'I apologize, but I am currently experiencing technical difficulties. My neural pathways appear to be experiencing a temporary malfunction. Please try again later.';

// Route a Slack message through the ChatGPT client, threading per-user
// conversation context via `parentIds`. Errors are caught and surfaced as
// in-character apology strings so callers can `say()` them verbatim.
export async function handleMessage(message, { chat, parentIds, isLocalLlm = false }) {
  if (!message.text) {
    return 'I apologize, but I cannot process an empty message. How may I assist you?';
  }

  const userId = message.user;

  try {
    let response;
    if (parentIds.has(userId)) {
      response = await chat.sendMessage(message.text, { parentMessageId: parentIds.get(userId) });
    } else {
      response = await chat.sendMessage(message.text);
    }
    parentIds.set(userId, response.id);
    return cleanLocalLlmResponse(response.text, isLocalLlm);
  } catch (error) {
    console.error('Error in handleMessage:', error);
    if (error.statusCode === 400 && error.message && error.message.includes('content')) {
      return 'I apologize, but I encountered an issue processing your message. Could you please rephrase your request?';
    }
    return GENERIC_ERROR_TEXT;
  }
}
