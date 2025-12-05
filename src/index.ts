import '@pynickle/koishi-plugin-adapter-onebot';
import { formatDate, sendCaveMsg } from './cave-helper';
import { parseUserIds } from './cqcode-helper';
import { reconstructForwardMsg } from './forward-helper';
import { deleteMediaFilesFromMessage } from './media-helper';
import { processMessageContent } from './msg-helper';
import { checkUsersInGroup } from './onebot-helper';
import { CQCode } from '@pynickle/koishi-plugin-adapter-onebot';
import { Context, Schema, Session } from 'koishi';

export const name = 'echo-cave';

export const inject = ['database'];

export interface Config {
    adminMessageProtection?: boolean;
    allowContributorDelete?: boolean;
    allowSenderDelete?: boolean;
    deleteMediaWhenDeletingMsg?: boolean;
    enableSizeLimit?: boolean;
    maxImageSize?: number;
    maxVideoSize?: number;
    maxFileSize?: number;
    maxRecordSize?: number;
    useBase64ForMedia?: boolean;
}

export const Config: Schema<Config> = Schema.object({
    adminMessageProtection: Schema.boolean().default(false),
    allowContributorDelete: Schema.boolean().default(true),
    allowSenderDelete: Schema.boolean().default(true),
    deleteMediaWhenDeletingMsg: Schema.boolean().default(true),
    enableSizeLimit: Schema.boolean().default(false),
    maxImageSize: Schema.number().default(2048),
    maxVideoSize: Schema.number().default(512),
    maxFileSize: Schema.number().default(512),
    maxRecordSize: Schema.number().default(512),
    useBase64ForMedia: Schema.boolean().default(false),
}).i18n({
    'zh-CN': require('./locales/zh-CN.json')._config,
});

export interface EchoCave {
    id: number;
    channelId: string;
    createTime: Date;
    userId: string;
    originUserId: string;
    type: 'forward' | 'msg';
    content: string;
    relatedUsers: string[];
}

declare module 'koishi' {
    interface Tables {
        echo_cave: EchoCave;
    }
}

export function apply(ctx: Context, cfg: Config) {
    ctx.i18n.define('zh-CN', require('./locales/zh-CN.json'));

    ctx.model.extend(
        'echo_cave',
        {
            id: 'unsigned',
            channelId: 'string',
            createTime: 'timestamp',
            userId: 'string',
            originUserId: 'string',
            type: 'string',
            content: 'text',
            relatedUsers: 'list',
        },
        {
            primary: 'id',
            autoInc: true,
        }
    );

    ctx.command('cave [id:number]').action(
        async ({ session }, id) => await getCave(ctx, session, cfg, id)
    );

    ctx.command('cave.echo [...userIds]').action(
        async ({ session }, ...userIds) => await addCave(ctx, session, cfg, userIds)
    );

    ctx.command('cave.wipe <id:number>').action(
        async ({ session }, id) => await deleteCave(ctx, session, cfg, id)
    );

    ctx.command('cave.listen').action(async ({ session }) => await getCaveListByUser(ctx, session));

    ctx.command('cave.trace').action(
        async ({ session }) => await getCaveListByOriginUser(ctx, session)
    );

    ctx.command('cave.bind <id:number> <...userIds>', { authority: 4 }).action(
        async ({ session }, id, ...userIds) => {
            await bindUsersToCave(ctx, session, id, userIds);
        }
    );
}

async function getCaveListByUser(ctx: Context, session: Session) {
    if (!session.guildId) {
        return session.text('echo-cave.general.privateChatReminder');
    }

    const { userId, channelId } = session;

    const caves = await ctx.database.get('echo_cave', {
        userId,
        channelId,
    });

    if (caves.length === 0) {
        return session.text('.noMsgContributed');
    }

    let response = session.text('.msgListHeader');

    for (const cave of caves) {
        response += session.text('.msgListItem', [cave.id, formatDate(cave.createTime)]);
    }

    return response;
}

async function getCaveListByOriginUser(ctx: Context, session: Session) {
    if (!session.guildId) {
        return session.text('echo-cave.general.privateChatReminder');
    }

    const { userId, channelId } = session;

    const caves = await ctx.database.get('echo_cave', {
        originUserId: userId,
        channelId,
    });

    if (caves.length === 0) {
        return session.text('.noMsgTraced');
    }

    let response = session.text('.msgListHeader');

    for (const cave of caves) {
        response += session.text('.msgListItem', [cave.id, formatDate(cave.createTime)]);
    }

    return response;
}

