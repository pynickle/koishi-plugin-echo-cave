import { Context, Session } from 'koishi';

export async function listenForUserMessage(
    ctx: Context,
    session: Session,
    prompt: string,
    timeout: number,
    onMessage: (message: string) => Promise<boolean>,
    onTimeout?: () => Promise<void>
): Promise<void> {
    const { userId, channelId } = session;

    // Send prompt message
    const promptMessageId = await session.onebot.sendGroupMsg(channelId, prompt);

    // Create message listener
    const listener = async (msgSession: Session) => {
        // Check if it's the same user sending message in the same channel
        if (msgSession.userId === userId && msgSession.channelId === channelId) {
            // Process user message
            const shouldContinue = await onMessage(msgSession.content);

            if (!shouldContinue) {
                // Remove listener
                cancelListener();

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
    const cancelListener = ctx.on('message', listener);

    // Set timeout timer
    const cancelTimeout = ctx.setTimeout(async () => {
        // Remove listener
        cancelListener();

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
