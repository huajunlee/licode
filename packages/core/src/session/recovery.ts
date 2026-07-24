import type { ConversationManager } from "../conversation/manager.js";
import type { SessionManager } from "./manager.js";

export async function recoverLatestSession(
  manager: SessionManager
): Promise<ConversationManager | null> {
  const [latest] = await manager.list();
  if (!latest) return null;
  return manager.load(latest.id);
}
