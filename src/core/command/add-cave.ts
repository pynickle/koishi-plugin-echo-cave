import { checkUsersInGroup, getUserName } from '../../adapters/onebot/user';
import { Config } from '../../config/config';
import { ACTIVE_CAVE_TABLE, getNextCavePublicId } from '../cave-store';
import { messageContainsMedia, processStoredMessageMedia } from '../../utils/media/media-helper';
import { parseUserIds } from '../../utils/msg/element-helper';
import {
    listenForUserMessage,
    normalizeMessageIds,
    scheduleSilentDelete,
    silentlyDeleteMessages,
} from '../../utils/msg/message-listener';
import { getCaveMaintenanceMessage } from './admin';
import { reconstructForwardMsg } from '../parser/forward-parser';
import { processMessageContent } from '../parser/msg-parser';
import { CQCode } from '@pynickle/koishi-plugin-adapter-onebot';
import { Message } from '@pynickle/koishi-plugin-adapter-onebot/lib/types';
import { Context, Session } from 'koishi';

const SPECIAL_FORWARD_USER_ID = 1094950020;
const SPECIAL_FORWARD_RECALL_DELAY = 60 * 1000;

interface ProgressState {
    progressMessageIds?: string[];
}

interface ForwardUserSelectionResult {
    selectedUsers: Array<{ userId: string; nickname: string }>;
    completed: boolean;
}

