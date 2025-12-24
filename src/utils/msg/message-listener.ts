import { Context, Session } from 'koishi';

export interface MessageListenerOptions {
    ctx: Context;
    session: Session;
    prompt: string;
    timeout: number;
    onTimeout?: () => Promise<void>;
    onMessage: (message: string) => Promise<boolean>;
}

export async function listenForUserMessage(options: MessageListenerOptions): Promise<void> {
    const { ctx, session, prompt, timeout, onTimeout, onMessage } = options;
    const userId = session.userId;
    const channelId = session.channelId;

    // Send prompt message
    const promptMessage = await session.send(prompt);
    let promptMessageId: string = '';

    // Try to get messageId using type assertion to simplify type handling
    try {
        const msgObj = promptMessage as any;
        if (msgObj && typeof msgObj === 'object' && msgObj.messageId) {
            promptMessageId = String(msgObj.messageId);
        }
    } catch (error) {
        // Ignore type conversion errors
    }

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
                if (promptMessageId) {
                    try {
                        await session.onebot.deleteMsg(promptMessageId);
                    } catch (error) {
                        // Ignore recall failure
                    }
                }
            }
        }
    };

    // Add message listener
    ctx.on('message', listener);

    // Set timeout timer
    timeoutId = setTimeout(async () => {
        // Remove listener
        ctx.off('message', listener);

        // Call timeout callback
        if (onTimeout) {
            await onTimeout();
        }

        // Try to recall prompt message
        if (promptMessageId) {
            try {
                await session.onebot.deleteMsg(promptMessageId);
            } catch (error) {
                // Ignore recall failure
            }
        }
    }, timeout);
}
