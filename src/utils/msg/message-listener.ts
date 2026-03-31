import { Context, Session } from 'koishi';

export async function listenForUserMessage(
    ctx: Context,
    session: Session,
    prompt: string,
    timeout: number,
    onMessage: (message: string) => Promise<boolean>,
    onTimeout?: () => Promise<void>
): Promise<void> {
    const { userId, channelId, guildId, platform } = session;

    // Send prompt message
    await session.send(prompt);

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
}
