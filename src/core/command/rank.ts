import { getUserName } from '../../adapters/onebot/user';
import { Config } from '../../config/config';
import { EchoCave } from '../../index';
import { createTextMsgNode } from '../../utils/msg/cqcode-helper';
import { Context, Session } from 'koishi';

// Define supported period types
export type Period = 'day' | 'week' | 'month' | 'all';

// List of supported periods
export const SUPPORTED_PERIODS: Period[] = ['day', 'week', 'month', 'all'];

// Calculate start time for a given period
function getStartTime(period: Period): Date {
    const now = new Date();
    const startTime = new Date();

    switch (period) {
        case 'day':
            startTime.setDate(now.getDate() - 1);
            break;
        case 'week':
            startTime.setDate(now.getDate() - 7);
            break;
        case 'month':
            startTime.setMonth(now.getMonth() - 1);
            break;
        case 'all':
            startTime.setTime(0); // 1970-01-01
            break;
    }

    return startTime;
}

// Count user occurrences in relatedUsers and possibly originUserId
function countUserOccurrences(caves: EchoCave[]): Map<string, number> {
    const countMap = new Map<string, number>();

    caves.forEach((cave) => {
        // Consider origin user as related user only if configured
        if (cave.relatedUsers.length === 0) {
            countMap.set(cave.originUserId, (countMap.get(cave.originUserId) || 0) + 1);
        } else {
            // Iterate through all related users
            cave.relatedUsers.forEach((userId) => {
                countMap.set(userId, (countMap.get(userId) || 0) + 1);
            });
        }
    });

    return countMap;
}

// Generate ranking text
async function generateRankingText(
    ctx: Context,
    session: Session,
    countMap: Map<string, number>,
    topCount: number
): Promise<string> {
    // Convert to array and sort
    const sortedUsers = Array.from(countMap.entries())
        .sort(([, a], [, b]) => b - a)
        .slice(0, topCount);

    let text = '';

    // Generate ranking content
    if (sortedUsers.length === 0) {
        text += session.text('.noData');
    } else {
        for (let i = 0; i < sortedUsers.length; i++) {
            const [userId, count] = sortedUsers[i];
            const userName = await getUserName(ctx, session, userId);
            const rank = i + 1;

            // Add different emojis based on rank
            let rankEmoji = '';
            switch (rank) {
                case 1:
                    rankEmoji = '🥇';
                    break;
                case 2:
                    rankEmoji = '🥈';
                    break;
                case 3:
                    rankEmoji = '🥉';
                    break;
                default:
                    rankEmoji = `${rank}.`;
            }

            // Add rank line without trailing newline for the last line
            const rankData = { rankEmoji, userName, count };
            if (i === sortedUsers.length - 1) {
                text += session.text('.rankFormat', rankData);
            } else {
                text += session.text('.rankFormat', rankData) + '\n';
            }
        }
    }

    return text;
}

export async function getRanking(
    ctx: Context,
    session: Session,
    cfg: Config,
    period: string = 'all'
): Promise<void> {
    if (!session.guildId) {
        await session.send(session.text('echo-cave.general.privateChatReminder'));
        return;
    }

    // Validate period parameter
    const normalizedPeriod = period.toLowerCase();
    if (!SUPPORTED_PERIODS.includes(normalizedPeriod as Period)) {
        await session.send(session.text('.invalidPeriod', [SUPPORTED_PERIODS.join(', ')]));
        return;
    }

    const { channelId } = session;
    const startTime = getStartTime(normalizedPeriod as Period);
    const topCount = cfg.rankingTopCount || 10;

    // Query all cave records within the specified period
    const caves = (await ctx.database.get('echo_cave_v2', {
        channelId,
        createTime: {
            $gte: startTime,
        },
    })) as EchoCave[];

    // Count user occurrences
    const countMap = countUserOccurrences(caves);

    // Generate ranking text
    const rankingText = await generateRankingText(ctx, session, countMap, topCount);

    const botName = (await getUserName(this.ctx, session, session.bot?.userId)) || 'Bot';

    // Get period text from localization
    const periodText = session.text(`.period.${period}`);

    // Generate title
    let title = session.text('.rankingTitle', [periodText]);

    // Send forward message
    await session.onebot.sendGroupForwardMsg(channelId, [
        createTextMsgNode(session.bot?.userId || session.userId, botName, title),
        createTextMsgNode(session.bot?.userId || session.userId, botName, rankingText),
    ]);
}
