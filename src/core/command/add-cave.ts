import { checkUsersInGroup, getUserName } from '../../adapters/onebot/user';
import { Config } from '../../config/config';
import { parseUserIds } from '../../utils/msg/element-helper';
import { listenForUserMessage } from '../../utils/msg/message-listener';
import { reconstructForwardMsg } from '../parser/forward-parser';
import { processMessageContent } from '../parser/msg-parser';
import { CQCode } from '@pynickle/koishi-plugin-adapter-onebot';
import { Context, Session } from 'koishi';

export async function addCave(ctx: Context, session: Session, cfg: Config, userIds?: string[]) {
    if (!session.guildId) {
        return session.text('echo-cave.general.privateChatReminder');
    }

    if (!session.quote) {
        return session.text('.noMsgQuoted');
    }

    const { userId, channelId, quote } = session;
    const messageId = quote.id;

    // Parse userIds to handle @mentions
    let parsedUserIds: string[] = [];
    if (userIds && userIds.length > 0) {
        const result = parseUserIds(userIds);
        if (result.error === 'invalid_all_mention') {
            return session.text('echo-cave.user.invalidAllMention');
        }
        parsedUserIds = result.parsedUserIds;

        if (parsedUserIds.length > 0) {
            // Check if all users belong to the group if userIds are provided
            const isAllUsersInGroup = await checkUsersInGroup(ctx, session, parsedUserIds);
            if (!isAllUsersInGroup) {
                return session.text('echo-cave.user.userNotInGroup');
            }
        }
    }

    // Initialize variables to store selected user IDs and names
    let selectedUsersWithNames: Array<{ userId: string; nickname: string }> = [];

    let content: string | CQCode[];
    let type: 'forward' | 'msg';
    let forwardUsers: { userId: string; nickname: string }[] = [];

    if (quote.elements[0].type === 'forward') {
        type = 'forward';

        const message = await reconstructForwardMsg(
            ctx,
            session,
            await session.onebot.getForwardMsg(messageId),
            cfg
        );

        content = JSON.stringify(message);

        // Extract unique users from forward message
        const userMap = new Map<string, string>();
        for (const node of message) {
            if (node.type === 'node' && node.data) {
                const userId = String(node.data.user_id);
                const nickname = node.data.nickname;
                if (userId && nickname && !userMap.has(userId)) {
                    userMap.set(userId, nickname);
                }
            }
        }

        forwardUsers = Array.from(userMap.entries()).map(([userId, nickname]) => ({
            userId,
            nickname,
        }));
    } else {
        type = 'msg';

        const message = (await session.onebot.getMsg(messageId)).message;

        let msgJson: CQCode[];

        if (typeof message === 'string') {
            msgJson = CQCode.parse(message);
        } else {
            const firstMsgType = message[0].type;
            if (
                firstMsgType === 'video' ||
                firstMsgType === 'file' ||
                firstMsgType === 'record' ||
                message.some((m) => m.type === 'reply')
            ) {
                type = 'forward';
            }
            msgJson = message;
        }

        content = JSON.stringify(await processMessageContent(ctx, msgJson, cfg));
    }

    // If it's a forward message with users and user selection is enabled, ask the user to select related users
    if (
        type === 'forward' &&
        forwardUsers.length > 0 &&
        parsedUserIds.length === 0 &&
        cfg.enableForwardUserSelection
    ) {
        // Create a promise to handle the user selection
        const userSelectionPromise = new Promise<Array<{ userId: string; nickname: string }>>(
            (resolve) => {
                // Generate the prompt message
                let prompt = session.text('.selectRelatedUsers');
                forwardUsers.forEach((user, index) => {
                    prompt += `\n${index + 1}: ${user.nickname}`;
                });
                prompt += `\n${session.text('.selectInstruction')}`;

                // Start listening for user message
                listenForUserMessage(
                    ctx,
                    session,
                    prompt,
                    cfg.forwardSelectTimeout * 1000, // Convert seconds to milliseconds
                    async (message) => {
                        const trimmedMessage = message.trim();
                        let selectedUsers: Array<{ userId: string; nickname: string }> = [];

                        if (trimmedMessage.toLowerCase() === 'all') {
                            // Select all users
                            selectedUsers = [...forwardUsers];
                        } else if (trimmedMessage.toLowerCase() === 'skip') {
                            // Skip selection, return empty array
                            selectedUsers = [];
                        } else {
                            // Parse the selected indices
                            const indices = trimmedMessage
                                .split(/\s+/)
                                .map((index) => parseInt(index.trim()) - 1);
                            const validIndices = indices.filter(
                                (index) => index >= 0 && index < forwardUsers.length
                            );

                            if (validIndices.length > 0) {
                                selectedUsers = validIndices.map((index) => forwardUsers[index]);
                            } else {
                                // Invalid input, ask again
                                await session.send(session.text('.invalidSelection'));
                                return true; // Continue listening
                            }
                        }

                        resolve(selectedUsers);
                        return false; // Stop listening
                    },
                    async () => {
                        resolve([]);
                    }
                );
            }
        );

        // Wait for user selection or timeout
        selectedUsersWithNames = await userSelectionPromise;
    }

    // Extract final user IDs for database
    const finalParsedUserIds = selectedUsersWithNames.map((user) => user.userId);

    // Format related users for response
    const originName = await getUserName(ctx, session, quote.user.id);
    const relatedUsersFormatted =
        selectedUsersWithNames.length !== 0
            ? selectedUsersWithNames.map((user) => user.nickname).join(', ')
            : originName;

    try {
        const result = await ctx.database.create('echo_cave_v2', {
            channelId,
            createTime: new Date(),
            userId,
            originUserId: quote.user.id,
            type,
            content,
            relatedUsers: finalParsedUserIds,
        });

        return session.text('.msgSaved', { id: result.id, relatedUsers: relatedUsersFormatted });
    } catch (error) {
        return session.text('.msgFailedToSave');
    }
}
