import { Context } from 'koishi';
import { EchoCave } from '../index';

export const ACTIVE_CAVE_TABLE = 'echo_cave_v3' as const;

export interface CaveSnapshotRecord {
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
}

export interface CaveBackupRecord extends CaveSnapshotRecord {
  entryId?: number;
}

export function toCaveSnapshotRecord<T extends CaveSnapshotRecord>(cave: T): CaveSnapshotRecord {
  return {
    id: cave.id,
    channelId: cave.channelId,
    createTime: new Date(cave.createTime),
    userId: cave.userId,
    originUserId: cave.originUserId,
    type: cave.type,
    content: cave.content,
    relatedUsers: [...cave.relatedUsers],
    drawCount: cave.drawCount,
    picDrawCount: cave.picDrawCount ?? 0,
  };
}

export function toCaveBackupRecord(cave: EchoCave | CaveSnapshotRecord): CaveBackupRecord {
  return {
    entryId: 'entryId' in cave ? cave.entryId : undefined,
    ...toCaveSnapshotRecord(cave),
  };
}

export async function getNextCavePublicId(ctx: Context) {
  const caves = await ctx.database.get(ACTIVE_CAVE_TABLE, {}, ['id']);
  return caves.reduce((maxId, cave) => Math.max(maxId, cave.id), 0) + 1;
}

export async function getCaveByPublicId(ctx: Context, id: number, channelId?: string) {
  const query = channelId ? { id, channelId } : { id };
  const caves = await ctx.database.get(ACTIVE_CAVE_TABLE, query);
  return caves[0] || null;
}

export async function getCavesByPublicIds(ctx: Context, ids: number[]) {
  if (ids.length === 0) {
    return [];
  }

  const idSet = new Set(ids);
  const caves = await ctx.database.get(ACTIVE_CAVE_TABLE, {});
  return caves.filter((cave) => idSet.has(cave.id));
}

export async function removeCaveByEntryId(ctx: Context, entryId: number) {
  await ctx.database.remove(ACTIVE_CAVE_TABLE, entryId);
}

export async function createCaveRecord(ctx: Context, cave: CaveSnapshotRecord) {
  return await ctx.database.create(ACTIVE_CAVE_TABLE, {
    id: cave.id,
    channelId: cave.channelId,
    createTime: new Date(cave.createTime),
    userId: cave.userId,
    originUserId: cave.originUserId,
    type: cave.type,
    content: cave.content,
    relatedUsers: [...cave.relatedUsers],
    drawCount: cave.drawCount,
    picDrawCount: cave.picDrawCount ?? 0,
  });
}

export async function updateCaveByEntryId(
  ctx: Context,
  entryId: number,
  data: Partial<Omit<CaveSnapshotRecord, 'id'>> & { id?: number }
) {
  await ctx.database.set(ACTIVE_CAVE_TABLE, { entryId }, data);
}

export async function getAllCaves(ctx: Context) {
  return await ctx.database.get(ACTIVE_CAVE_TABLE, {});
}

export async function getCavesByChannel(ctx: Context, channelId: string) {
  return await ctx.database.get(ACTIVE_CAVE_TABLE, { channelId });
}
