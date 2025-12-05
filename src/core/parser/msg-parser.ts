import { Config } from '../../config/config';
import { processMediaElement } from '../../utils/media/media-helper';
import { CQCode } from '@pynickle/koishi-plugin-adapter-onebot';
import { Context } from 'koishi';

export async function processMessageContent(
    ctx: Context,
    msg: CQCode[],
    cfg: Config
): Promise<CQCode[]> {
    return Promise.all(
        msg.map(async (element) => {
            if (element.type === 'reply') {
                return element;
            }
            return processMediaElement(ctx, element, cfg);
        })
    );
}
