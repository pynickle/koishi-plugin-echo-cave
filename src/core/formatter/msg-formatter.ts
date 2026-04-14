import { getUserName } from '../../adapters/onebot/user';
import { Config } from '../../config/config';
import { EchoCave } from '../../index';
import { resolveMediaElementForSend } from '../../utils/media/media-helper';
import { createTextMsg } from '../../utils/msg/cqcode-helper';
import { CQCode } from '@pynickle/koishi-plugin-adapter-onebot';
import { Context, Session } from 'koishi';

export class PartialCaveSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PartialCaveSendError';
  }
}

export async function sendCaveMsg(
  ctx: Context,
  session: Session,
  caveMsg: EchoCave,
  cfg: Config
): Promise<void> {
  const { channelId } = session;
  let content: CQCode[] = JSON.parse(caveMsg.content);

  content = await Promise.all(
    content.map(async (element) => (await resolveMediaElementForSend(ctx, element, cfg)) as CQCode)
  );

  // Format necessary information
  const date = formatDate(caveMsg.createTime);
  const originName = await getUserName(ctx, session, caveMsg.originUserId);
  const userName = await getUserName(ctx, session, caveMsg.userId);

  // Format related users
  let relatedUsersFormatted = originName;
  if (caveMsg.relatedUsers && caveMsg.relatedUsers.length > 0) {
    const relatedUserNames = await Promise.all(
      caveMsg.relatedUsers.map(async (userId) => await getUserName(ctx, session, userId))
    );
    relatedUsersFormatted = relatedUserNames.join(', ');
  }

  // Template data
  const templateData = {
    id: caveMsg.id.toString(),
    date,
    originName,
    userName,
    relatedUsers: relatedUsersFormatted,
    nl: '\n',
  };

  const TEMPLATE_COUNT = 5;

  // Check if content is actually a forward message by looking for node elements
  const isActualForward = content.some((item) => item.type === 'node');
  // Determine if we should send as forward message
  const shouldSendAsForward = cfg.sendAllAsForwardMsg || caveMsg.type === 'forward';

  if (shouldSendAsForward) {
    // Get forward templates, filtering out empty ones
    const availableTemplates: string[] = [];
    for (let i = 1; i <= TEMPLATE_COUNT; i++) {
      const template = session.text(`echo-cave.templates.forward.${i}`, templateData);
      if (template.trim() !== '') {
        availableTemplates.push(template);
      }
    }

    if (availableTemplates.length === 0) {
      await session.send(session.text('echo-cave.general.noTemplatesConfigured'));
      return;
    }

    // Randomly select a template
    const chosenTemplate =
      availableTemplates[Math.floor(Math.random() * availableTemplates.length)];

    await session.onebot.sendGroupMsg(channelId, [createTextMsg(chosenTemplate)]);

    try {
      // If not an actual forward message, convert it to forward message format
      if (!isActualForward) {
        // Special handling for record type messages
        if (content[0].type === 'record') {
          await session.onebot.sendGroupMsg(channelId, content);
          return;
        }

        // Create a forward message node with the current message
        const forwardContent = [
          {
            type: 'node',
            data: {
              user_id: caveMsg.originUserId,
              nickname: originName,
              content: content,
            },
          },
        ];
        await session.onebot.sendGroupForwardMsg(channelId, forwardContent);
      } else {
        // Send as is for actual forward messages
        await session.onebot.sendGroupForwardMsg(channelId, content);
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : session.text('commands.cave.messages.sendBodyFailed');
      throw new PartialCaveSendError(message);
    }

    return;
  }

  // Get msg templates, filtering out empty ones
  const availableTemplates: Array<{ prefix: string; suffix: string }> = [];
  for (let i = 1; i <= TEMPLATE_COUNT; i++) {
    const prefix = session.text(`echo-cave.templates.msg.${i}.prefix`, templateData);
    const suffix = session.text(`echo-cave.templates.msg.${i}.suffix`, templateData);
    if (prefix.trim() !== '' && suffix.trim() !== '') {
      availableTemplates.push({ prefix, suffix });
    }
  }

  if (availableTemplates.length === 0) {
    await session.send(session.text('echo-cave.general.noTemplatesConfigured'));
    return;
  }

  // Randomly select a template
  const chosenTemplate = availableTemplates[Math.floor(Math.random() * availableTemplates.length)];

  const last = content.at(-1);
  const needsNewline = last?.type === 'text';

  content.unshift(createTextMsg(chosenTemplate.prefix + '\n'));
  content.push(createTextMsg(`${needsNewline ? '\n' : ''}${chosenTemplate.suffix}`));

  await session.onebot.sendGroupMsg(channelId, content);
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}
