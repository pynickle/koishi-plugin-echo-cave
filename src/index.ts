import { Config } from './config/config';
import {
  ACTIVE_CAVE_TABLE,
  CaveSnapshotRecord,
  createEmptyCaveMediaUrlFields,
} from './core/cave-store';
import { addCave } from './core/command/add-cave';
import {
  backfillCaveMediaUrls,
  inspectMediaRefsForMigration,
  mergeCavesBetweenChannels,
  migrateLegacyLocalMedia,
  migrateMediaToS3,
  reindexCaveIds,
  registerAutoReindexScheduler,
  restoreReindexBackup,
} from './core/command/admin';
import { deleteCave, deleteCaves } from './core/command/delete-cave';
import { getCave, getCaveListByOriginUser, getCaveListByUser } from './core/command/get-cave';
import { registerSendFailureSummaryScheduler } from './core/send-failure';
import { bindUsersToCave } from './core/command/misc/bind-user';
import { getRanking } from './core/command/rank';
import { searchCave } from './core/command/search-cave';
import zhCN from './locales/zh-CN.json';
import { Context } from 'koishi';

export const name = 'echo-cave';

export const inject = ['database'];

export * from './config/config';

export interface EchoCave {
  entryId?: number;
  id: number;
  channelId: string;
  createTime: Date;
  userId: string;
  originUserId: string;
  type: 'forward' | 'msg';
  content: string;
  relatedUsers: string[];
  drawCount: number;
  picDrawCount: number;
  fileUrls: string[];
  imageUrls: string[];
  recordUrls: string[];
  videoUrls: string[];
}

export interface EchoCaveSendFailure {
  id: number;
  caveId: number;
  channelId: string;
  guildId: string;
  platform: string;
  selfId: string;
  failTime: Date;
  errorMessage: string;
}

export interface EchoCaveUserState {
  userId: string;
  hasCompletedForwardSelection: boolean;
}

declare module 'koishi' {
  interface Tables {
    echo_cave: EchoCave;
    echo_cave_v2: EchoCave;
    echo_cave_v3: EchoCave;
    echo_cave_send_failure: EchoCaveSendFailure;
    echo_cave_user_state: EchoCaveUserState;
  }
}

function toV3Record(record: CaveSnapshotRecord) {
  const mediaUrlFields = createEmptyCaveMediaUrlFields();

  return {
    id: record.id,
    channelId: record.channelId,
    createTime: new Date(record.createTime),
    userId: record.userId,
    originUserId: record.originUserId,
    type: record.type,
    content: record.content,
    relatedUsers: [...record.relatedUsers],
    drawCount: record.drawCount,
    picDrawCount: record.picDrawCount ?? 0,
    ...mediaUrlFields,
  };
}

