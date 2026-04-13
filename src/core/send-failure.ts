import { Config } from '../config/config';
import { EchoCave, EchoCaveSendFailure } from '../index';
import { deleteStoredCave } from './command/delete-cave';
import { Context, Session } from 'koishi';

interface SummaryTime {
    hour: number;
    minute: number;
}

interface FailureSummaryItem {
    caveId: number;
    channelId: string;
    count: number;
    lastFailTime: Date;
    lastErrorMessage: string;
}

const DEFAULT_SUMMARY_TIME = '09:00';
const MAX_ERROR_MESSAGE_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 1500;

export async function handleCaveSendFailure(
    ctx: Context,
    session: Session,
    caveMsg: EchoCave,
    cfg: Config,
    error: unknown
): Promise<string> {
    const handlingMode = cfg.sendFailureHandlingMode || 'ignore';
    const errorMessage = normalizeErrorMessage(ctx, error);

    ctx.logger.warn(`Failed to send cave #${caveMsg.id} in ${session.channelId}: ${errorMessage}`);

    if (handlingMode === 'auto-delete') {
        return handleAutoDeleteOnFailure(ctx, session, caveMsg, cfg);
    }

    if (handlingMode === 'daily-report') {
        return handleDailyReportOnFailure(ctx, session, caveMsg, cfg, errorMessage);
    }

    return session.text('commands.cave.messages.sendFailedIgnored', {
        id: caveMsg.id,
    });
}

export function registerSendFailureSummaryScheduler(ctx: Context, cfg: Config) {
    if ((cfg.sendFailureHandlingMode || 'ignore') !== 'daily-report') {
        return;
    }

    ctx.on('ready', () => {
        scheduleNextSendFailureSummary(ctx, cfg);
    });
}

async function handleAutoDeleteOnFailure(
    ctx: Context,
    session: Session,
    caveMsg: EchoCave,
    cfg: Config
): Promise<string> {
    try {
        await deleteStoredCave(ctx, cfg, caveMsg);
        return session.text('commands.cave.messages.sendFailedAutoDeleted', {
            id: caveMsg.id,
        });
    } catch (deleteError) {
        const deleteErrorMessage = normalizeErrorMessage(ctx, deleteError);
        ctx.logger.error(
            `Failed to auto-delete cave #${caveMsg.id} after send failure: ${deleteErrorMessage}`
        );
        return session.text('commands.cave.messages.sendFailedAutoDeleteAlsoFailed', {
            id: caveMsg.id,
        });
    }
}

async function handleDailyReportOnFailure(
    ctx: Context,
    session: Session,
    caveMsg: EchoCave,
    cfg: Config,
    errorMessage: string
): Promise<string> {
    const summaryAdminId = cfg.sendFailureSummaryAdminId?.trim() || '';

    try {
        await ctx.database.create('echo_cave_send_failure', {
            caveId: caveMsg.id,
            channelId: session.channelId,
            guildId: session.guildId || '',
            platform: session.platform,
            selfId: session.selfId,
            failTime: new Date(),
            errorMessage,
        });
    } catch (recordError) {
        const recordErrorMessage = normalizeErrorMessage(ctx, recordError);
        ctx.logger.error(
            `Failed to record cave send failure for #${caveMsg.id}: ${recordErrorMessage}`
        );
        return session.text('commands.cave.messages.sendFailedReportRecordFailed', {
            id: caveMsg.id,
        });
    }

    if (!summaryAdminId) {
        return session.text('commands.cave.messages.sendFailedRecordedWithoutAdmin', {
            id: caveMsg.id,
            summaryTime: cfg.sendFailureSummaryTime || DEFAULT_SUMMARY_TIME,
        });
    }

    return session.text('commands.cave.messages.sendFailedRecordedForDailyReport', {
        id: caveMsg.id,
        summaryTime: cfg.sendFailureSummaryTime || DEFAULT_SUMMARY_TIME,
    });
}

function scheduleNextSendFailureSummary(ctx: Context, cfg: Config) {
    const summaryTime = parseSummaryTime(cfg.sendFailureSummaryTime || DEFAULT_SUMMARY_TIME);
    if (!summaryTime) {
        ctx.logger.warn(
            `Invalid sendFailureSummaryTime: ${cfg.sendFailureSummaryTime}. Expected HH:mm.`
        );
        return;
    }

    const delay = getDelayUntilNextRun(summaryTime);
    ctx.setTimeout(async () => {
        try {
            await flushSendFailureSummary(ctx, cfg);
        } catch (error) {
            ctx.logger.error(
                `Failed to flush cave send failure summary: ${normalizeErrorMessage(ctx, error)}`
            );
        }

        scheduleNextSendFailureSummary(ctx, cfg);
    }, delay);
}

