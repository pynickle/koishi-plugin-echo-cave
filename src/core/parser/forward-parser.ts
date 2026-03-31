import { getUserIdFromNickname } from '../../adapters/onebot/user';
import { Config } from '../../config/config';
import { processMediaElement } from '../../utils/media/media-helper';
import { CQCode } from '@pynickle/koishi-plugin-adapter-onebot';
import { Message } from '@pynickle/koishi-plugin-adapter-onebot/lib/types';
import { Context, Session } from 'koishi';

export async function reconstructForwardMsg(
    ctx: Context,
    session: Session,
    message: Message[],
    cfg: Config
): Promise<CQCode[]> {
    return Promise.all(
        message.map(async (msg: Message) => {
            const content = await processForwardMessageContent(ctx, session, msg, cfg);

            const senderNickname = msg.sender.nickname;

            let senderUserId = msg.sender.user_id;
            senderUserId =
                senderUserId === 1094950020
                    ? await getUserIdFromNickname(session, senderNickname, senderUserId)
                    : senderUserId;

            return {
                type: 'node',
                data: {
                    user_id: senderUserId,
                    nickname: senderNickname,
                    content,
                },
            };
        })
    );
}

async function processForwardMessageContent(
    ctx: Context,
    session: Session,
    msg: Message,
    cfg: Config
): Promise<string | CQCode[]> {
    // deal with text message
    if (typeof msg.message === 'string') {
        return msg.message;
    }

    // deal with forward message
    const firstElement = msg.message[0];
    if (firstElement?.type === 'forward') {
        return reconstructForwardMsg(ctx, session, firstElement.data.content, cfg);
    }

    // deal with normal message
    return Promise.all(
        msg.message.map(async (element) => {
            return (await processMediaElement(ctx, element, cfg, session.channelId)) as CQCode;
        })
    );
}
