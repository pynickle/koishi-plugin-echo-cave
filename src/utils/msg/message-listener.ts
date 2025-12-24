import { Context, Session } from 'koishi';

export async function listenForUserMessage(
    ctx: Context,
    session: Session,
    prompt: string,
    timeout: number,
    onMessage: (message: string) => Promise<boolean>,
    onTimeout?: () => Promise<void>
): Promise<void> {
    const userId = session.userId;
    const channelId = session.channelId;

    // Send prompt message
    const promptMessageId = await session.onebot.sendGroupMsg(channelId, prompt);

    let timeoutId: NodeJS.Timeout;

    // Create message listener
    const listener = async (msgSession: Session) => {
        // Check if it's the same user sending message in the same channel
        if (msgSession.userId === userId && msgSession.channelId === channelId) {
            // Clear timeout timer
            clearTimeout(timeoutId);

            // Process user message
            const shouldContinue = await onMessage(msgSession.content);

            if (!shouldContinue) {
                // Remove listener
                ctx.off('message', listener);

                // Try to recall prompt message
                try {
                    await session.onebot.deleteMsg(promptMessageId);
                } catch (error) {
                    // Ignore recall failure
                }

                cancelTimeout();
            }
        }
    };

    // Add message listener
    ctx.on('message', listener);

    // Set timeout timer
    const cancelTimeout = ctx.setTimeout(async () => {
        // Remove listener
        ctx.off('message', listener);

        // Call timeout callback
        if (onTimeout) {
            await onTimeout();
        }

        // Try to recall prompt message
        try {
            await session.onebot.deleteMsg(promptMessageId);
        } catch (error) {
            // Ignore recall failure
        }
    }, timeout);
}
