import { checkUsersInGroup } from '../../../adapters/onebot/user';
import { parseUserIds } from '../../../utils/msg/element-helper';
import { Context, Session } from 'koishi';

export async function bindUsersToCave(
    ctx: Context,
    session: Session,
    id: number,
    userIds: string[]
) {
    if (!session.guildId) {
        return session.text('echo-cave.general.privateChatReminder');
    }

    if (!id) {
        return session.text('.noIdProvided');
    }

    if (!userIds) {
        return session.text('.noUserIdProvided');
    }

    // Parse userIds to handle @mentions
    const result = parseUserIds(userIds);
    if (result.error === 'invalid_all_mention') {
        return session.text('echo-cave.user.invalidAllMention');
    }
    const parsedUserIds = result.parsedUserIds;

    if (parsedUserIds.length === 0) {
        return session.text('.noValidUserIdProvided');
    }

    // Check if cave exists
    const caves = await ctx.database.get('echo_cave', id);
    if (caves.length === 0) {
        return session.text('echo-cave.general.noMsgWithId');
    }

    // Check if all users belong to the group
    const isAllUsersInGroup = await checkUsersInGroup(ctx, session, parsedUserIds);
    if (!isAllUsersInGroup) {
        return session.text('echo-cave.user.userNotInGroup');
    }

    // Update cave with new related users (direct modification)
    await ctx.database.set('echo_cave', id, {
        relatedUsers: parsedUserIds,
    });

    return session.text('.userBoundSuccess', [id]);
}
