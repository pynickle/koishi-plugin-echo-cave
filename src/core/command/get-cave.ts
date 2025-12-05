import { Config } from '../../config/config';
import { EchoCave } from '../../index';
import { formatDate, sendCaveMsg } from '../formatter/msg-formatter';
import { Context, Session } from 'koishi';

export async function getCaveListByUser(ctx: Context, session: Session) {
    if (!session.guildId) {
        return session.text('echo-cave.general.privateChatReminder');
    }

    const { userId, channelId } = session;

    const caves = await ctx.database.get(
        'echo_cave_v2',
        {
            userId,
            channelId,
        },
        ['id']
    );

    if (caves.length === 0) {
        return session.text('.noMsgContributed');
    }

    const ids = caves.map((cave) => cave.id).join(' | ');
    return session.text('.msgListHeader') + '\n' + ids;
}

export async function getCaveListByOriginUser(ctx: Context, session: Session) {
    if (!session.guildId) {
        return session.text('echo-cave.general.privateChatReminder');
    }

    const { userId, channelId } = session;

    const caves = await ctx.database.get(
        'echo_cave_v2',
        {
            originUserId: userId,
            channelId,
        },
        ['id']
    );

    if (caves.length === 0) {
        return session.text('.noMsgTraced');
    }

    const ids = caves.map((cave) => cave.id).join(' | ');
    return session.text('.msgListHeader') + '\n' + ids;
}

export async function getCave(ctx: Context, session: Session, cfg: Config, id: number) {
    if (!session.guildId) {
        return session.text('echo-cave.general.privateChatReminder');
    }

    let caveMsg: EchoCave;

    const { channelId } = session;

    if (!id) {
        const caves = await ctx.database.get('echo_cave_v2', {
            channelId,
        });

        if (caves.length === 0) {
            return session.text('.noMsgInCave');
        }

        caveMsg = caves[Math.floor(Math.random() * caves.length)];
    } else {
        const caves = await ctx.database.get('echo_cave_v2', {
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
