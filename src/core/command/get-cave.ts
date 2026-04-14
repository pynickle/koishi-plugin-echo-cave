import { Config } from '../../config/config';
import { checkUsersInGroup } from '../../adapters/onebot/user';
import { ACTIVE_CAVE_TABLE } from '../cave-store';
import { handleCaveSendFailure } from '../send-failure';
import { EchoCave } from '../../index';
import { parseUserIds } from '../../utils/msg/element-helper';
import { getCaveMaintenanceMessage } from './admin';
import { sendCaveMsg } from '../formatter/msg-formatter';
import { Context, Session } from 'koishi';

function ensureGuildSession(session: Session): string | null {
  return session.guildId ? null : 'echo-cave.general.privateChatReminder';
}

function formatCaveIdList(caves: Pick<EchoCave, 'id'>[], separator: string = ' | '): string {
  return caves.map((cave) => cave.id).join(separator);
}

type DrawCountField = 'drawCount' | 'picDrawCount';

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

  const maintenanceMessage = getCaveMaintenanceMessage(session);
  if (maintenanceMessage) {
    return maintenanceMessage;
  }

  const caves = await ctx.database.get(
    ACTIVE_CAVE_TABLE,
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

async function incrementDrawCount(
  ctx: Context,
  caveMsg: EchoCave,
  field: DrawCountField = 'drawCount'
) {
  await ctx.database.set(
    ACTIVE_CAVE_TABLE,
    {
      entryId: caveMsg.entryId,
      channelId: caveMsg.channelId,
    },
    {
      [field]: (caveMsg[field] ?? 0) + 1,
    }
  );
}

export async function getCaveListByUser(ctx: Context, session: Session) {
  return await getCaveIdsByField(ctx, session, 'userId', '.noMsgContributed');
}

export async function getCaveListByOriginUser(ctx: Context, session: Session) {
  return await getCaveIdsByField(ctx, session, 'originUserId', '.noMsgTraced');
}

function selectRandomCave(caves: EchoCave[]) {
  return caves[Math.floor(Math.random() * caves.length)];
}

function selectWeightedRandomCave(
  caves: EchoCave[],
  alpha: number,
  field: DrawCountField = 'drawCount'
) {
  const weights = caves.map((cave) => 1 / (1 + (cave[field] ?? 0) * alpha));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  let random = Math.random() * totalWeight;
  let selectedIndex = 0;
  while (random > weights[selectedIndex]) {
    random -= weights[selectedIndex];
    selectedIndex++;
  }

  return caves[selectedIndex];
}

function isPictureMsgCave(cave: EchoCave) {
  if (cave.type !== 'msg') {
    return false;
  }

  try {
    const content = JSON.parse(cave.content) as Array<{ type?: string }>;
    return Array.isArray(content) && content.some((element) => element?.type === 'image');
  } catch {
    return false;
  }
}

async function getTargetedUserCave(
  ctx: Context,
  session: Session,
  targetUserId: string
): Promise<EchoCave | null | string> {
  const isUserInGroup = await checkUsersInGroup(ctx, session, [targetUserId]);
  if (!isUserInGroup) {
    return session.text('echo-cave.user.userNotInGroup');
  }

  const caves = await ctx.database.get(ACTIVE_CAVE_TABLE, {
    channelId: session.channelId,
  });

  const matchingCaves = caves.filter((cave) =>
    cave.relatedUsers.length === 0
      ? cave.originUserId === targetUserId
      : cave.relatedUsers.includes(targetUserId)
  );

  if (matchingCaves.length === 0) {
    return session.text('.noMatchingUserCave');
  }

  return selectRandomCave(matchingCaves);
}

export async function getCave(
  ctx: Context,
  session: Session,
  cfg: Config,
  target?: string,
  pictureOnly: boolean = false
) {
  const guildAccessError = ensureGuildSession(session);
  if (guildAccessError) {
    return session.text(guildAccessError);
  }

  const maintenanceMessage = getCaveMaintenanceMessage(session);
  if (maintenanceMessage) {
    return maintenanceMessage;
  }

  let caveMsg: EchoCave;
  let shouldIncrementDrawCount = true;
  const drawCountField: DrawCountField = pictureOnly ? 'picDrawCount' : 'drawCount';

  const { channelId } = session;

  if (pictureOnly && target) {
    return session.text('echo-cave.general.noMsgWithId');
  }

  if (!target) {
    const caves = await ctx.database.get(ACTIVE_CAVE_TABLE, {
      channelId,
    });

    const selectableCaves = pictureOnly ? caves.filter(isPictureMsgCave) : caves;

    if (selectableCaves.length === 0) {
      return session.text(pictureOnly ? '.noPicMsgInCave' : '.noMsgInCave');
    }

    const alpha = cfg.alpha ?? 0.2;
    caveMsg = selectWeightedRandomCave(selectableCaves, alpha, drawCountField);
  } else {
    const trimmedTarget = target.trim();
    const parseResult = parseUserIds(trimmedTarget);

    if (parseResult.error === 'invalid_all_mention') {
      return session.text('echo-cave.user.invalidAllMention');
    }

    const isExactNumericTarget = /^\d+$/.test(trimmedTarget);
    if (isExactNumericTarget) {
      const id = Number(trimmedTarget);
      const caves = await ctx.database.get(ACTIVE_CAVE_TABLE, {
        id,
        channelId,
      });

      if (caves.length > 0) {
        caveMsg = caves[0];

        try {
          await sendCaveMsg(ctx, session, caveMsg, cfg);
        } catch (error) {
          return await handleCaveSendFailure(ctx, session, caveMsg, cfg, error);
        }

        await incrementDrawCount(ctx, caveMsg, drawCountField);
        return;
      }
    }

    if (parseResult.parsedUserIds.length === 0) {
      return session.text('echo-cave.general.noMsgWithId');
    }

    const targetedResult = await getTargetedUserCave(ctx, session, parseResult.parsedUserIds[0]);
    if (!targetedResult) {
      return session.text('.noMatchingUserCave');
    }

    if (typeof targetedResult === 'string') {
      return targetedResult;
    }

    caveMsg = targetedResult;
    shouldIncrementDrawCount = false;
  }

  try {
    await sendCaveMsg(ctx, session, caveMsg, cfg);
  } catch (error) {
    return await handleCaveSendFailure(ctx, session, caveMsg, cfg, error);
  }

  if (shouldIncrementDrawCount) {
    await incrementDrawCount(ctx, caveMsg, drawCountField);
  }
}
