import { Config } from '../../config/config';
import { EchoCave } from '../../index';
import {
    MediaType,
    inspectCaveMediaRefs,
    mergeChannelCaves,
    migrateLocalMediaToS3,
    migrateLocalMediaToV2,
} from '../../utils/media/media-helper';
import { listenForUserMessage } from '../../utils/msg/message-listener';
import { Context, Session } from 'koishi';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const REINDEX_SPECIAL_OFFSET = 1000000;
let caveMaintenanceLock = false;

interface IdRange {
    start: number;
    end: number;
}

interface ReindexPlanItem {
    oldId: number;
    newId: number;
    tempId: number;
}

interface ReindexBackupPayload {
    createdAt: string;
    records: EchoCave[];
    mapping: ReindexPlanItem[];
}

export function getCaveMaintenanceMessage(session: Session): string | null {
    return caveMaintenanceLock ? session.text('echo-cave.general.maintenanceLocked') : null;
}

function setCaveMaintenanceLock(value: boolean) {
    caveMaintenanceLock = value;
}

function ensureAdminPrivateAccess(session: Session, cfg: Config): string | null {
    const maintenanceMessage = getCaveMaintenanceMessage(session);
    if (maintenanceMessage) {
        return maintenanceMessage;
    }

    if (session.guildId) {
        return session.text('echo-cave.general.adminPrivateOnly');
    }

    if (!cfg.adminIds?.includes(session.userId)) {
        return session.text('echo-cave.general.adminPermissionDenied');
    }

    return null;
}

function parseBooleanOption(value: string | undefined, defaultValue: boolean): boolean | null {
    if (!value) {
        return defaultValue;
    }

    switch (value.trim().toLowerCase()) {
        case 'true':
        case '1':
        case 'yes':
        case 'y':
        case 'keep':
        case '保留':
        case '是':
            return true;
        case 'false':
        case '0':
        case 'no':
        case 'n':
        case 'drop':
        case 'remove':
        case '删除':
        case '否':
            return false;
        default:
            return null;
    }
}

function getBooleanLabel(session: Session, value: boolean): string {
    return session.text(
        value ? 'commands.cave.admin.common.boolean.keep' : 'commands.cave.admin.common.boolean.drop'
    );
}

function getMediaTypeLabel(session: Session, type: MediaType): string {
    switch (type) {
        case 'image':
            return session.text('commands.cave.admin.common.mediaType.image');
        case 'video':
            return session.text('commands.cave.admin.common.mediaType.video');
        case 'record':
            return session.text('commands.cave.admin.common.mediaType.record');
        default:
            return session.text('commands.cave.admin.common.mediaType.file');
    }
}

function getMediaStorageLabel(session: Session, storage: string): string {
    return session.text(
        storage === 's3'
            ? 'commands.cave.admin.common.mediaStorage.s3'
            : 'commands.cave.admin.common.mediaStorage.local'
    );
}

function getEmptyValueLabel(session: Session): string {
    return session.text('commands.cave.admin.common.emptyValue');
}

function appendFailedRecordSummary(
    session: Session,
    message: string,
    failedRecordIds?: number[]
): string {
    if (!failedRecordIds || failedRecordIds.length === 0) {
        return message;
    }

    return session.text('commands.cave.admin.common.failedRecordSummary', {
        message,
        failedRecordIds: failedRecordIds.join(', '),
    });
}

function getAllRangesLabel(session: Session): string {
    return session.text('commands.cave.admin.inspect-media.messages.allRanges');
}

function parseIdRanges(value: string | undefined): IdRange[] | null {
    if (!value?.trim()) {
        return [];
    }

    const segments = value
        .split(',')
        .map((segment) => segment.trim())
        .filter(Boolean);

    if (segments.length === 0) {
        return [];
    }

    const ranges: IdRange[] = [];
    for (const segment of segments) {
        if (/^\d+$/.test(segment)) {
            const id = Number(segment);
            ranges.push({ start: id, end: id });
            continue;
        }

        const rangeMatch = segment.match(/^(\d+)-(\d+)$/);
        if (!rangeMatch) {
            return null;
        }

        const start = Number(rangeMatch[1]);
        const end = Number(rangeMatch[2]);
        if (start > end) {
            return null;
        }

        ranges.push({ start, end });
    }

    return ranges;
}

