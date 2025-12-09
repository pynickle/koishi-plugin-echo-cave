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
}).i18n({
    'zh-CN': require('./locales/zh-CN.json'),
});
