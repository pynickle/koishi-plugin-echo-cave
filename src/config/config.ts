import zhCN from './locales/zh-CN.json';
import { Schema } from 'koishi';

export interface Config {
    adminMessageProtection?: boolean;
    allowContributorDelete?: boolean;
    allowSenderDelete?: boolean;
    deleteMediaWhenDeletingMsg?: boolean;
    enableSizeLimit?: boolean;
    maxImageSize?: number;
    maxVideoSize?: number;
    maxFileSize?: number;
    maxRecordSize?: number;
    useBase64ForMedia?: boolean;
    sendAllAsForwardMsg?: boolean;
    rankingTopCount?: number;
    forwardSelectTimeout?: number;
    enableForwardUserSelection?: boolean;
    alpha?: number;
}

export const Config: Schema<Config> = Schema.object({
    adminMessageProtection: Schema.boolean().default(false),
    allowContributorDelete: Schema.boolean().default(true),
    allowSenderDelete: Schema.boolean().default(true),
    deleteMediaWhenDeletingMsg: Schema.boolean().default(true),
    enableSizeLimit: Schema.boolean().default(false),
    maxImageSize: Schema.number().default(2048),
    maxVideoSize: Schema.number().default(512),
    maxFileSize: Schema.number().default(512),
    maxRecordSize: Schema.number().default(512),
    useBase64ForMedia: Schema.boolean().default(false),
    sendAllAsForwardMsg: Schema.boolean().default(false),
    rankingTopCount: Schema.number().default(10),
    forwardSelectTimeout: Schema.number().default(20),
    enableForwardUserSelection: Schema.boolean().default(true),
    alpha: Schema.number().default(0.2).min(0).max(2),
}).i18n({
    'zh-CN': zhCN,
});
