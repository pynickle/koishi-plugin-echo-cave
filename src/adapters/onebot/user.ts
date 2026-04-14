import { Context, Session } from 'koishi';

export async function getUserIdFromNickname(
  session: Session,
  nickname: string,
  userId: number
): Promise<number> {
  const memberInfos = await session.onebot.getGroupMemberList(session.channelId);

  // Find all items with exact nickname match
  const matches = memberInfos.filter((m) => m.nickname === nickname);

  // If there's exactly one match, return that member's user_id
  if (matches.length === 1) {
    return matches[0].user_id;
  }

  // Otherwise (no match or multiple matches), return the original userId
  return userId;
}

export async function getUserName(ctx: Context, session: Session, userId: string): Promise<string> {
  try {
    const memberInfo = await session.onebot.getGroupMemberInfo(session.channelId, userId);
    return memberInfo.card || memberInfo.nickname || userId;
  } catch (error) {
    ctx.logger.warn(`Failed to get group member info (userId: ${userId}):`, error);
    return userId;
  }
}

/**
 * Check if users belong to the specified group
 */
export async function checkUsersInGroup(
  ctx: Context,
  session: Session,
  userIds: string[]
): Promise<boolean> {
  try {
    const groupMembers = await session.onebot.getGroupMemberList(session.channelId);
    const memberIds = groupMembers.map((member) => member.user_id.toString());

    // Check if all user IDs are in the group
    return userIds.every((userId) => memberIds.includes(userId));
  } catch (error) {
    ctx.logger.warn(`Failed to get group member list:`, error);
    return false;
  }
}