function isIdInRanges(id: number, ranges: IdRange[]): boolean {
    if (ranges.length === 0) {
        return true;
    }

    return ranges.some((range) => id >= range.start && id <= range.end);
}

async function requestSecondConfirmation(
    ctx: Context,
    session: Session,
    summary: string,
    retryMessage: string,
    timeoutMessage: string,
    cancelledMessage: string
): Promise<boolean> {
    const confirmInput = session.text('commands.cave.admin.common.confirmInput');
    const cancelInput = session.text('commands.cave.admin.common.cancelInput');

    return new Promise<boolean>((resolve) => {
        listenForUserMessage(
            ctx,
            session,
            summary,
            30000,
            async (message) => {
                const normalized = message.trim();

                if (normalized === confirmInput) {
                    resolve(true);
                    return false;
                }

                if (normalized === cancelInput) {
                    await session.send(cancelledMessage);
                    resolve(false);
                    return false;
                }

                await session.send(retryMessage);
                return true;
            },
            async () => {
                await session.send(timeoutMessage);
                resolve(false);
            }
        );
    });
}

export async function mergeCavesBetweenChannels(
    ctx: Context,
    session: Session,
    cfg: Config,
    sourceChannelId: string,
    targetChannelId: string,
    keepSourceOption?: string
) {
    const accessError = ensureAdminPrivateAccess(session, cfg);
    if (accessError) {
        return accessError;
    }

    const keepSource = parseBooleanOption(keepSourceOption, true);
    if (keepSource === null) {
        return session.text('commands.cave.admin.merge.messages.invalidBoolean');
    }

    if (sourceChannelId === targetChannelId) {
        return session.text('commands.cave.admin.merge.messages.sameChannel');
    }

    const sourceCaves = await ctx.database.get('echo_cave_v2', { channelId: sourceChannelId });
    if (sourceCaves.length === 0) {
        return session.text('commands.cave.admin.merge.messages.noSourceCaves');
    }

    const targetCaves = await ctx.database.get('echo_cave_v2', { channelId: targetChannelId });
    const confirmed = await requestSecondConfirmation(
        ctx,
        session,
        session.text('commands.cave.admin.merge.messages.confirmSummary', {
            sourceChannelId,
            targetChannelId,
            sourceCount: sourceCaves.length,
            targetCount: targetCaves.length,
            keepSource: getBooleanLabel(session, keepSource),
        }),
        session.text('commands.cave.admin.merge.messages.confirmRetry'),
        session.text('commands.cave.admin.merge.messages.confirmTimeout'),
        session.text('commands.cave.admin.merge.messages.confirmCancelled')
    );

    if (!confirmed) {
        return;
    }

    const result = await mergeChannelCaves(ctx, cfg, sourceChannelId, targetChannelId, keepSource);
    return appendFailedRecordSummary(
        session,
        session.text('commands.cave.admin.merge.messages.mergeDone', result),
        result.failedRecordIds,
    );
}

export async function migrateLegacyLocalMedia(ctx: Context, session: Session, cfg: Config) {
    const accessError = ensureAdminPrivateAccess(session, cfg);
    if (accessError) {
        return accessError;
    }

    const result = await migrateLocalMediaToV2(ctx, cfg);
    return appendFailedRecordSummary(
        session,
        session.text('commands.cave.admin.migrate-local-v2.messages.migrateDone', result),
        result.failedRecordIds,
    );
}

