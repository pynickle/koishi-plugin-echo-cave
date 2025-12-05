import { checkUsersInGroup } from '../../adapters/onebot/user';
import { Config } from '../../config/config';
import { parseUserIds } from '../../utils/msg/element-helper';
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
    userIds.pop();
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

    let content: string | CQCode[];
    let type: 'forward' | 'msg';

    if (quote.elements[0].type === 'forward') {
        type = 'forward';

        const message = await reconstructForwardMsg(
            ctx,
            session,
            await session.onebot.getForwardMsg(messageId),
            cfg
        );

        content = JSON.stringify(message);
    } else {
        type = 'msg';

        const message = (await session.onebot.getMsg(messageId)).message;

        let msgJson: CQCode[];

        if (typeof message === 'string') {
            msgJson = CQCode.parse(message);
        } else {
            if (message[0].type === 'video' || message[0].type === 'file') {
                type = 'forward';
            }
            msgJson = message;
        }

        content = JSON.stringify(await processMessageContent(ctx, msgJson, cfg));
    }

    await ctx.database.get("'cho_cave_v2', { content }).then((existing) => {
        if (existing) {
            return session.text('.existingMsg');
        }
    });

    try {
        const result = await ctx.database.create("'cho_cave_v2', {
            channelId,
            createTime: new Date(),
            userId,
            originUserId: quote.user.id,
            type,
            content,
            relatedUsers: parsedUserIds || [],
        });

        return session.text('.msgSaved', [result.id]);
    } catch (error) {
        return session.text('.msgFailedToSave');
    }
}
