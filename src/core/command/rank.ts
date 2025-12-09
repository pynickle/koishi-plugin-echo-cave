import { getUserName } from '../../adapters/onebot/user';
import { Config } from '../../config/config';
import { EchoCave } from '../../index';
import { createTextMsgNode } from '../../utils/msg/cqcode-helper';
import { Context, Session } from 'koishi';

// Define supported period types
export type Period = 'lday' | 'lweek' | 'lmonth' | 'day' | 'week' | 'month' | 'all' | string;

// List of supported predefined periods
export const PREDEFINED_PERIODS: Array<Period> = [
    'lday',
    'lweek',
    'lmonth',
    'day',
    'week',
    'month',
    'all',
];

// Time unit multipliers (in milliseconds)
const TIME_UNITS = {
    m: 60 * 1000, // minutes
    h: 60 * 60 * 1000, // hours
    d: 24 * 60 * 60 * 1000, // days
    w: 7 * 24 * 60 * 60 * 1000, // weeks
    M: 30 * 24 * 60 * 60 * 1000, // months (approximate)
};

// Parse custom time string (e.g., "1d", "2d5h", "30m")
function parseCustomTime(timeStr: string): number | null {
    // Regular expression to match time units (e.g., "1d", "2d5h", "30m")
    const regex = /(\d+)([mhdwM])/g;
    let match;
    let totalMs = 0;
    let lastUnit = '';
    const unitOrder = ['M', 'w', 'd', 'h', 'm'];

    // Check if the time string is valid
    if (!/^\d+([mhdwM]\d*)*$/.test(timeStr)) {
        return null;
    }

    // Parse each time unit
    while ((match = regex.exec(timeStr)) !== null) {
        const [, value, unit] = match;
        const num = parseInt(value, 10);

        // Check if unit order is correct (larger units first)
        const currentIndex = unitOrder.indexOf(unit);
        const lastIndex = unitOrder.indexOf(lastUnit);
        if (lastUnit && currentIndex > lastIndex) {
            return null;
        }

        // Calculate milliseconds
        totalMs += num * TIME_UNITS[unit as keyof typeof TIME_UNITS];
        lastUnit = unit;
    }

    return totalMs;
}

// Calculate start time for a given period
function getStartTime(period: Period): Date {
    const now = new Date();
    const startTime = new Date();

    // Check if it's a custom time string
    const customTime = parseCustomTime(period as string);
    if (customTime !== null) {
        // For custom time, subtract the duration from current time
        startTime.setTime(now.getTime() - customTime);
        return startTime;
    }

    // Handle predefined periods
    switch (period) {
        // Last day/week/month (previous 24h, 7d, 30d)
        case 'lday':
            startTime.setDate(now.getDate() - 1);
            break;
        case 'lweek':
            startTime.setDate(now.getDate() - 7);
            break;
        case 'lmonth':
            startTime.setDate(now.getDate() - 30);
            break;

        // This day/week/month (from start of period to now)
        case 'day':
            // Start of today (00:00:00)
            startTime.setHours(0, 0, 0, 0);
            break;
        case 'week':
            // Start of this week (Monday 00:00:00)
            const dayOfWeek = now.getDay();
            const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
            startTime.setDate(now.getDate() - daysToMonday);
            startTime.setHours(0, 0, 0, 0);
            break;
        case 'month':
            // Start of this month (1st day 00:00:00)
            startTime.setDate(1);
            startTime.setHours(0, 0, 0, 0);
            break;

        // All time
        case 'all':
            startTime.setTime(0); // 1970-01-01
            break;

        // Default case (should not happen due to validation)
        default:
            startTime.setTime(0);
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

    // Check if it's a predefined period or a valid custom time
    if (
        !PREDEFINED_PERIODS.includes(normalizedPeriod as Period) &&
        parseCustomTime(normalizedPeriod) === null
    ) {
        await session.send(session.text('.invalidPeriod', [PREDEFINED_PERIODS.join(', ')]));
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
