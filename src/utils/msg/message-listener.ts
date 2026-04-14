import { Context, Session } from 'koishi';

export function normalizeMessageIds(result: unknown): string[] {
  if (typeof result === 'string') {
    return [result];
  }

  if (Array.isArray(result)) {
    return result.filter((item): item is string => typeof item === 'string');
  }

  return [];
}

export async function silentlyDeleteMessages(session: Session, messageIds?: string[]) {
  if (!messageIds || messageIds.length === 0) {
    return;
  }

  for (const messageId of messageIds) {
    try {
      await session.bot.deleteMessage(session.channelId, messageId);
    } catch {}
  }
}

export function scheduleSilentDelete(
  ctx: Context,
  session: Session,
  delay: number,
  messageIds?: string[]
) {
  if (!messageIds || messageIds.length === 0) {
    return;
  }

  ctx.setTimeout(async () => {
    await silentlyDeleteMessages(session, messageIds);
  }, delay);
}

export async function listenForUserMessage(
  ctx: Context,
  session: Session,
  prompt: string,
  timeout: number,
  onMessage: (message: string) => Promise<boolean>,
  onTimeout?: () => Promise<void>
): Promise<string[]> {
  const { userId, channelId, guildId, platform } = session;

  // Send prompt message
  const promptMessageIds = normalizeMessageIds(await session.send(prompt));

  // Create message listener
  const listener = async (msgSession: Session) => {
    // Check if it's the same user sending message in the same channel
    if (
      msgSession.userId === userId &&
      msgSession.channelId === channelId &&
      msgSession.guildId === guildId &&
      msgSession.platform === platform
    ) {
      // Process user message
      const shouldContinue = await onMessage(msgSession.content);

      if (!shouldContinue) {
        // Remove listener
        cancelListener();

        cancelTimeout();
      }
    }
  };

  // Add message listener
  const cancelListener = ctx.on('message', listener);

  // Set timeout timer
  const cancelTimeout = ctx.setTimeout(async () => {
    // Remove listener
    cancelListener();

    // Call timeout callback
    if (onTimeout) {
      await onTimeout();
    }
  }, timeout);

  return promptMessageIds;
}
