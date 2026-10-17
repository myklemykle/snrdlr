// What was typed in a chat's message box and not yet sent, kept on this device per chat, so that
// leaving the chat and coming back finds it still there. Gone once sent, or when the chat is left.

const key = (chatId: string) => `snrdlr.draft.${chatId}`

export function loadDraft(chatId: string): string {
  try {
    return localStorage.getItem(key(chatId)) ?? ''
  } catch {
    return ''
  }
}

export function saveDraft(chatId: string, text: string): void {
  try {
    if (text) localStorage.setItem(key(chatId), text)
    else localStorage.removeItem(key(chatId))
  } catch {
    // Then it is kept only while the chat stays open.
  }
}
