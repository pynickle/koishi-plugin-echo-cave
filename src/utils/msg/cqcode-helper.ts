export function createTextMsg(content: string) {
  return {
    type: 'text',
    data: {
      text: content,
    },
  };
}

export function createTextMsgNode(userId: string, nickname: string, content: string) {
  return {
    type: 'node',
    data: {
      user_id: userId,
      nickname: nickname,
      content: content,
    },
  };
}
