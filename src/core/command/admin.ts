import { Config } from '../../config/config';
import {
    MediaType,
    inspectCaveMediaRefs,
    mergeChannelCaves,
    migrateLocalMediaToS3,
    migrateLocalMediaToV2,
} from '../../utils/media/media-helper';
import { listenForUserMessage } from '../../utils/msg/message-listener';
import { Context, Session } from 'koishi';

function ensureAdminPrivateAccess(session: Session, cfg: Config): string | null {
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

function toChineseBooleanLabel(value: boolean): string {
    return value ? '保留' : '不保留';
}

function toChineseMediaTypeLabel(type: MediaType): string {
    switch (type) {
        case 'image':
            return '图片';
        case 'video':
            return '视频';
        case 'record':
            return '语音';
        default:
            return '文件';
    }
}

function appendFailedRecordSummary(message: string, failedRecordIds?: number[]): string {
    if (!failedRecordIds || failedRecordIds.length === 0) {
        return message;
    }

    return `${message}\n⚠️ 失败记录 ID：${failedRecordIds.join(', ')}`;
}

async function requestSecondConfirmation(
    ctx: Context,
    session: Session,
    summary: string,
    retryMessage: string,
    timeoutMessage: string,
    cancelledMessage: string
): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        listenForUserMessage(
            ctx,
            session,
            summary,
            30000,
            async (message) => {
                const normalized = message.trim();

                if (normalized === '确认') {
                    resolve(true);
                    return false;
                }

                if (normalized === '取消') {
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
            keepSource: toChineseBooleanLabel(keepSource),
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
        session.text('commands.cave.admin.merge.messages.mergeDone', result),
        result.failedRecordIds
    );
}

export async function migrateLegacyLocalMedia(
    ctx: Context,
    session: Session,
    cfg: Config
) {
    const accessError = ensureAdminPrivateAccess(session, cfg);
    if (accessError) {
        return accessError;
    }

    const result = await migrateLocalMediaToV2(ctx, cfg);
    return appendFailedRecordSummary(
        session.text('commands.cave.admin.migrate-local-v2.messages.migrateDone', result),
        result.failedRecordIds
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
            mediaStorage: cfg.mediaStorage || 'local',
            bucket: cfg.s3Bucket,
            prefix: cfg.s3PathPrefix || '(空)',
            keepLocal: toChineseBooleanLabel(keepLocal),
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
                            mediaType: toChineseMediaTypeLabel(mediaType),
                        })
                    );
                }
            },
        };
    });
    return appendFailedRecordSummary(
        session.text('commands.cave.admin.migrate-s3.messages.migrateDone', result),
        result.failedRecordIds
    );
}

export async function inspectMediaRefsForMigration(ctx: Context, session: Session, cfg: Config) {
    const accessError = ensureAdminPrivateAccess(session, cfg);
    if (accessError) {
        return accessError;
    }

    const results = await inspectCaveMediaRefs(ctx);
    if (results.length === 0) {
        return session.text('commands.cave.admin.inspect-media.messages.noMediaFound');
    }

    for (const { id, refs } of results) {
        await session.send(`回声洞 #${id}\n${refs.join('\n')}`);
    }
}