export async function migrateMediaToS3(
    ctx: Context,
    session: Session,
    cfg: Config,
    keepLocalOption?: string
) {
    const accessError = ensureAdminPrivateAccess(session, cfg);
    if (accessError) {
        return accessError;
    }

    if (!cfg.s3Bucket || !cfg.s3Region) {
        return session.text('commands.cave.admin.migrate-s3.messages.s3NotConfigured');
    }

    const keepLocal = parseBooleanOption(keepLocalOption, true);
    if (keepLocal === null) {
        return session.text('commands.cave.admin.migrate-s3.messages.invalidBoolean');
    }

    const confirmed = await requestSecondConfirmation(
        ctx,
        session,
        session.text('commands.cave.admin.migrate-s3.messages.confirmSummary', {
            mediaStorage: getMediaStorageLabel(session, cfg.mediaStorage || 'local'),
            bucket: cfg.s3Bucket,
            prefix: cfg.s3PathPrefix || getEmptyValueLabel(session),
            keepLocal: getBooleanLabel(session, keepLocal),
        }),
        session.text('commands.cave.admin.migrate-s3.messages.confirmRetry'),
        session.text('commands.cave.admin.migrate-s3.messages.confirmTimeout'),
        session.text('commands.cave.admin.migrate-s3.messages.confirmCancelled')
    );

    if (!confirmed) {
        return;
    }

    const result = await migrateLocalMediaToS3(ctx, cfg, keepLocal, (caveId) => {
        const uploadedMediaTypes: MediaType[] = [];
        return {
            onS3Upload: async (type) => {
                uploadedMediaTypes.push(type);
            },
            onMigrationCommitted: async () => {
                for (const mediaType of uploadedMediaTypes) {
                    await session.send(
                        session.text('commands.cave.admin.migrate-s3.messages.itemUploaded', {
                            caveId,
                            mediaType: getMediaTypeLabel(session, mediaType),
                        })
                    );
                }
            },
        };
    });
    return appendFailedRecordSummary(
        session,
        session.text('commands.cave.admin.migrate-s3.messages.migrateDone', result),
        result.failedRecordIds,
    );
}

export async function inspectMediaRefsForMigration(
    ctx: Context,
    session: Session,
    cfg: Config,
    idRangesOption?: string
) {
    const accessError = ensureAdminPrivateAccess(session, cfg);
    if (accessError) {
        return accessError;
    }

    const idRanges = parseIdRanges(idRangesOption);
    if (idRanges === null) {
        return session.text('commands.cave.admin.inspect-media.messages.invalidRange');
    }

    const displayRanges = idRangesOption?.trim() || getAllRangesLabel(session);
    const results = await inspectCaveMediaRefs(ctx, (id) => isIdInRanges(id, idRanges));
    if (results.length === 0) {
        return session.text('commands.cave.admin.inspect-media.messages.noMediaFound', {
            idRanges: displayRanges,
        });
    }

    const confirmed = await requestSecondConfirmation(
        ctx,
        session,
        session.text('commands.cave.admin.inspect-media.messages.confirmSummary', {
            idRanges: displayRanges,
            matchedCount: results.length,
        }),
        session.text('commands.cave.admin.inspect-media.messages.confirmRetry'),
        session.text('commands.cave.admin.inspect-media.messages.confirmTimeout'),
        session.text('commands.cave.admin.inspect-media.messages.confirmCancelled')
    );

    if (!confirmed) {
        return;
    }

    for (const { id, refs } of results) {
        await session.send(
            session.text('commands.cave.admin.inspect-media.messages.resultItem', {
                id,
                refs: refs.join('\n'),
            })
        );
    }
}

function buildReindexPlan(caves: EchoCave[]): ReindexPlanItem[] {
    const maxId = caves.reduce((currentMax, cave) => Math.max(currentMax, cave.id), 0);
    const offset = maxId + caves.length + REINDEX_SPECIAL_OFFSET;

    return caves.map((cave, index) => ({
        oldId: cave.id,
        newId: index + 1,
        tempId: cave.id + offset,
    }));
}

function hasIdGaps(plan: ReindexPlanItem[]) {
    return plan.some((item) => item.oldId !== item.newId);
}

async function writeReindexBackup(
    backupDir: string,
    caves: EchoCave[],
    mapping: ReindexPlanItem[]
) {
    await fs.mkdir(backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `echo-cave-reindex-${timestamp}.json`);
    const payload: ReindexBackupPayload = {
        createdAt: new Date().toISOString(),
        records: caves,
        mapping,
    };

    await fs.writeFile(backupPath, JSON.stringify(payload, null, 2), 'utf8');
    return backupPath;
}

async function applyReindexPlan(ctx: Context, plan: ReindexPlanItem[]) {
    const descendingPlan = [...plan].sort((a, b) => b.oldId - a.oldId);
    for (const item of descendingPlan) {
        if (item.oldId === item.newId) {
            continue;
        }

        await ctx.database.set('echo_cave_v2', { id: item.oldId }, { id: item.tempId });
    }

    const ascendingPlan = [...plan].sort((a, b) => a.newId - b.newId);
    for (const item of ascendingPlan) {
        if (item.oldId === item.newId) {
            continue;
        }

        await ctx.database.set('echo_cave_v2', { id: item.tempId }, { id: item.newId });
    }
}