export async function addCave(ctx: Context, session: Session, cfg: Config, userIds?: string[]) {
    if (!session.guildId) {
        return session.text('echo-cave.general.privateChatReminder');
    }

    const maintenanceMessage = getCaveMaintenanceMessage(session);
    if (maintenanceMessage) {
        return maintenanceMessage;
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
    let hasMedia = false;
    let needsDeferredMediaProcessing = false;
    let rawForwardMessage: Message[] | null = null;

    if (quote.elements[0].type === 'forward') {
        type = 'forward';
        rawForwardMessage = await session.onebot.getForwardMsg(messageId);

        const message = await reconstructForwardMsg(
            ctx,
            session,
            rawForwardMessage,
            cfg,
            false
        );

        hasMedia = await messageContainsMedia(message);
        needsDeferredMediaProcessing = true;

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

        if (
            rawForwardMessage &&
            containsSpecialForwardUser(rawForwardMessage, SPECIAL_FORWARD_USER_ID)
        ) {
            const shouldContinue = await handleSpecialForwardUser(ctx, session, cfg, message);
            if (!shouldContinue) {
                return;
            }
        }
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

        hasMedia = await messageContainsMedia(msgJson);

        content = JSON.stringify(
            await processMediaWithOptionalProgress(session, cfg, hasMedia, async (progressOptions) =>
                await processMessageContent(ctx, msgJson, cfg, channelId, progressOptions)
            )
        );
    }

    // If it's a forward message with users and user selection is enabled, ask the user to select related users
    if (
        type === 'forward' &&
        forwardUsers.length > 0 &&
        parsedUserIds.length === 0 &&
        cfg.autoBindSingleForwardUser &&
        forwardUsers.length === 1
    ) {
        selectedUsersWithNames = [...forwardUsers];
    } else if (
        type === 'forward' &&
        forwardUsers.length > 0 &&
        parsedUserIds.length === 0 &&
        cfg.enableForwardUserSelection
    ) {
        const selectionResult = await selectRelatedUsers(ctx, session, cfg, forwardUsers);
        selectedUsersWithNames = selectionResult.selectedUsers;

        if (selectionResult.completed) {
            await markForwardSelectionGuideCompleted(ctx, session.userId);
        }
    }

    if (needsDeferredMediaProcessing) {
        content = await processMediaWithOptionalProgress(session, cfg, hasMedia, async (progressOptions) =>
            await processStoredMessageMedia(ctx, content as string, cfg, channelId, progressOptions)
        );
    }

    const finalParsedUserIds =
        selectedUsersWithNames.length !== 0
            ? selectedUsersWithNames.map((user) => user.userId)
            : parsedUserIds;

    const originName = await getUserName(ctx, session, quote.user.id);
    const relatedUsersFormatted = await formatRelatedUsers(
        ctx,
        session,
        selectedUsersWithNames,
        finalParsedUserIds,
        originName
    );

    try {
        const nextId = await getNextCavePublicId(ctx);
        const result = await ctx.database.create(ACTIVE_CAVE_TABLE, {
            id: nextId,
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

async function processMediaWithOptionalProgress<T>(
    session: Session,
    cfg: Config,
    hasMedia: boolean,
    action: (progressOptions?: { session: Session; state: ProgressState }) => Promise<T>
): Promise<T> {
    const shouldShowProgress = cfg.mediaStorage === 's3' && hasMedia;
    const state: ProgressState = {};

    try {
        return await action(shouldShowProgress ? { session, state } : undefined);
    } finally {
        await tryDeleteProgressMessages(session, state.progressMessageIds);
    }
}

async function tryDeleteProgressMessages(session: Session, messageIds?: string[]) {
    await silentlyDeleteMessages(session, messageIds);
}

async function formatRelatedUsers(
    ctx: Context,
    session: Session,
    selectedUsersWithNames: Array<{ userId: string; nickname: string }>,
    relatedUserIds: string[],
    originName: string
) {
    if (selectedUsersWithNames.length !== 0) {
        return selectedUsersWithNames.map((user) => user.nickname).join(', ');
    }

    if (relatedUserIds.length !== 0) {
        const relatedUserNames = await Promise.all(
            relatedUserIds.map(async (relatedUserId) => await getUserName(ctx, session, relatedUserId))
        );
        return relatedUserNames.join(', ');
    }

    return originName;
}

function containsSpecialForwardUser(messages: Message[], targetUserId: number): boolean {
    return messages.some((msg) => {
        if (msg.sender.user_id === targetUserId) {
            return true;
        }

        if (typeof msg.message === 'string') {
            return false;
        }

        return msg.message.some(
            (element) => element.type === 'forward' && containsSpecialForwardUser(element.data.content, targetUserId)
        );
    });
}

async function getForwardSelectionGuideCompleted(ctx: Context, userId: string) {
    const states = await ctx.database.get('echo_cave_user_state', { userId });
    return states[0]?.hasCompletedForwardSelection ?? false;
}

async function markForwardSelectionGuideCompleted(ctx: Context, userId: string) {
    const states = await ctx.database.get('echo_cave_user_state', { userId });
    if (states.length === 0) {
        await ctx.database.create('echo_cave_user_state', {
            userId,
            hasCompletedForwardSelection: true,
        });
        return;
    }

    await ctx.database.set('echo_cave_user_state', { userId }, { hasCompletedForwardSelection: true });
}

async function selectRelatedUsers(
    ctx: Context,
    session: Session,
    cfg: Config,
    forwardUsers: Array<{ userId: string; nickname: string }>
): Promise<ForwardUserSelectionResult> {
    const hasCompletedGuide = await getForwardSelectionGuideCompleted(ctx, session.userId);
    const sentMessageIds: string[] = [];

    const promptHeader = hasCompletedGuide
        ? session.text('.selectRelatedUsersSimple')
        : session.text('.selectRelatedUsersDetailed');
    const promptFooter = hasCompletedGuide
        ? session.text('.selectInstructionBrief')
        : session.text('.selectInstructionDetailed');

    let prompt = promptHeader;
    forwardUsers.forEach((user, index) => {
        prompt += `\n${index + 1}: ${user.nickname}`;
    });
    prompt += `\n${promptFooter}`;

    return await new Promise<ForwardUserSelectionResult>((resolve) => {
        listenForUserMessage(
            ctx,
            session,
            prompt,
            cfg.forwardSelectTimeout * 1000,
            async (message) => {
                const trimmedMessage = message.trim();
                let selectedUsers: Array<{ userId: string; nickname: string }> = [];

                if (trimmedMessage.toLowerCase() === 'all') {
                    selectedUsers = [...forwardUsers];
                } else if (trimmedMessage.toLowerCase() === 'skip') {
                    selectedUsers = [];
                } else {
                    const indices = trimmedMessage
                        .split(/\s+/)
                        .map((index) => parseInt(index.trim()) - 1);
                    const validIndices = indices.filter(
                        (index) => index >= 0 && index < forwardUsers.length
                    );

                    if (validIndices.length > 0) {
                        selectedUsers = validIndices.map((index) => forwardUsers[index]);
                    } else {
                        sentMessageIds.push(
                            ...normalizeMessageIds(await session.send(session.text('.invalidSelection')))
                        );
                        return true;
                    }
                }

                resolve({ selectedUsers, completed: true });
                return false;
            },
            async () => {
                resolve({ selectedUsers: [], completed: false });
            }
        ).then((promptMessageIds) => sentMessageIds.push(...promptMessageIds));
    }).finally(async () => {
        await silentlyDeleteMessages(session, sentMessageIds);
    });
}

async function handleSpecialForwardUser(
    ctx: Context,
    session: Session,
    cfg: Config,
    previewMessage: CQCode[]
) {
    const mode = cfg.forwardSpecialUserHandlingMode ?? 'ignore';
    if (mode === 'ignore') {
        return true;
    }

    if (mode === 'reject') {
        const warningIds = normalizeMessageIds(
            await session.send(session.text('.specialForwardUserBlocked'))
        );
        scheduleSilentDelete(ctx, session, SPECIAL_FORWARD_RECALL_DELAY, warningIds);
        return false;
    }

    return await confirmSpecialForwardStorage(ctx, session, previewMessage);
}

async function confirmSpecialForwardStorage(
    ctx: Context,
    session: Session,
    previewMessage: CQCode[]
) {
    const sentMessageIds: string[] = [];
    sentMessageIds.push(
        ...normalizeMessageIds(await session.send(session.text('.specialForwardUserConfirmNotice')))
    );
    sentMessageIds.push(...normalizeMessageIds(await session.send(previewMessage as never)));
    scheduleSilentDelete(ctx, session, SPECIAL_FORWARD_RECALL_DELAY, sentMessageIds);

    const shouldStore = await new Promise<boolean>((resolve) => {
        listenForUserMessage(
            ctx,
            session,
            session.text('.specialForwardUserConfirmPrompt'),
            SPECIAL_FORWARD_RECALL_DELAY,
            async (message) => {
                const normalized = message.trim().toLowerCase();

                if (normalized === '存储' || normalized === 'store') {
                    resolve(true);
                    return false;
                }

                if (normalized === '取消' || normalized === '不存' || normalized === 'cancel' || normalized === 'skip') {
                    resolve(false);
                    return false;
                }

                sentMessageIds.push(
                    ...normalizeMessageIds(await session.send(session.text('.specialForwardUserConfirmRetry')))
                );
                return true;
            },
            async () => {
                resolve(false);
            }
        ).then((promptMessageIds) => sentMessageIds.push(...promptMessageIds));
    });

    return shouldStore;
}
