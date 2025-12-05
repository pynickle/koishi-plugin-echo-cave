import { h } from 'koishi';

export interface ParseResult {
    parsedUserIds: string[];
    error?: string;
}

export function parseUserIds(userIds: string[] | string): ParseResult {
    const parsedUserIds: string[] = [];
    for (const userId of userIds) {
        // check if it's a valid number
        const num = Number(userId);
        if (!Number.isNaN(num)) {
            parsedUserIds.push(userId);
            continue;
        }

        const element = h.parse(userId);

        if (element.length === 1 && element[0].type === 'at') {
            const userId = element[0].attrs.id;
            if (userId === 'all') {
                return {
                    parsedUserIds: [],
                    error: 'invalid_all_mention',
                };
            }
            parsedUserIds.push(userId);
        }
    }
    return {
        parsedUserIds,
    };
}
