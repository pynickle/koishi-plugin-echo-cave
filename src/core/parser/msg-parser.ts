import { Config } from '../../config/config';
import { processMediaElement } from '../../utils/media/media-helper';
import { CQCode } from '@pynickle/koishi-plugin-adapter-onebot';
import { Context } from 'koishi';

export async function processMessageContent(
  ctx: Context,
  msg: CQCode[],
  cfg: Config,
  channelId: string,
  progressOptions?: Parameters<typeof processMediaElement>[4]
): Promise<CQCode[]> {
  return Promise.all(
    msg.map(
      async (element) =>
        (await processMediaElement(ctx, element, cfg, channelId, progressOptions)) as CQCode
    )
  );
}
