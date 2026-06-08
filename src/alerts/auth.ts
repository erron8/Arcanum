/** Parse a comma/space-separated list of chat IDs into a numeric array. */
export function parseChatIds(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && Number.isInteger(n));
}

/**
 * Authorization check for a chat.
 *  - If `allowed` is empty, the bot is open (caller is expected to warn loudly).
 *  - Otherwise only chats in the allowlist are authorized.
 */
export function isChatAuthorized(allowed: number[], chatId: number | undefined): boolean {
  if (allowed.length === 0) return true;
  if (chatId === undefined) return false;
  return allowed.includes(chatId);
}
