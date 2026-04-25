import zhCN from './locales/zh-CN.json';
import { Schema } from 'koishi';

export type SendFailureHandlingMode = 'auto-delete' | 'daily-report' | 'ignore';
export type OversizedMediaCleanupMode = 'delete-cave' | 'keep-cave';
export type ForwardSpecialUserHandlingMode = 'ignore' | 'reject' | 'confirm';
export type S3UploadFailureFallbackMode = 'local' | 'original-link';

export interface Config {
  adminMessageProtection?: boolean;
  adminIds?: string[];
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
  autoBindSingleForwardUser?: boolean;
  forwardSpecialUserHandlingMode?: ForwardSpecialUserHandlingMode;
  enablePokeTrigger?: boolean;
  alpha?: number;
  mediaStorage?: 'local' | 's3';
  s3UploadFailureFallbackMode?: S3UploadFailureFallbackMode;
  s3Bucket?: string;
  s3Region?: string;
  s3Endpoint?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3ForcePathStyle?: boolean;
  s3PathPrefix?: string;
  s3PresignExpiresIn?: number;
  sendFailureHandlingMode?: SendFailureHandlingMode;
  sendFailureSummaryAdminId?: string;
  sendFailureSummaryTime?: string;
  oversizedMediaCleanupMode?: OversizedMediaCleanupMode;
  enableAutoReindex?: boolean;
  autoReindexTime?: string;
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    adminMessageProtection: Schema.boolean().default(false),
    adminIds: Schema.array(String).role('table').default([]),
    allowContributorDelete: Schema.boolean().default(true),
    allowSenderDelete: Schema.boolean().default(true),
  }).description('权限与删除'),
  Schema.object({
    rankingTopCount: Schema.number().default(10),
    alpha: Schema.number().default(0.2).min(0).max(2),
    sendAllAsForwardMsg: Schema.boolean().default(false),
    enableForwardUserSelection: Schema.boolean().default(true),
    forwardSelectTimeout: Schema.number().default(20),
    autoBindSingleForwardUser: Schema.boolean().default(false),
    forwardSpecialUserHandlingMode: Schema.union(['ignore', 'reject', 'confirm']).default('ignore'),
    enablePokeTrigger: Schema.boolean().default(true),
  }).description('消息行为'),
  Schema.object({
    deleteMediaWhenDeletingMsg: Schema.boolean().default(true),
    useBase64ForMedia: Schema.boolean().default(false),
    enableSizeLimit: Schema.boolean().default(false),
    maxImageSize: Schema.number().default(20480),
    maxVideoSize: Schema.number().default(5120),
    maxFileSize: Schema.number().default(5120),
    maxRecordSize: Schema.number().default(5120),
    oversizedMediaCleanupMode: Schema.union(['keep-cave', 'delete-cave']).default('keep-cave'),
  }).description('媒体处理'),
  Schema.object({
    mediaStorage: Schema.union(['local', 's3']).default('local'),
    s3UploadFailureFallbackMode: Schema.union(['local', 'original-link']).default('local'),
    s3Bucket: Schema.string().default(''),
    s3Region: Schema.string().default(''),
    s3Endpoint: Schema.string().default(''),
    s3AccessKeyId: Schema.string().default(''),
    s3SecretAccessKey: Schema.string().role('secret').default(''),
    s3ForcePathStyle: Schema.boolean().default(false),
    s3PathPrefix: Schema.string().default(''),
    s3PresignExpiresIn: Schema.number().default(3600).min(60).max(604800),
  }).description('媒体存储'),
  Schema.object({
    sendFailureHandlingMode: Schema.union(['auto-delete', 'daily-report', 'ignore']).default(
      'ignore'
    ),
    sendFailureSummaryAdminId: Schema.string().default(''),
    sendFailureSummaryTime: Schema.string().default('09:00'),
  }).description('发送失败处理'),
  Schema.object({
    enableAutoReindex: Schema.boolean().default(false),
    autoReindexTime: Schema.string().default('00:00'),
  }).description('自动维护'),
]).i18n({
  'zh-CN': zhCN,
});
