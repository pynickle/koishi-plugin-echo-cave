import { Config } from '../../config/config';
import { EchoCave } from '../../index';
import { deleteMediaFilesFromMessage } from '../../utils/media/media-helper';
import { Context, Session } from 'koishi';

type DeletePermissionFailure =
    | 'echo-cave.general.privateChatReminder'
    | '.adminOnly'
    | '.contributorDeleteDenied'
    | '.senderDeleteDenied'
    | '.permissionDenied';

interface DeleteActor {
    currentUserId: string;
    isCurrentUserAdmin: boolean;
}

function ensureGuildSession(session: Session): DeletePermissionFailure | null {
    return session.guildId ? null : 'echo-cave.general.privateChatReminder';
}

async function getDeleteActor(ctx: Context, session: Session): Promise<DeleteActor> {
    const user = await ctx.database.getUser(session.platform, session.userId);
    return {
        currentUserId: session.userId,
        isCurrentUserAdmin: (user?.authority || 0) >= 4,
    };
}

async function getDeletePermissionFailure(
    ctx: Context,
    session: Session,
    cfg: Config,
    caveMsg: EchoCave,
    actor: DeleteActor
): Promise<DeletePermissionFailure | null> {
    if (cfg.adminMessageProtection) {
        const caveUser = await ctx.database.getUser(session.platform, caveMsg.userId);
        const isCaveUserAdmin = (caveUser?.authority || 0) >= 4;

        if (isCaveUserAdmin && !actor.isCurrentUserAdmin) {
            return '.adminOnly';
        }
    }

    if (actor.isCurrentUserAdmin) {
        return null;
    }

    if (actor.currentUserId === caveMsg.userId) {
        return cfg.allowContributorDelete ? null : '.contributorDeleteDenied';
    }

    if (actor.currentUserId === caveMsg.originUserId) {
        return cfg.allowSenderDelete ? null : '.senderDeleteDenied';
    }

    return '.permissionDenied';
}

export async function deleteStoredCave(ctx: Context, cfg: Config, caveMsg: EchoCave) {
    if (cfg.deleteMediaWhenDeletingMsg) {
        await deleteMediaFilesFromMessage(ctx, caveMsg.content, cfg);
    }

    await ctx.database.remove('echo_cave_v2', caveMsg.id);
}

export async function deleteCave(ctx: Context, session: Session, cfg: Config, id: number) {
    const guildAccessError = ensureGuildSession(session);
    if (guildAccessError) {
        return session.text(guildAccessError);
    }

    if (!id) {
        return session.text('.noIdProvided');
    }

    const caves = await ctx.database.get('echo_cave_v2', id);

    if (caves.length === 0) {
        return session.text('echo-cave.general.noMsgWithId');
    }

    const caveMsg = caves[0];
    const actor = await getDeleteActor(ctx, session);
    const permissionFailure = await getDeletePermissionFailure(ctx, session, cfg, caveMsg, actor);
    if (permissionFailure) {
        return session.text(permissionFailure);
    }

    await deleteStoredCave(ctx, cfg, caveMsg);
    return session.text('.msgDeleted', [id]);
}

export async function deleteCaves(ctx: Context, session: Session, cfg: Config, ids: number[]) {
    const guildAccessError = ensureGuildSession(session);
    if (guildAccessError) {
        return session.text(guildAccessError);
    }

    if (!ids || ids.length === 0) {
        return session.text('.noIdProvided');
    }

    const failedIds: number[] = [];
    const actor = await getDeleteActor(ctx, session);

    const caves = await ctx.database.get('echo_cave_v2', ids);
    for (const cave of caves) {
        const permissionFailure = await getDeletePermissionFailure(ctx, session, cfg, cave, actor);
        if (permissionFailure) {
            failedIds.push(cave.id);
            continue;
        }

        await deleteStoredCave(ctx, cfg, cave);
    }

    const foundIds = new Set(caves.map((r) => r.id));
    const missingIds = ids.filter((id) => !foundIds.has(id));
    failedIds.push(...missingIds);

    if (failedIds.length === 0) {
        return session.text('.msgDeletedMultiple', [ids.length]);
    } else if (failedIds.length === ids.length) {
        return session.text('.msgDeleteFailedAll', [failedIds.join(', ')]);
    } else {
        return session.text('.msgDeletePartial', [failedIds.join(', ')]);
    }
}
