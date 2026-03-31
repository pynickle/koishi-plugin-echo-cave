import { Config } from '../../config/config';
import { handleCaveSendFailure } from '../send-failure';
import { EchoCave } from '../../index';
import { PartialCaveSendError, sendCaveMsg } from '../formatter/msg-formatter';
import { Context, Session } from 'koishi';

function ensureGuildSession(session: Session): string | null {
    return session.guildId ? null : 'echo-cave.general.privateChatReminder';
}

function formatCaveIdList(caves: Pick<EchoCave, 'id'>[], separator: string = ' | '): string {
    return caves.map((cave) => cave.id).join(separator);
}

async function getCaveIdsByField(
    ctx: Context,
    session: Session,
    field: 'userId' | 'originUserId',
    emptyText: string
) {
    const guildAccessError = ensureGuildSession(session);
    if (guildAccessError) {
        return session.text(guildAccessError);
    }

    const caves = await ctx.database.get(
        'echo_cave_v2',
        {
            [field]: session.userId,
            channelId: session.channelId,
        },
        ['id']
    );

    if (caves.length === 0) {
        return session.text(emptyText);
    }

    return session.text('.msgListHeader') + '\n' + formatCaveIdList(caves);
}

async function incrementDrawCount(ctx: Context, caveMsg: EchoCave) {
    await ctx.database.set(
        'echo_cave_v2',
        {
            id: caveMsg.id,
            channelId: caveMsg.channelId,
        },
        {
            drawCount: caveMsg.drawCount + 1,
        }
    );
}

export async function getCaveListByUser(ctx: Context, session: Session) {
    return await getCaveIdsByField(ctx, session, 'userId', '.noMsgContributed');
}

export async function getCaveListByOriginUser(ctx: Context, session: Session) {
    return await getCaveIdsByField(ctx, session, 'originUserId', '.noMsgTraced');
}

export async function getCave(ctx: Context, session: Session, cfg: Config, id: number) {
    const guildAccessError = ensureGuildSession(session);
    if (guildAccessError) {
        return session.text(guildAccessError);
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
        const alpha = cfg.alpha ?? 0.2;

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
            await incrementDrawCount(ctx, caveMsg);

            return;
        }

        return await handleCaveSendFailure(ctx, session, caveMsg, cfg, error);
    }

    await incrementDrawCount(ctx, caveMsg);
}
