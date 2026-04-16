import type * as OneBot from '@pynickle/koishi-plugin-adapter-onebot/lib/utils';

declare module 'koishi' {
  interface Session {
    onebot?: OneBot.Payload & OneBot.Internal;
  }
}
