import { Config } from '../../config/config';
import { handleCaveSendFailure } from '../send-failure';
import { EchoCave } from '../../index';
import { PartialCaveSendError, sendCaveMsg } from '../formatter/msg-formatter';
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

        // Use weighted random selection based on drawCount
        const alpha = cfg.alpha || 0.2;

        // Calculate weights for each cave
        const weights = caves.map((cave) => 1 / (1 + cave.drawCount * alpha));

        // Calculate total weight
        const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

        // Generate a random number between 0 and totalWeight
        let random = Math.random() * totalWeight;

        // Select cave based on weights
        let selectedIndex = 0;
        while (random > weights[selectedIndex]) {
            random -= weights[selectedIndex];
            selectedIndex++;
        }

        caveMsg = caves[selectedIndex];
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

    try {
        await sendCaveMsg(ctx, session, caveMsg, cfg);
    } catch (error) {
        if (error instanceof PartialCaveSendError) {
            await ctx.database.set(
                'echo_cave_v2',
                {
                    id: caveMsg.id,
                    channelId,
                },
                {
                    drawCount: caveMsg.drawCount + 1,
                }
            );

            return;
        }

        return await handleCaveSendFailure(ctx, session, caveMsg, cfg, error);
    }

    await ctx.database.set(
        'echo_cave_v2',
        {
            id: caveMsg.id,
            channelId,
        },
        {
            drawCount: caveMsg.drawCount + 1,
        }
    );
}
