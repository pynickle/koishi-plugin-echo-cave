export function createTextMsg(content: string) {
    return {
        type: 'text',
        data: {
            text: content,
        },
    };
}
