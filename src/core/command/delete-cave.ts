import { Config } from '../../config/config';
import { EchoCave } from '../../index';
import { deleteMediaFilesFromMessage } from '../../utils/media/media-helper';
import { Context, Session } from 'koishi';

export async function deleteStoredCave(ctx: Context, cfg: Config, caveMsg: EchoCave) {
    if (cfg.deleteMediaWhenDeletingMsg) {
        await deleteMediaFilesFromMessage(ctx, caveMsg.content, cfg);
    }

    await ctx.database.remove('echo_cave_v2', caveMsg.id);
}

export async function deleteCave(ctx: Context, session: Session, cfg: Config, id: number) {
    if (!session.guildId) {
        return session.text('echo-cave.general.privateChatReminder');
    }

    if (!id) {
        return session.text('.noIdProvided');
    }

    const caves = await ctx.database.get('echo_cave_v2', id);

    if (caves.length === 0) {
        return session.text('echo-cave.general.noMsgWithId');
    }

    const caveMsg = caves[0];
    const currentUserId = session.userId;
    const user = await ctx.database.getUser(session.platform, currentUserId);
    const userAuthority = user.authority;
    const isCurrentUserAdmin = userAuthority >= 4;

    if (cfg.adminMessageProtection) {
        const caveUser = await ctx.database.getUser(session.platform, caveMsg.userId);
        const isCaveUserAdmin = caveUser.authority >= 4;

        if (isCaveUserAdmin && !isCurrentUserAdmin) {
            return session.text('.adminOnly');
        }
    }

    // Check delete permissions
    if (!isCurrentUserAdmin) {
        if (currentUserId === caveMsg.userId) {
            // Contributor check
            if (!cfg.allowContributorDelete) {
                return session.text('.contributorDeleteDenied');
            }
        } else if (currentUserId === caveMsg.originUserId) {
            // Sender check
            if (!cfg.allowSenderDelete) {
                return session.text('.senderDeleteDenied');
            }
        } else {
            // Neither contributor nor sender nor admin
            return session.text('.permissionDenied');
        }
    }

    await deleteStoredCave(ctx, cfg, caveMsg);
    return session.text('.msgDeleted', [id]);
}

export async function deleteCaves(ctx: Context, session: Session, cfg: Config, ids: number[]) {
    if (!session.guildId) {
        return session.text('echo-cave.general.privateChatReminder');
    }

    if (!ids) {
        return session.text('.noIdProvided');
    }

    const failedIds: number[] = [];
    const currentUserId = session.userId;
    const user = await ctx.database.getUser(session.platform, currentUserId);
    const userAuthority = user.authority;
    const isCurrentUserAdmin = userAuthority >= 4;

    const caves = await ctx.database.get('echo_cave_v2', ids);
    for (const cave of caves) {
        const caveMsg = cave;

        if (cfg.adminMessageProtection) {
            const caveUser = await ctx.database.getUser(session.platform, caveMsg.userId);
            const isCaveUserAdmin = caveUser.authority >= 4;

            if (isCaveUserAdmin && !isCurrentUserAdmin) {
                failedIds.push(cave.id);
                continue;
            }
        }

        // Check delete permissions
        let hasPermission = isCurrentUserAdmin;
        if (!hasPermission) {
            if (currentUserId === caveMsg.userId) {
                // Contributor check
                hasPermission = cfg.allowContributorDelete;
            } else if (currentUserId === caveMsg.originUserId) {
                // Sender check
                hasPermission = cfg.allowSenderDelete;
            }
        }

        if (!hasPermission) {
            failedIds.push(cave.id);
            continue;
        }

        await deleteStoredCave(ctx, cfg, caveMsg);
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