async function flushSendFailureSummary(ctx: Context, cfg: Config) {
    const adminId = cfg.sendFailureSummaryAdminId?.trim();
    if (!adminId) {
        ctx.logger.warn(
            'Skipped cave send failure summary because sendFailureSummaryAdminId is empty.'
        );
        return;
    }

    const failures = await ctx.database.get('echo_cave_send_failure', {});
    if (failures.length === 0) {
        return;
    }

    const groupedFailures = groupFailuresByBot(failures);
    for (const [botKey, entries] of groupedFailures.entries()) {
        const [platform, selfId] = botKey.split(':');
        const bot = ctx.bots.find((item) => item.platform === platform && item.selfId === selfId);
        if (!bot) {
            ctx.logger.warn(
                `Skipped cave send failure summary because bot ${botKey} is unavailable.`
            );
            continue;
        }

        const messages = buildSummaryMessages(ctx, entries);

        try {
            for (const message of messages) {
                await bot.sendPrivateMessage(adminId, message);
            }
        } catch (error) {
            ctx.logger.error(
                `Failed to deliver cave send failure summary through bot ${botKey}: ${normalizeErrorMessage(ctx, error)}`
            );
            continue;
        }

        try {
            for (const entry of entries) {
                await ctx.database.remove('echo_cave_send_failure', entry.id);
            }
        } catch (error) {
            ctx.logger.error(
                `Delivered cave send failure summary through bot ${botKey}, but cleanup failed: ${normalizeErrorMessage(ctx, error)}`
            );
        }
    }
}

function groupFailuresByBot(failures: EchoCaveSendFailure[]) {
    const groupedFailures = new Map<string, EchoCaveSendFailure[]>();

    for (const entry of failures) {
        const key = `${entry.platform}:${entry.selfId}`;
        const items = groupedFailures.get(key) || [];
        items.push(entry);
        groupedFailures.set(key, items);
    }

    return groupedFailures;
}

function buildSummaryMessages(ctx: Context, entries: EchoCaveSendFailure[]): string[] {
    const sortedEntries = [...entries].sort((left, right) => {
        return new Date(left.failTime).getTime() - new Date(right.failTime).getTime();
    });
    const summaryItems = summarizeFailures(sortedEntries);
    const headerLines = [
        renderLocaleText(ctx, 'commands.cave.messages.failureSummaryTitle'),
        renderLocaleText(ctx, 'commands.cave.messages.failureSummaryRange', {
            start: formatDateTime(sortedEntries[0].failTime),
            end: formatDateTime(sortedEntries.at(-1)!.failTime),
        }),
        renderLocaleText(ctx, 'commands.cave.messages.failureSummaryCount', {
            count: sortedEntries.length,
        }),
        renderLocaleText(ctx, 'commands.cave.messages.failureSummaryCaveCount', {
            count: summaryItems.length,
        }),
        '',
    ];
    const detailLines = summaryItems.map((item) => {
        return renderLocaleText(ctx, 'commands.cave.messages.failureSummaryDetail', {
            caveId: item.caveId,
            channelId: item.channelId,
            count: item.count,
            lastFailTime: formatDateTime(item.lastFailTime),
            errorMessage: item.lastErrorMessage,
        });
    });

    return splitLinesIntoMessages(ctx, headerLines, detailLines, MAX_MESSAGE_LENGTH);
}

function summarizeFailures(entries: EchoCaveSendFailure[]): FailureSummaryItem[] {
    const summaryMap = new Map<string, FailureSummaryItem>();

    for (const entry of entries) {
        const key = `${entry.channelId}:${entry.caveId}`;
        const existing = summaryMap.get(key);

        if (!existing) {
            summaryMap.set(key, {
                caveId: entry.caveId,
                channelId: entry.channelId,
                count: 1,
                lastFailTime: new Date(entry.failTime),
                lastErrorMessage: entry.errorMessage,
            });
            continue;
        }

        existing.count += 1;
        existing.lastFailTime = new Date(entry.failTime);
        existing.lastErrorMessage = entry.errorMessage;
    }

    return [...summaryMap.values()].sort((left, right) => {
        if (right.count !== left.count) {
            return right.count - left.count;
        }

        return right.lastFailTime.getTime() - left.lastFailTime.getTime();
    });
}

function splitLinesIntoMessages(
    ctx: Context,
    headerLines: string[],
    detailLines: string[],
    maxLength: number
): string[] {
    const messages: string[] = [];
    let current = headerLines.join('\n');

    for (const line of detailLines) {
        const next = current ? `${current}\n${line}` : line;
        if (next.length <= maxLength) {
            current = next;
            continue;
        }

        messages.push(current);
        current = `${renderLocaleText(ctx, 'commands.cave.messages.failureSummaryContinuationTitle')}\n${line}`;
    }

    if (current) {
        messages.push(current);
    }

    return messages;
}

function parseSummaryTime(value: string): SummaryTime | null {
    const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) {
        return null;
    }

    const hour = Number(match[1]);
    const minute = Number(match[2]);

    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return null;
    }

    return { hour, minute };
}

function getDelayUntilNextRun(summaryTime: SummaryTime): number {
    const now = new Date();
    const nextRun = new Date(now);
    nextRun.setSeconds(0, 0);
    nextRun.setHours(summaryTime.hour, summaryTime.minute, 0, 0);

    if (nextRun.getTime() <= now.getTime()) {
        nextRun.setDate(nextRun.getDate() + 1);
    }

    return nextRun.getTime() - now.getTime();
}

function normalizeErrorMessage(ctx: Context, error: unknown): string {
    if (error instanceof Error) {
        return error.message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
    }

    if (typeof error === 'string') {
        return error.slice(0, MAX_ERROR_MESSAGE_LENGTH);
    }

    return renderLocaleText(ctx, 'commands.cave.messages.unknownError');
}

function renderLocaleText(
    ctx: Context,
    path: string,
    params: Record<string, unknown> = {}
): string {
    const locales = [...(ctx.root.config.i18n?.locales || []), 'zh-CN'];
    return ctx.i18n.render(locales, [path], params).join('');
}

function formatDateTime(date: Date): string {
    return new Date(date).toLocaleString('zh-CN', {
        hour12: false,
    });
}