async function verifyReindexPlan(ctx: Context, originalCaves: EchoCave[]) {
    const reindexedCaves = (await ctx.database.get('echo_cave_v2', {})).sort((a, b) => a.id - b.id);

    if (reindexedCaves.length !== originalCaves.length) {
        throw new Error('record_count_mismatch');
    }

    const normalizedOriginal = [...originalCaves]
        .sort((a, b) => a.id - b.id)
        .map((cave) => ({
            channelId: cave.channelId,
            content: cave.content,
            createTime: new Date(cave.createTime).toISOString(),
            drawCount: cave.drawCount,
            originUserId: cave.originUserId,
            relatedUsers: [...cave.relatedUsers],
            type: cave.type,
            userId: cave.userId,
        }));
    const normalizedReindexed = reindexedCaves.map((cave, index) => ({
        channelId: cave.channelId,
        content: cave.content,
        createTime: new Date(cave.createTime).toISOString(),
        drawCount: cave.drawCount,
        id: cave.id,
        originUserId: cave.originUserId,
        relatedUsers: [...cave.relatedUsers],
        type: cave.type,
        userId: cave.userId,
        expectedId: index + 1,
    }));

    for (let index = 0; index < normalizedReindexed.length; index++) {
        const reindexed = normalizedReindexed[index];
        const original = normalizedOriginal[index];

        if (reindexed.id !== reindexed.expectedId) {
            throw new Error('id_sequence_mismatch');
        }

        if (
            reindexed.channelId !== original.channelId ||
            reindexed.content !== original.content ||
            reindexed.createTime !== original.createTime ||
            reindexed.drawCount !== original.drawCount ||
            reindexed.originUserId !== original.originUserId ||
            reindexed.relatedUsers.join(',') !== original.relatedUsers.join(',') ||
            reindexed.type !== original.type ||
            reindexed.userId !== original.userId
        ) {
            throw new Error('record_content_mismatch');
        }
    }
}

export async function reindexCaveIds(ctx: Context, session: Session, cfg: Config) {
    if (caveMaintenanceLock) {
        return session.text('echo-cave.general.maintenanceLocked');
    }

    if (session.guildId) {
        return session.text('echo-cave.general.adminPrivateOnly');
    }

    if (!cfg.adminIds?.includes(session.userId)) {
        return session.text('echo-cave.general.adminPermissionDenied');
    }

    const caves = (await ctx.database.get('echo_cave_v2', {})).sort((a, b) => a.id - b.id);
    if (caves.length === 0) {
        return session.text('commands.cave.admin.reindex.messages.noCaves');
    }

    const plan = buildReindexPlan(caves);
    if (!hasIdGaps(plan)) {
        return session.text('commands.cave.admin.reindex.messages.alreadySequential');
    }

    let backupPath: string;
    try {
        backupPath = await writeReindexBackup(path.resolve(process.cwd(), 'logs'), caves, plan);
    } catch (error) {
        ctx.logger.error(`Failed to write cave reindex backup: ${error}`);
        return session.text('commands.cave.admin.reindex.messages.backupWriteFailed', {
            error: error instanceof Error ? error.message : String(error),
        });
    }

    const confirmed = await requestSecondConfirmation(
        ctx,
        session,
        session.text('commands.cave.admin.reindex.messages.confirmSummary', {
            caveCount: caves.length,
            currentMaxId: caves[caves.length - 1].id,
            nextMaxId: caves.length,
            backupPath,
        }),
        session.text('commands.cave.admin.reindex.messages.confirmRetry'),
        session.text('commands.cave.admin.reindex.messages.confirmTimeout'),
        session.text('commands.cave.admin.reindex.messages.confirmCancelled')
    );

    if (!confirmed) {
        return;
    }

    setCaveMaintenanceLock(true);
    try {
        await applyReindexPlan(ctx, plan);
        await verifyReindexPlan(ctx, caves);
        return session.text('commands.cave.admin.reindex.messages.reindexDone', {
            caveCount: caves.length,
            backupPath,
        });
    } catch (error) {
        ctx.logger.error(`Failed to reindex cave ids: ${error}`);
        return session.text('commands.cave.admin.reindex.messages.reindexFailed', {
            backupPath,
            error: error instanceof Error ? error.message : String(error),
        });
    } finally {
        setCaveMaintenanceLock(false);
    }
}