export function apply(ctx: Context, cfg: Config) {
  ctx.i18n.define('zh-CN', zhCN);

  ctx.model.extend(
    ACTIVE_CAVE_TABLE,
    {
      entryId: 'unsigned',
      id: 'unsigned',
      channelId: 'string',
      createTime: 'timestamp',
      userId: 'string',
      originUserId: 'string',
      type: 'string',
      content: 'text',
      relatedUsers: 'list',
      drawCount: { type: 'unsigned', initial: 0 },
      picDrawCount: { type: 'unsigned', initial: 0 },
      fileUrls: { type: 'list', initial: [] },
      imageUrls: { type: 'list', initial: [] },
      recordUrls: { type: 'list', initial: [] },
      videoUrls: { type: 'list', initial: [] },
    },
    {
      primary: 'entryId',
      autoInc: true,
      unique: ['id'],
    }
  );

  ctx.model.extend(
    'echo_cave_v2',
    {
      id: 'unsigned',
      channelId: 'string',
      createTime: 'timestamp',
      userId: 'string',
      originUserId: 'string',
      type: 'string',
      content: 'text',
      relatedUsers: 'list',
      drawCount: { type: 'unsigned', initial: 0 },
      picDrawCount: { type: 'unsigned', initial: 0 },
    },
    {
      primary: 'id',
      autoInc: true,
    }
  );

  ctx.model.extend(
    'echo_cave_send_failure',
    {
      id: 'unsigned',
      caveId: 'unsigned',
      channelId: 'string',
      guildId: 'string',
      platform: 'string',
      selfId: 'string',
      failTime: 'timestamp',
      errorMessage: 'string',
    },
    {
      primary: 'id',
      autoInc: true,
    }
  );

  ctx.model.extend(
    'echo_cave_user_state',
    {
      userId: 'string',
      hasCompletedForwardSelection: { type: 'boolean', initial: false },
    },
    {
      primary: 'userId',
    }
  );

  ctx.model.migrate('echo_cave_v2', {}, async (database) => {
    const existing = await database.get(ACTIVE_CAVE_TABLE, {});
    if (existing.length > 0) {
      return;
    }

    const data = (await database.get('echo_cave_v2', {})).sort((a, b) => a.id - b.id);
    for (const record of data) {
      await database.create(ACTIVE_CAVE_TABLE, toV3Record(record));
    }
  });

  // Get Cave
  ctx
    .command('cave [target:text]')
    .action(async ({ session }, target) => await getCave(ctx, session, cfg, target));

  ctx
    .command('cave.pic')
    .action(async ({ session }) => await getCave(ctx, session, cfg, undefined, true));

  ctx.command('cave.listen').action(async ({ session }) => await getCaveListByUser(ctx, session));

  ctx
    .command('cave.trace')
    .action(async ({ session }) => await getCaveListByOriginUser(ctx, session));

  // Add Cave
  ctx
    .command('cave.echo [...userIds]')
    .action(async ({ session }, ...userIds) => await addCave(ctx, session, cfg, userIds));

  // Delete Cave
  ctx
    .command('cave.drop <id:number>')
    .action(async ({ session }, id) => await deleteCave(ctx, session, cfg, id));

  ctx
    .command('cave.purge <...ids:number>')
    .action(async ({ session }, ...ids) => await deleteCaves(ctx, session, cfg, ids));

  // Search Cave
  ctx
    .command('cave.search <id>')
    .action(async ({ session }, id) => await searchCave(ctx, session, id));

  // Misc - Bind Users to Cave
  ctx
    .command('cave.bind <id:number> <...userIds>', { authority: 4 })
    .action(
      async ({ session }, id, ...userIds) => await bindUsersToCave(ctx, session, id, userIds)
    );

  // Ranking
  ctx
    .command('cave.rank [period:string]')
    .action(async ({ session }, period) => await getRanking(ctx, session, cfg, period));

  ctx
    .command(
      'cave.admin.merge <sourceChannelId:string> <targetChannelId:string> [keepSource:string]'
    )
    .action(
      async ({ session }, sourceChannelId, targetChannelId, keepSource) =>
        await mergeCavesBetweenChannels(
          ctx,
          session,
          cfg,
          sourceChannelId,
          targetChannelId,
          keepSource
        )
    );

  ctx
    .command('cave.admin.migrate-local-v2')
    .action(async ({ session }) => await migrateLegacyLocalMedia(ctx, session, cfg));

  ctx
    .command('cave.admin.migrate-s3 [keepLocal:string]')
    .action(async ({ session }, keepLocal) => await migrateMediaToS3(ctx, session, cfg, keepLocal));

  ctx
    .command('cave.admin.inspect-media [idRanges:text]')
    .action(
      async ({ session }, idRanges) =>
        await inspectMediaRefsForMigration(ctx, session, cfg, idRanges)
    );

  ctx
    .command('cave.admin.backfill-media-urls [idRanges:text]')
    .action(async ({ session }, idRanges) => await backfillCaveMediaUrls(ctx, session, cfg, idRanges));

  ctx
    .command('cave.admin.reindex')
    .action(async ({ session }) => await reindexCaveIds(ctx, session, cfg));

  ctx
    .command('cave.admin.restore-reindex <backupPath:text>')
    .action(
      async ({ session }, backupPath) => await restoreReindexBackup(ctx, session, cfg, backupPath)
    );

  registerSendFailureSummaryScheduler(ctx, cfg);
  registerAutoReindexScheduler(ctx, cfg);
}