async function getCave(ctx: Context, session: Session, cfg: Config, id: number) {
    if (!session.guildId) {
        return session.text('echo-cave.general.privateChatReminder');
    }

    let caveMsg: EchoCave;

    const { channelId } = session;

    if (!id) {
        const caves = await ctx.database.get('echo_cave', {
            channelId,
        });

        if (caves.length === 0) {
            return session.text('.noMsgInCave');
        }

        caveMsg = caves[Math.floor(Math.random() * caves.length)];
    } else {
        const caves = await ctx.database.get('echo_cave', {
            id,
            channelId,
        });

        if (caves.length === 0) {
            return session.text('echo-cave.general.noMsgWithId');
        }

        caveMsg = caves[0];
    }

    await sendCaveMsg(ctx, session, caveMsg, cfg);
}

async function deleteCave(ctx: Context, session: Session, cfg: Config, id: number) {
    if (!session.guildId) {
        return session.text('echo-cave.general.privateChatReminder');
    }

    if (!id) {
        return session.text('.noIdProvided');
    }

    const caves = await ctx.database.get('echo_cave', id);

    if (caves.length === 0) {
        return session.text('echo-cave.general.noMsgWithId');
    }

    const caveMsg = caves[0];
    const currentUserId = session.userId;
    const user = await ctx.database.getUser(session.platform, currentUserId);
    const userAuthority = user.authority;
    const isCurrentUserAdmin = userAuthority >= 4;

    if (cfg.adminMessageProtection) {
        const caveUser = await ctx.database.getUser(session.platform, caveMsg.userId);
        const isCaveUserAdmin = caveUser.authority >= 4;

        if (isCaveUserAdmin && !isCurrentUserAdmin) {
            return session.text('.adminOnly');
        }
    }

    // Check delete permissions
    if (!isCurrentUserAdmin) {
        if (currentUserId === caveMsg.userId) {
            // Contributor check
            if (!cfg.allowContributorDelete) {
                return session.text('.contributorDeleteDenied');
            }
        } else if (currentUserId === caveMsg.originUserId) {
            // Sender check
            if (!cfg.allowSenderDelete) {
                return session.text('.senderDeleteDenied');
            }
        } else {
            // Neither contributor nor sender nor admin
            return session.text('.permissionDenied');
        }
    }

    // 如果配置开启，删除消息中的媒体文件
    if (cfg.deleteMediaWhenDeletingMsg) {
        await deleteMediaFilesFromMessage(ctx, caveMsg.content);
    }

    await ctx.database.remove('echo_cave', id);
    return session.text('.msgDeleted', [id]);
}

async function addCave(ctx: Context, session: Session, cfg: Config, userIds?: any[]) {
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
        ctx.logger.info(`Original userIds in addCave: ${JSON.stringify(userIds)}`);
        const result = parseUserIds(userIds);
        if (result.error === 'invalid_all_mention') {
            return session.text('.invalidAllMention');
        }
        parsedUserIds = result.parsedUserIds;

        // Check if all users belong to the group if userIds are provided (使用调试版本)
        const isAllUsersInGroup = await checkUsersInGroup(ctx, session, parsedUserIds);
        if (!isAllUsersInGroup) {
            return session.text('.userNotInGroup');
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

    await ctx.database.get('echo_cave', { content }).then((existing) => {
        if (existing) {
            return session.text('.existingMsg');
        }
    });

    try {
        const result = await ctx.database.create('echo_cave', {
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

async function bindUsersToCave(ctx: Context, session: Session, id: number, userIds: any[]) {
    if (!session.guildId) {
        return session.text('echo-cave.general.privateChatReminder');
    }

    if (!id) {
        return session.text('.noIdProvided');
    }

    if (!userIds || userIds.length === 0) {
        return session.text('.noUserIdProvided');
    }

    // Parse userIds to handle @mentions
    let parsedUserIds: string[] = [];
    const result = parseUserIds(userIds);
    if (result.error === 'invalid_all_mention') {
        return session.text('.invalidAllMention');
    }
    parsedUserIds = result.parsedUserIds;

    // Check if cave exists
    const caves = await ctx.database.get('echo_cave', id);
    if (caves.length === 0) {
        return session.text('echo-cave.general.noMsgWithId');
    }

    // Check if all users belong to the group (使用调试版本)
    const isAllUsersInGroup = await checkUsersInGroup(ctx, session, parsedUserIds);
    if (!isAllUsersInGroup) {
        return session.text('.userNotInGroup');
    }

    // Update cave with new related users (direct modification)
    await ctx.database.set('echo_cave', id, {
        relatedUsers: parsedUserIds,
    });

    return session.text('.userBoundSuccess', [id]);
}
