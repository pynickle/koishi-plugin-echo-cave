import { h, Element } from 'koishi';

export interface ParseResult {
    parsedUserIds: string[];
    error?: string;
}

export function createTextMsg(content: string) {
    return {
        type: 'text',
        data: {
            text: content,
        },
    };
}

export function parseUserIds(userIds: any[]): ParseResult {
    const parsedUserIds: string[] = [];
    for (const userId of userIds) {
        if (userId) {}
        /*
        try {
            const cqCode = (userIdStr);
            if (cqCode.type === 'at') {
                const qq = cqCode.data.qq;
                if (qq === 'all') {
                    return {
                        parsedUserIds: [],
                        error: 'invalid_all_mention',
                    };
                }
                if (qq) {
                    parsedUserIds.push(qq);
                }
            } else {
                // Check if it's a valid number
                const num = Number(userIdStr);
                if (!Number.isNaN(num)) {
                    parsedUserIds.push(String(num));
                }
            }
        } catch (e) {
            // If parsing fails, check if it's a valid number
            const num = Number(userIdStr);
            if (!Number.isNaN(num)) {
                parsedUserIds.push(String(num));
            }
        }

         */
    }
    return {
        parsedUserIds,
    };
}
