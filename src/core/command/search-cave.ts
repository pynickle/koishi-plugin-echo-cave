import { ACTIVE_CAVE_TABLE } from '../cave-store';
import { checkUsersInGroup, getUserName } from '../../adapters/onebot/user';
import { getCaveMaintenanceMessage } from './admin';
import { parseUserIds } from '../../utils/msg/element-helper';
import { Context, Session, $ } from 'koishi';

export async function searchCave(ctx: Context, session: Session, userIds: string) {
    if (!session.guildId) {
        return session.text('echo-cave.general.privateChatReminder');
    }

    const maintenanceMessage = getCaveMaintenanceMessage(session);
    if (maintenanceMessage) {
        return maintenanceMessage;
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

    // Check if user belongs to the group
    const isUserInGroup = await checkUsersInGroup(ctx, session, parsedUserIds);
    if (!isUserInGroup) {
        return session.text('echo-cave.user.userNotInGroup');
    }

    const targetUserId = parsedUserIds[0];
    const { channelId } = session;

    const caves = await ctx.database.get(ACTIVE_CAVE_TABLE, {
        channelId,
    });

    const matchingCaves = caves.filter((cave) =>
        cave.relatedUsers.length === 0
            ? cave.originUserId === targetUserId
            : cave.relatedUsers.includes(targetUserId)
    );

    if (matchingCaves.length === 0) {
        const userName = await getUserName(ctx, session, targetUserId);
        return session.text('.noMatchingCaves', [userName]);
    }

    const caveIds = matchingCaves.map((cave) => cave.id).join(', ');
    const count = matchingCaves.length;

    return session.text('.searchResult', [count, caveIds]);
}
