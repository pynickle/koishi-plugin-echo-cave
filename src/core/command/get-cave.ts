import { Config } from '../../config/config';
import { EchoCave } from '../../index';
import { formatDate, sendCaveMsg } from '../formatter/msg-formatter';
import { Context, Session } from 'koishi';

export async function getCaveListByUser(ctx: Context, session: Session) {
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

export async function getCaveListByOriginUser(ctx: Context, session: Session) {
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

export async function getCave(ctx: Context, session: Session, cfg: Config, id: number) {
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
