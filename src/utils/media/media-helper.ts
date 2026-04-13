import { Config } from '../../config/config';
import {
    createCaveRecord,
    getAllCaves,
    getCavesByChannel,
    getNextCavePublicId,
    removeCaveByEntryId,
    updateCaveByEntryId,
} from '../../core/cave-store';
import axios from 'axios';
import {
    CopyObjectCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Context, Session } from 'koishi';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { v4 as uuidv4 } from 'uuid';

export type MediaType = 'image' | 'video' | 'file' | 'record';

type MediaStorageMode = 'local' | 's3';
type MediaTransferMode = 'copy' | 'move';

type MaybeMediaElement = {
    type: string;
    data?: Record<string, unknown>;
    [key: string]: unknown;
};

interface MediaMutationStats {
    recordsUpdated: number;
    mediaCopied: number;
    mediaMoved: number;
    mediaUploaded: number;
    mediaDeleted: number;
    mediaSkipped: number;
    mediaFailed: number;
}

interface MediaTransferPlan {
    nextRef: string;
    commit?: () => Promise<void>;
    rollback?: () => Promise<void>;
}

interface RewriteResult {
    content: string;
    changed: boolean;
    plans: MediaTransferPlan[];
}

interface MutationState {
    transferPlans: Map<string, MediaTransferPlan>;
}

interface RewriteHooks {
    onS3Upload?: (type: MediaType, nextRef: string) => Promise<void>;
    onMigrationCommitted?: () => Promise<void>;
}

interface S3Location {
    bucket: string;
    key: string;
}

interface LoadedMedia {
    buffer: Buffer;
    contentType?: string;
    sourceKey: string;
}

interface MediaSaveProgressState {
    progressMessageIds?: string[];
}

interface MediaSaveProgressOptions {
    session: Session;
    state: MediaSaveProgressState;
}

interface CaveMediaRefs {
    id: number;
    refs: string[];
}

interface StoredCaveMediaRecord {
    entryId?: number;
    id: number;
    content: string;
}

class LRUCache<K, V> {
    private cache: Map<K, V>;
    private maxSize: number;

    constructor(maxSize: number = 100) {
        this.cache = new Map();
        this.maxSize = maxSize;
    }

    get(key: K): V | undefined {
        if (!this.cache.has(key)) return undefined;

        const value = this.cache.get(key);
        if (value === undefined) {
            return undefined;
        }

        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    set(key: K, value: V): void {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }

        this.cache.set(key, value);

        if (this.cache.size > this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) {
                this.cache.delete(firstKey);
            }
        }
    }

    delete(key: K): void {
        this.cache.delete(key);
    }

    clear(): void {
        this.cache.clear();
    }
}

const base64Cache = new LRUCache<string, string>(200);
const cleanupTimers: Map<string, NodeJS.Timeout> = new Map();
const s3ClientCache = new Map<string, S3Client>();

function createEmptyStats(): MediaMutationStats {
    return {
        recordsUpdated: 0,
        mediaCopied: 0,
        mediaMoved: 0,
        mediaUploaded: 0,
        mediaDeleted: 0,
        mediaSkipped: 0,
        mediaFailed: 0,
    };
}

function mergeStats(target: MediaMutationStats, source: MediaMutationStats) {
    target.recordsUpdated += source.recordsUpdated;
    target.mediaCopied += source.mediaCopied;
    target.mediaMoved += source.mediaMoved;
    target.mediaUploaded += source.mediaUploaded;
    target.mediaDeleted += source.mediaDeleted;
    target.mediaSkipped += source.mediaSkipped;
    target.mediaFailed += source.mediaFailed;
}

function getStorageMode(cfg: Config): MediaStorageMode {
    return cfg.mediaStorage === 's3' ? 's3' : 'local';
}

function hasS3Config(cfg: Config): boolean {
    return Boolean(cfg.s3Bucket && cfg.s3Region);
}

function getS3Client(cfg: Config): S3Client {
    if (!hasS3Config(cfg)) {
        throw new Error('S3 storage is not configured completely.');
    }

    const cacheKey = [
        cfg.s3Bucket,
        cfg.s3Region,
        cfg.s3Endpoint || '',
        cfg.s3AccessKeyId || '',
        cfg.s3SecretAccessKey || '',
        cfg.s3ForcePathStyle ? '1' : '0',
    ].join('|');

    const cached = s3ClientCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const client = new S3Client({
        region: cfg.s3Region,
        endpoint: cfg.s3Endpoint || undefined,
        forcePathStyle: cfg.s3ForcePathStyle || false,
        credentials:
            cfg.s3AccessKeyId && cfg.s3SecretAccessKey
                ? {
                      accessKeyId: cfg.s3AccessKeyId,
                      secretAccessKey: cfg.s3SecretAccessKey,
                  }
                : undefined,
    });

    s3ClientCache.set(cacheKey, client);
    return client;
}

function normalizePrefix(prefix?: string): string {
    return (prefix || '').trim().replace(/^\/+|\/+$/g, '');
}

function joinKey(...parts: string[]): string {
    return parts
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => part.replace(/^\/+|\/+$/g, ''))
        .join('/');
}

function getMediaDirName(type: MediaType): string {
    return `${type}s`;
}

function getDefaultExtension(type: MediaType): string {
    switch (type) {
        case 'image':
            return 'png';
        case 'video':
            return 'mp4';
        case 'record':
            return 'mp3';
        default:
            return 'bin';
    }
}

function getMimeTypeByExtension(ext: string, type: MediaType): string {
    const mimeTypes: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mov': 'video/quicktime',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.pdf': 'application/pdf',
    };

    return (
        mimeTypes[ext.toLowerCase()] ||
        (() => {
            switch (type) {
                case 'image':
                    return 'image/jpeg';
                case 'video':
                    return 'video/mp4';
                case 'record':
                    return 'audio/mpeg';
                default:
                    return 'application/octet-stream';
            }
        })()
    );
}

function getFileExtension(fileName: string | undefined, type: MediaType): string {
    if (!fileName) {
        return getDefaultExtension(type);
    }

    const extension = path.extname(fileName).slice(1).toLowerCase();
    return extension || getDefaultExtension(type);
}

function getLocalMediaRoot(ctx: Context): string {
    return path.join(ctx.baseDir, 'data', 'cave');
}

function getLocalMediaV2Root(ctx: Context): string {
    return path.join(getLocalMediaRoot(ctx), 'v2');
}

function getLocalMediaV2Dir(ctx: Context, channelId: string, type: MediaType): string {
    return path.join(
        getLocalMediaV2Root(ctx),
        encodeURIComponent(channelId),
        getMediaDirName(type)
    );
}

function getLegacyMediaDir(ctx: Context, type: MediaType): string {
    return path.join(getLocalMediaRoot(ctx), getMediaDirName(type));
}

function toFileUri(filePath: string): string {
    return `file:///${filePath.replace(/\\/g, '/')}`;
}

function fromFileUri(fileUri: string): string {
    return decodeURIComponent(fileUri.replace('file:///', ''));
}

function isFileUri(value: string | undefined): value is string {
    return Boolean(value && value.startsWith('file:///'));
}

function isLocalFilePath(value: string | undefined): value is string {
    if (!value) {
        return false;
    }

    return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function isHttpUrl(value: string | undefined): value is string {
    return Boolean(value && /^https?:\/\//i.test(value));
}

function isS3Uri(value: string | undefined): value is string {
    return Boolean(value && value.startsWith('s3://'));
}

function toS3Uri(location: S3Location): string {
    return `s3://${location.bucket}/${location.key}`;
}

function parseS3Uri(uri: string): S3Location | null {
    if (!isS3Uri(uri)) {
        return null;
    }

    const withoutScheme = uri.slice('s3://'.length);
    const slashIndex = withoutScheme.indexOf('/');
    if (slashIndex === -1) {
        return null;
    }

    return {
        bucket: withoutScheme.slice(0, slashIndex),
        key: withoutScheme.slice(slashIndex + 1),
    };
}

function buildS3Key(cfg: Config, channelId: string, type: MediaType, fileName: string): string {
    return joinKey(
        normalizePrefix(cfg.s3PathPrefix),
        'v2',
        encodeURIComponent(channelId),
        getMediaDirName(type),
        fileName
    );
}

function normalizePathForComparison(filePath: string): string {
    return path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
}

function isPathInsideDir(filePath: string, dirPath: string): boolean {
    const normalizedFilePath = normalizePathForComparison(filePath);
    const normalizedDirPath = normalizePathForComparison(dirPath);
    return (
        normalizedFilePath.startsWith(`${normalizedDirPath}/`) ||
        normalizedFilePath === normalizedDirPath
    );
}

function isMediaType(value: string): value is MediaType {
    return value === 'image' || value === 'video' || value === 'file' || value === 'record';
}

function getElementFileRef(
    ctx: Context,
    element: MaybeMediaElement,
    type: MediaType
): string | undefined {
    const fileValue = element.data?.file;
    const urlValue = element.data?.url;

    if (typeof fileValue === 'string') {
        if (
            isFileUri(fileValue) ||
            isS3Uri(fileValue) ||
            isHttpUrl(fileValue) ||
            isLocalFilePath(fileValue)
        ) {
            return fileValue;
        }
    }

    if (typeof urlValue === 'string') {
        if (
            isFileUri(urlValue) ||
            isS3Uri(urlValue) ||
            isHttpUrl(urlValue) ||
            isLocalFilePath(urlValue)
        ) {
            return urlValue;
        }
    }

    if (typeof fileValue === 'string' && fileValue.trim()) {
        return path.join(getLegacyMediaDir(ctx, type), fileValue);
    }

    return undefined;
}

function setElementFileRef(element: MaybeMediaElement, fileRef: string): MaybeMediaElement {
    return {
        ...element,
        data: {
            ...element.data,
            file: fileRef,
            url: undefined,
        },
    };
}

function normalizeMediaRefForComparison(fileRef: string): string | null {
    if (isFileUri(fileRef)) {
        return normalizePathForComparison(fromFileUri(fileRef));
    }

    if (isLocalFilePath(fileRef)) {
        return normalizePathForComparison(fileRef);
    }

    return null;
}

function getContentTypeFromHeaders(
    headers: Record<string, unknown>,
    type: MediaType
): string | undefined {
    const rawValue = headers['content-type'];
    const contentType = Array.isArray(rawValue)
        ? rawValue[0]
        : typeof rawValue === 'string'
          ? rawValue
          : undefined;

    if (!contentType) {
        return undefined;
    }

    if (type === 'image' && !contentType.startsWith('image/')) {
        return undefined;
    }

    if (
        type === 'video' &&
        !contentType.startsWith('video/') &&
        contentType !== 'application/octet-stream'
    ) {
        return undefined;
    }

    if (type === 'record' && !contentType.startsWith('audio/')) {
        return undefined;
    }

    return contentType;
}

async function writeLocalMedia(
    ctx: Context,
    channelId: string,
    type: MediaType,
    buffer: Buffer,
    extension: string
): Promise<string> {
    const mediaDir = getLocalMediaV2Dir(ctx, channelId, type);
    await fs.mkdir(mediaDir, { recursive: true });

    const mediaName = `${uuidv4().replace(/-/g, '')}.${extension}`;
    const fullMediaPath = path.join(mediaDir, mediaName);
    await fs.writeFile(fullMediaPath, buffer);

    return fullMediaPath;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

async function getObjectBodyBuffer(body: unknown): Promise<Buffer> {
    if (!body) {
        return Buffer.alloc(0);
    }

    if (Buffer.isBuffer(body)) {
        return body;
    }

    if (body instanceof Uint8Array) {
        return Buffer.from(body);
    }

    if (typeof body === 'string') {
        return Buffer.from(body);
    }

    if (body instanceof Readable) {
        return streamToBuffer(body);
    }

    const bodyWithTransform = body as {
        transformToByteArray?: () => Promise<Uint8Array>;
    };
    if (typeof bodyWithTransform.transformToByteArray === 'function') {
        const bytes = await bodyWithTransform.transformToByteArray();
        return Buffer.from(bytes);
    }

    const bodyWithArrayBuffer = body as {
        arrayBuffer?: () => Promise<ArrayBuffer>;
    };
    if (typeof bodyWithArrayBuffer.arrayBuffer === 'function') {
        const arrayBuffer = await bodyWithArrayBuffer.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }

    const asyncIterableBody = body as AsyncIterable<Uint8Array>;
    if (Symbol.asyncIterator in Object(body)) {
        const chunks: Buffer[] = [];
        for await (const chunk of asyncIterableBody) {
            chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    }

    throw new Error('Unsupported S3 body type.');
}

async function uploadBufferToS3(
    cfg: Config,
    channelId: string,
    type: MediaType,
    buffer: Buffer,
    extension: string,
    contentType?: string
): Promise<S3Location> {
    const client = getS3Client(cfg);
    const bucket = cfg.s3Bucket;
    if (!bucket) {
        throw new Error('S3 bucket is not configured.');
    }

    const fileName = `${uuidv4().replace(/-/g, '')}.${extension}`;
    const key = buildS3Key(cfg, channelId, type, fileName);

    await client.send(
        new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: buffer,
            ContentType: contentType,
        })
    );

    return { bucket, key };
}

async function deleteS3Object(cfg: Config, location: S3Location): Promise<void> {
    const client = getS3Client(cfg);
    await client.send(
        new DeleteObjectCommand({
            Bucket: location.bucket,
            Key: location.key,
        })
    );
}

function encodeCopySource(location: S3Location): string {
    return `${location.bucket}/${location.key.split('/').map(encodeURIComponent).join('/')}`;
}

async function copyS3Object(cfg: Config, source: S3Location, target: S3Location): Promise<void> {
    const client = getS3Client(cfg);

    await client.send(
        new CopyObjectCommand({
            Bucket: target.bucket,
            Key: target.key,
            CopySource: encodeCopySource(source),
        })
    );
}

async function loadMediaBuffer(ctx: Context, fileRef: string, cfg: Config): Promise<LoadedMedia> {
    if (isFileUri(fileRef)) {
        const filePath = fromFileUri(fileRef);
        const buffer = await fs.readFile(filePath);
        return {
            buffer,
            contentType: getMimeTypeByExtension(path.extname(filePath), 'file'),
            sourceKey: filePath,
        };
    }

    if (isLocalFilePath(fileRef)) {
        const buffer = await fs.readFile(fileRef);
        return {
            buffer,
            contentType: getMimeTypeByExtension(path.extname(fileRef), 'file'),
            sourceKey: fileRef,
        };
    }

    if (isS3Uri(fileRef)) {
        const location = parseS3Uri(fileRef);
        if (!location) {
            throw new Error(`Invalid S3 uri: ${fileRef}`);
        }

        const client = getS3Client(cfg);
        const response = await client.send(
            new GetObjectCommand({
                Bucket: location.bucket,
                Key: location.key,
            })
        );

        const buffer = await getObjectBodyBuffer(response.Body);
        return {
            buffer,
            contentType: response.ContentType,
            sourceKey: fileRef,
        };
    }

    if (isHttpUrl(fileRef)) {
        const response = await axios.get(fileRef, {
            responseType: 'arraybuffer',
            timeout: 30000,
            validateStatus: () => true,
        });

        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Failed to fetch remote media: HTTP ${response.status}`);
        }

        const contentTypeHeader = response.headers['content-type'];
        const contentType = Array.isArray(contentTypeHeader)
            ? contentTypeHeader[0]
            : contentTypeHeader;

        return {
            buffer: Buffer.from(response.data),
            contentType,
            sourceKey: fileRef,
        };
    }

    throw new Error(`Unsupported media reference: ${fileRef}`);
}

async function createPresignedGetUrl(cfg: Config, location: S3Location): Promise<string> {
    const client = getS3Client(cfg);
    return getSignedUrl(
        client,
        new GetObjectCommand({
            Bucket: location.bucket,
            Key: location.key,
        }),
        {
            expiresIn: cfg.s3PresignExpiresIn || 3600,
        }
    );
}

async function moveLocalFile(sourcePath: string, targetPath: string): Promise<void> {
    try {
        await fs.rename(sourcePath, targetPath);
    } catch (error) {
        await fs.copyFile(sourcePath, targetPath);
        await fs.unlink(sourcePath);
    }
}

async function transferLocalFileToChannel(
    ctx: Context,
    sourcePath: string,
    type: MediaType,
    targetChannelId: string,
    mode: MediaTransferMode
): Promise<string> {
    const targetDir = getLocalMediaV2Dir(ctx, targetChannelId, type);
    if (isPathInsideDir(sourcePath, targetDir)) {
        return toFileUri(sourcePath);
    }

    await fs.mkdir(targetDir, { recursive: true });

    const extension = path.extname(sourcePath).slice(1) || getDefaultExtension(type);
    const targetPath = path.join(targetDir, `${uuidv4().replace(/-/g, '')}.${extension}`);

    await fs.copyFile(sourcePath, targetPath);

    return toFileUri(targetPath);
}

async function transferS3ObjectToChannel(
    cfg: Config,
    source: S3Location,
    type: MediaType,
    targetChannelId: string,
    mode: MediaTransferMode
): Promise<string> {
    const bucket = cfg.s3Bucket;
    if (!bucket) {
        throw new Error('S3 bucket is not configured.');
    }

    const extension = path.extname(source.key).slice(1) || getDefaultExtension(type);
    const key = buildS3Key(
        cfg,
        targetChannelId,
        type,
        `${uuidv4().replace(/-/g, '')}.${extension}`
    );
    const target = { bucket, key };

    if (source.bucket === target.bucket && source.key === target.key) {
        return toS3Uri(source);
    }

    await copyS3Object(cfg, source, target);
    return toS3Uri(target);
}

function createTransferCacheKey(
    fileRef: string,
    targetChannelId: string,
    targetMode: MediaStorageMode,
    transferMode: MediaTransferMode
): string {
    return [fileRef, targetChannelId, targetMode, transferMode].join('|');
}

function createDeleteLocalFilePlan(
    filePath: string
): Pick<MediaTransferPlan, 'commit' | 'rollback'> {
    return {
        commit: async () => {
            try {
                await fs.unlink(filePath);
                base64Cache.delete(filePath);
                base64Cache.delete(toFileUri(filePath));
            } catch (error) {
                return;
            }
        },
        rollback: async () => {
            try {
                await fs.unlink(filePath);
                base64Cache.delete(filePath);
                base64Cache.delete(toFileUri(filePath));
            } catch (error) {
                return;
            }
        },
    };
}

function isLegacyLocalMediaRef(ctx: Context, fileRef: string, type: MediaType): boolean {
    if (!isFileUri(fileRef) && !isLocalFilePath(fileRef)) {
        return false;
    }

    const filePath = isFileUri(fileRef) ? fromFileUri(fileRef) : fileRef;
    return isPathInsideDir(filePath, getLegacyMediaDir(ctx, type));
}

async function transferMediaRefToChannel(
    ctx: Context,
    fileRef: string,
    type: MediaType,
    targetChannelId: string,
    targetMode: MediaStorageMode,
    transferMode: MediaTransferMode,
    cfg: Config,
    state: MutationState,
    stats: MediaMutationStats,
    hooks?: RewriteHooks
): Promise<MediaTransferPlan> {
    const cacheKey = createTransferCacheKey(fileRef, targetChannelId, targetMode, transferMode);
    const cachedPlan = state.transferPlans.get(cacheKey);
    if (cachedPlan) {
        return cachedPlan;
    }

    if (targetMode === 'local') {
        if (isFileUri(fileRef)) {
            const localSourcePath = fromFileUri(fileRef);
            const nextRef = await transferLocalFileToChannel(
                ctx,
                localSourcePath,
                type,
                targetChannelId,
                transferMode
            );

            const plan: MediaTransferPlan = {
                nextRef,
                rollback: createDeleteLocalFilePlan(fromFileUri(nextRef)).rollback,
            };

            if (transferMode === 'move') {
                plan.commit = async () => {
                    try {
                        await fs.unlink(localSourcePath);
                        base64Cache.delete(localSourcePath);
                        base64Cache.delete(fileRef);
                    } catch (error) {
                        return;
                    }
                };
                stats.mediaMoved += 1;
            } else {
                stats.mediaCopied += 1;
            }

            state.transferPlans.set(cacheKey, plan);
            return plan;
        }

        const loaded = await loadMediaBuffer(ctx, fileRef, cfg);
        const extension = path.extname(loaded.sourceKey).slice(1) || getDefaultExtension(type);
        const targetPath = await writeLocalMedia(
            ctx,
            targetChannelId,
            type,
            loaded.buffer,
            extension
        );

        const plan: MediaTransferPlan = {
            nextRef: toFileUri(targetPath),
            rollback: createDeleteLocalFilePlan(targetPath).rollback,
        };

        if (transferMode === 'move' && isS3Uri(fileRef)) {
            const source = parseS3Uri(fileRef);
            if (source) {
                plan.commit = async () => {
                    try {
                        await deleteS3Object(cfg, source);
                    } catch (error) {
                        return;
                    }
                };
                stats.mediaDeleted += 1;
            }
            stats.mediaMoved += 1;
        } else {
            stats.mediaCopied += 1;
        }

        state.transferPlans.set(cacheKey, plan);
        return plan;
    }

    if (isS3Uri(fileRef)) {
        const source = parseS3Uri(fileRef);
        if (!source) {
            throw new Error(`Invalid S3 uri: ${fileRef}`);
        }

        const nextRef = await transferS3ObjectToChannel(
            cfg,
            source,
            type,
            targetChannelId,
            transferMode
        );
        const targetLocation = parseS3Uri(nextRef);
        const plan: MediaTransferPlan = {
            nextRef,
            rollback: targetLocation
                ? async () => {
                      try {
                          await deleteS3Object(cfg, targetLocation);
                      } catch (error) {
                          return;
                      }
                  }
                : undefined,
        };

        if (transferMode === 'move') {
            plan.commit = async () => {
                try {
                    await deleteS3Object(cfg, source);
                } catch (error) {
                    return;
                }
            };
            stats.mediaMoved += 1;
            stats.mediaDeleted += 1;
        } else {
            stats.mediaCopied += 1;
        }

        state.transferPlans.set(cacheKey, plan);
        return plan;
    }

    const loaded = await loadMediaBuffer(ctx, fileRef, cfg);
    const extension = path.extname(loaded.sourceKey).slice(1) || getDefaultExtension(type);
    const location = await uploadBufferToS3(
        cfg,
        targetChannelId,
        type,
        loaded.buffer,
        extension,
        loaded.contentType
    );

    const nextRef = toS3Uri(location);
    const targetLocation = parseS3Uri(nextRef);
    const plan: MediaTransferPlan = {
        nextRef,
        rollback: targetLocation
            ? async () => {
                  try {
                      await deleteS3Object(cfg, targetLocation);
                  } catch (error) {
                      return;
                  }
              }
            : undefined,
    };

    if (transferMode === 'move' && isFileUri(fileRef)) {
        const currentPath = fromFileUri(fileRef);
        plan.commit = async () => {
            try {
                await fs.unlink(currentPath);
                base64Cache.delete(currentPath);
                base64Cache.delete(fileRef);
            } catch (error) {
                return;
            }
        };
        stats.mediaDeleted += 1;
        stats.mediaMoved += 1;
    }

    state.transferPlans.set(cacheKey, plan);
    stats.mediaUploaded += 1;
    await hooks?.onS3Upload?.(type, nextRef);
    return plan;
}

async function mutateMessageContent(
    ctx: Context,
    content: string,
    handler: (element: MaybeMediaElement, type: MediaType) => Promise<MaybeMediaElement>
): Promise<{ content: string; changed: boolean }> {
    const parsed = JSON.parse(content);
    const elements = Array.isArray(parsed) ? parsed : [parsed];

    let changed = false;

    const mutateElement = async (element: MaybeMediaElement): Promise<MaybeMediaElement> => {
        if (isMediaType(element.type)) {
            const updated = await handler(element, element.type);
            if (updated !== element) {
                changed = true;
            }
            return updated;
        }

        const contentValue = element.data?.content;
        if (element.type === 'node' && Array.isArray(contentValue)) {
            const nextContent = await Promise.all(
                contentValue.map(async (child) => mutateElement(child as MaybeMediaElement))
            );

            const hasChildChange = nextContent.some(
                (child, index) => child !== contentValue[index]
            );
            if (hasChildChange) {
                changed = true;
                return {
                    ...element,
                    data: {
                        ...element.data,
                        content: nextContent,
                    },
                };
            }
        }

        return element;
    };

    const nextElements = await Promise.all(elements.map((element) => mutateElement(element)));
    return {
        content: JSON.stringify(nextElements),
        changed,
    };
}

export async function processStoredMessageMedia(
    ctx: Context,
    content: string,
    cfg: Config,
    channelId: string,
    progressOptions?: MediaSaveProgressOptions
): Promise<string> {
    const rewritten = await mutateMessageContent(ctx, content, async (element) => {
        return (await processMediaElement(ctx, element, cfg, channelId, progressOptions)) as MaybeMediaElement;
    });

    return rewritten.content;
}

async function collectMessageMediaRefs(ctx: Context, content: string): Promise<string[]> {
    const parsed = JSON.parse(content);
    const elements = Array.isArray(parsed) ? parsed : [parsed];
    const refs: string[] = [];

    const visitElement = async (element: MaybeMediaElement): Promise<void> => {
        if (isMediaType(element.type)) {
            const fileRef = getElementFileRef(ctx, element, element.type);
            if (fileRef) {
                refs.push(fileRef);
            }
        }

        const contentValue = element.data?.content;
        if (element.type === 'node' && Array.isArray(contentValue)) {
            for (const child of contentValue) {
                await visitElement(child as MaybeMediaElement);
            }
        }
    };

    for (const element of elements) {
        await visitElement(element as MaybeMediaElement);
    }

    return refs;
}

async function collectCavesReferencingFiles(
    ctx: Context,
    targetPaths: string[]
): Promise<StoredCaveMediaRecord[]> {
    const targetSet = new Set(targetPaths.map((filePath) => normalizePathForComparison(filePath)));
    const caves = await getAllCaves(ctx);
    const matched: StoredCaveMediaRecord[] = [];

    for (const cave of caves) {
        try {
            const refs = await collectMessageMediaRefs(ctx, cave.content);
            if (
                refs.some((ref) => {
                    const normalizedRef = normalizeMediaRefForComparison(ref);
                    return normalizedRef ? targetSet.has(normalizedRef) : false;
                })
            ) {
                matched.push({
                    id: cave.id,
                    content: cave.content,
                });
            }
        } catch (error) {
            ctx.logger.warn(`Failed to inspect cave #${cave.id} during media cleanup: ${error}`);
        }
    }

    return matched;
}

async function deleteCavesForOversizedMedia(
    ctx: Context,
    caves: StoredCaveMediaRecord[],
    cfg: Config
) {
    for (const cave of caves) {
        try {
            await deleteMediaFilesFromMessage(ctx, cave.content, cfg);
            if (typeof cave.entryId !== 'number') {
                throw new Error(`missing_entry_id_for_cave_${cave.id}`);
            }

            await removeCaveByEntryId(ctx, cave.entryId);
            ctx.logger.info(`Deleted cave #${cave.id} because its media exceeded the size limit.`);
        } catch (error) {
            ctx.logger.warn(`Failed to delete cave #${cave.id} during oversized media cleanup: ${error}`);
        }
    }
}

export async function inspectCaveMediaRefs(
    ctx: Context,
    shouldInclude?: (caveId: number) => boolean
): Promise<CaveMediaRefs[]> {
    const caves = await getAllCaves(ctx);
    const results: CaveMediaRefs[] = [];

    for (const cave of caves) {
        if (shouldInclude && !shouldInclude(cave.id)) {
            continue;
        }

        try {
            const refs = await collectMessageMediaRefs(ctx, cave.content);
            if (refs.length > 0) {
                results.push({
                    id: cave.id,
                    refs,
                });
            }
        } catch (error) {
            ctx.logger.warn(`Failed to inspect media refs for cave #${cave.id}: ${error}`);
        }
    }

    return results;
}

async function rewriteMessageMediaStorage(
    ctx: Context,
    content: string,
    targetChannelId: string,
    targetMode: MediaStorageMode,
    transferMode: MediaTransferMode,
    cfg: Config,
    state: MutationState,
    stats: MediaMutationStats,
    shouldRewrite?: (fileRef: string, type: MediaType) => boolean,
    hooks?: RewriteHooks
): Promise<RewriteResult> {
    const planSet = new Set<MediaTransferPlan>();
    const rewritten = await mutateMessageContent(ctx, content, async (element, type) => {
        const currentRef = getElementFileRef(ctx, element, type);
        if (!currentRef) {
            stats.mediaSkipped += 1;
            return element;
        }

        if (shouldRewrite && !shouldRewrite(currentRef, type)) {
            stats.mediaSkipped += 1;
            return element;
        }

        try {
            const plan = await transferMediaRefToChannel(
                ctx,
                currentRef,
                type,
                targetChannelId,
                targetMode,
                transferMode,
                cfg,
                state,
                stats,
                hooks
            );
            planSet.add(plan);

            if (plan.nextRef === currentRef) {
                stats.mediaSkipped += 1;
                return element;
            }

            return setElementFileRef(element, plan.nextRef);
        } catch (error) {
            stats.mediaFailed += 1;
            ctx.logger.warn(`Failed to rewrite media reference: ${currentRef}, ${error}`);
            return element;
        }
    });

    if (rewritten.changed) {
        stats.recordsUpdated += 1;
    }

    return {
        content: rewritten.content,
        changed: rewritten.changed,
        plans: [...planSet],
    };
}

async function runTransferPlans(plans: MediaTransferPlan[], phase: 'commit' | 'rollback') {
    for (const plan of plans) {
        const action = phase === 'commit' ? plan.commit : plan.rollback;
        if (action) {
            await action();
        }
    }
}

async function walkDirectories(rootDir: string): Promise<string[]> {
    let entries: import('node:fs').Dirent[];
    try {
        entries = await fs.readdir(rootDir, { withFileTypes: true });
    } catch (error) {
        return [];
    }

    const directories = [rootDir];
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const childPath = path.join(rootDir, entry.name);
            directories.push(...(await walkDirectories(childPath)));
        }
    }

    return directories;
}

async function collectManagedMediaFiles(
    ctx: Context,
    type: MediaType
): Promise<Array<{ path: string; size: number; mtime: number }>> {
    const rootDir = getLocalMediaRoot(ctx);
    const directories = await walkDirectories(rootDir);
    const targetDirName = getMediaDirName(type);
    const fileInfos: Array<{ path: string; size: number; mtime: number }> = [];

    for (const directory of directories) {
        if (path.basename(directory) !== targetDirName) {
            continue;
        }

        let files: string[];
        try {
            files = await fs.readdir(directory);
        } catch (error) {
            continue;
        }

        for (const file of files) {
            const filePath = path.join(directory, file);
            try {
                const stats = await fs.stat(filePath);
                if (!stats.isFile()) {
                    continue;
                }

                fileInfos.push({
                    path: filePath,
                    size: stats.size,
                    mtime: stats.mtimeMs,
                });
            } catch (error) {
                continue;
            }
        }
    }

    return fileInfos;
}

export async function saveMedia(
    ctx: Context,
    mediaElement: Record<string, unknown>,
    type: MediaType,
    cfg: Config,
    channelId: string,
    progressOptions?: MediaSaveProgressOptions
) {
    const mediaUrl = typeof mediaElement.url === 'string' ? mediaElement.url : '';
    const originalMediaName =
        typeof mediaElement.file === 'string'
            ? mediaElement.file
            : `media.${getDefaultExtension(type)}`;
    const extension = getFileExtension(originalMediaName, type);

    if (!mediaUrl) {
        return mediaUrl;
    }

    try {
        await ensureMediaSaveProgress(progressOptions);

        const response = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            validateStatus: () => true,
            timeout: 30000,
        });

        if (response.status < 200 || response.status >= 300) {
            ctx.logger.warn(
                `${type.charAt(0).toUpperCase() + type.slice(1)} download failed: HTTP ${response.status}`
            );
            return mediaUrl;
        }

        const contentType = getContentTypeFromHeaders(response.headers, type);
        if (!contentType && type !== 'file' && type !== 'video') {
            ctx.logger.warn(`Invalid ${type} content-type for ${mediaUrl}`);
            return mediaUrl;
        }

        const buffer = Buffer.from(response.data);
        if (buffer.length === 0) {
            ctx.logger.warn(`Downloaded ${type} buffer is empty`);
            return mediaUrl;
        }

        if (getStorageMode(cfg) === 's3') {
            const location = await uploadBufferToS3(
                cfg,
                channelId,
                type,
                buffer,
                extension,
                contentType || getMimeTypeByExtension(`.${extension}`, type)
            );
            return toS3Uri(location);
        }

        const savedPath = await writeLocalMedia(ctx, channelId, type, buffer, extension);
        await debouncedCleanup(ctx, cfg, type, channelId);
        return savedPath;
    } catch (error) {
        ctx.logger.error(`Failed to save ${type}: ${error}`);
        return mediaUrl;
    }
}

async function debouncedCleanup(ctx: Context, cfg: Config, type: MediaType, channelId: string) {
    const key = `${channelId}:${type}`;

    if (cleanupTimers.has(key)) {
        clearTimeout(cleanupTimers.get(key));
    }

    const timer = setTimeout(async () => {
        await checkAndCleanMediaFiles(ctx, cfg, type);
        cleanupTimers.delete(key);
    }, 5000);

    cleanupTimers.set(key, timer);
}

export async function processMediaElement(
    ctx: Context,
    element: MaybeMediaElement,
    cfg: Config,
    channelId: string,
    progressOptions?: MediaSaveProgressOptions
) {
    if (isMediaType(element.type)) {
        const savedPath = await saveMedia(
            ctx,
            element.data || {},
            element.type,
            cfg,
            channelId,
            progressOptions
        );
        const fileRef =
            typeof savedPath === 'string' && isS3Uri(savedPath)
                ? savedPath
                : typeof savedPath === 'string' && isHttpUrl(savedPath)
                  ? savedPath
                  : typeof savedPath === 'string'
                    ? toFileUri(savedPath)
                    : '';

        return {
            ...element,
            data: {
                ...element.data,
                file: fileRef,
                url: undefined,
            },
        };
    }

    return element;
}

export async function messageContainsMedia(content: unknown): Promise<boolean> {
    const elements = Array.isArray(content) ? content : [content];

    const hasMedia = async (element: MaybeMediaElement): Promise<boolean> => {
        if (isMediaType(element.type)) {
            return true;
        }

        const nestedContent = element.data?.content;
        if (element.type === 'node' && Array.isArray(nestedContent)) {
            for (const child of nestedContent) {
                if (await hasMedia(child as MaybeMediaElement)) {
                    return true;
                }
            }
        }

        return false;
    };

    for (const element of elements) {
        if (await hasMedia(element as MaybeMediaElement)) {
            return true;
        }
    }

    return false;
}

async function ensureMediaSaveProgress(progressOptions?: MediaSaveProgressOptions) {
    if (!progressOptions || progressOptions.state.progressMessageIds?.length) {
        return;
    }

    const { session, state } = progressOptions;
    state.progressMessageIds = await session.send(
        session.text('commands.cave.echo.messages.mediaSaving')
    );
}

export async function resolveMediaElementForSend(
    ctx: Context,
    element: MaybeMediaElement,
    cfg: Config
): Promise<MaybeMediaElement> {
    if (isMediaType(element.type)) {
        const fileRef = getElementFileRef(ctx, element, element.type);
        if (!fileRef) {
            return element;
        }

        const isS3Media = isS3Uri(fileRef);

        if (isS3Media) {
            const location = parseS3Uri(fileRef);
            if (!location) {
                return element;
            }

            try {
                const presignedUrl = await createPresignedGetUrl(cfg, location);
                return setElementFileRef(element, presignedUrl);
            } catch (error) {
                ctx.logger.error(`Failed to generate presigned url for ${fileRef}: ${error}`);
                return element;
            }
        }

        if (!cfg.useBase64ForMedia) {
            if (isLocalFilePath(fileRef)) {
                return setElementFileRef(element, toFileUri(fileRef));
            }

            return element;
        }

        if (cfg.useBase64ForMedia) {
            const cacheKey = fileRef;
            const cached = base64Cache.get(cacheKey);
            if (cached) {
                return setElementFileRef(element, cached);
            }

            try {
                const loaded = await loadMediaBuffer(ctx, fileRef, cfg);
                const sourceExt = path.extname(loaded.sourceKey);
                const mimeType =
                    loaded.contentType || getMimeTypeByExtension(sourceExt, element.type);
                const dataUrl = `data:${mimeType};base64,${loaded.buffer.toString('base64')}`;
                base64Cache.set(cacheKey, dataUrl);
                return setElementFileRef(element, dataUrl);
            } catch (error) {
                ctx.logger.error(`Failed to convert ${element.type} to base64: ${error}`);
                return element;
            }
        }
    }

    const contentValue = element.data?.content;
    if (element.type === 'node' && Array.isArray(contentValue)) {
        return {
            ...element,
            data: {
                ...element.data,
                content: await Promise.all(
                    contentValue.map(async (contentElement) =>
                        resolveMediaElementForSend(ctx, contentElement as MaybeMediaElement, cfg)
                    )
                ),
            },
        };
    }

    return element;
}

export async function checkAndCleanMediaFiles(ctx: Context, cfg: Config, type: MediaType) {
    if (getStorageMode(cfg) !== 'local') {
        return;
    }

    if (!cfg.enableSizeLimit) {
        return;
    }

    const startTime = Date.now();
    const maxSize = (() => {
        switch (type) {
            case 'image':
                return (cfg.maxImageSize || 100) * 1024 * 1024;
            case 'video':
                return (cfg.maxVideoSize || 500) * 1024 * 1024;
            case 'file':
                return (cfg.maxFileSize || 1000) * 1024 * 1024;
            case 'record':
                return (cfg.maxRecordSize || 200) * 1024 * 1024;
        }
    })();

    try {
        const fileInfos = await collectManagedMediaFiles(ctx, type);
        if (fileInfos.length === 0) {
            return;
        }

        const totalSize = fileInfos.reduce((sum, file) => sum + file.size, 0);
        if (totalSize <= maxSize) {
            ctx.logger.debug(
                `${type} check completed in ${Date.now() - startTime}ms: no cleanup needed`
            );
            return;
        }

        fileInfos.sort((a, b) => a.mtime - b.mtime);

        let currentSize = totalSize;
        const filesToDelete: Array<{ path: string; size: number }> = [];
        for (const file of fileInfos) {
            if (currentSize <= maxSize) {
                break;
            }

            filesToDelete.push({ path: file.path, size: file.size });
            currentSize -= file.size;
        }

        if (cfg.oversizedMediaCleanupMode === 'delete-cave') {
            const cavesToDelete = await collectCavesReferencingFiles(
                ctx,
                filesToDelete.map((file) => file.path)
            );
            await deleteCavesForOversizedMedia(ctx, cavesToDelete, cfg);
        }

        for (const file of filesToDelete) {
            try {
                await fs.stat(file.path);
            } catch {
                continue;
            }

            try {
                await fs.unlink(file.path);
                base64Cache.delete(file.path);
                ctx.logger.info(`Deleted old ${type}: ${path.basename(file.path)}`);
            } catch (error) {
                ctx.logger.warn(`Failed to delete ${type}: ${file.path}, ${error}`);
            }
        }
    } catch (error) {
        ctx.logger.error(`Failed to check and clean ${type} files: ${error}`);
    }
}

export async function deleteMediaFilesFromMessage(ctx: Context, content: string, cfg: Config) {
    await mutateMessageContent(ctx, content, async (element, type) => {
        const fileRef = getElementFileRef(ctx, element, type);
        if (!fileRef) {
            return element;
        }

        try {
            if (isFileUri(fileRef)) {
                const filePath = fromFileUri(fileRef);
                await fs.unlink(filePath);
                base64Cache.delete(fileRef);
                base64Cache.delete(filePath);
            } else if (isLocalFilePath(fileRef)) {
                await fs.unlink(fileRef);
                base64Cache.delete(fileRef);
                base64Cache.delete(toFileUri(fileRef));
            } else if (isS3Uri(fileRef)) {
                const location = parseS3Uri(fileRef);
                if (location) {
                    await deleteS3Object(cfg, location);
                }
            }
        } catch (error) {
            ctx.logger.warn(`Failed to delete ${type} media: ${fileRef}, ${error}`);
        }

        return element;
    });
}

export async function migrateLocalMediaToV2(ctx: Context, cfg: Config) {
    const caves = await getAllCaves(ctx);
    const stats = createEmptyStats();
    const state: MutationState = {
        transferPlans: new Map(),
    };
    const failedRecordIds: number[] = [];

    for (const cave of caves) {
        let rewritten: RewriteResult | null = null;
        try {
            rewritten = await rewriteMessageMediaStorage(
                ctx,
                cave.content,
                cave.channelId,
                'local',
                'move',
                cfg,
                state,
                stats,
                (fileRef, type) => isLegacyLocalMediaRef(ctx, fileRef, type)
            );

            if (rewritten.content !== cave.content) {
                if (typeof cave.entryId !== 'number') {
                    throw new Error(`missing_entry_id_for_cave_${cave.id}`);
                }

                await updateCaveByEntryId(ctx, cave.entryId, { content: rewritten.content });
                await runTransferPlans(rewritten.plans, 'commit');
            }
        } catch (error) {
            if (rewritten) {
                await runTransferPlans(rewritten.plans, 'rollback');
            }
            failedRecordIds.push(cave.id);
            ctx.logger.warn(`Failed to migrate legacy local media for cave #${cave.id}: ${error}`);
        }
    }

    return {
        scannedRecords: caves.length,
        failedRecordIds,
        ...stats,
    };
}

export async function migrateLocalMediaToS3(
    ctx: Context,
    cfg: Config,
    keepLocal: boolean,
    createHooks?: (caveId: number) => RewriteHooks
) {
    const caves = await getAllCaves(ctx);
    const stats = createEmptyStats();
    const state: MutationState = {
        transferPlans: new Map(),
    };
    const failedRecordIds: number[] = [];

    for (const cave of caves) {
        let rewritten: RewriteResult | null = null;
        const hooks = createHooks?.(cave.id);
        try {
            rewritten = await rewriteMessageMediaStorage(
                ctx,
                cave.content,
                cave.channelId,
                's3',
                keepLocal ? 'copy' : 'move',
                cfg,
                state,
                stats,
                (fileRef, type) => isFileUri(fileRef) || isLegacyLocalMediaRef(ctx, fileRef, type),
                hooks
            );

            if (rewritten.content !== cave.content) {
                if (typeof cave.entryId !== 'number') {
                    throw new Error(`missing_entry_id_for_cave_${cave.id}`);
                }

                await updateCaveByEntryId(ctx, cave.entryId, { content: rewritten.content });
                await runTransferPlans(rewritten.plans, 'commit');
                await hooks?.onMigrationCommitted?.();
            }
        } catch (error) {
            if (rewritten) {
                await runTransferPlans(rewritten.plans, 'rollback');
            }
            failedRecordIds.push(cave.id);
            ctx.logger.warn(`Failed to migrate local media to S3 for cave #${cave.id}: ${error}`);
        }
    }

    return {
        scannedRecords: caves.length,
        failedRecordIds,
        ...stats,
    };
}

export async function mergeChannelCaves(
    ctx: Context,
    cfg: Config,
    sourceChannelId: string,
    targetChannelId: string,
    keepSource: boolean
) {
    const sourceCaves = await getCavesByChannel(ctx, sourceChannelId);
    const targetMode = getStorageMode(cfg);
    const transferMode: MediaTransferMode = keepSource ? 'copy' : 'move';
    const stats = createEmptyStats();
    const state: MutationState = {
        transferPlans: new Map(),
    };
    const failedRecordIds: number[] = [];

    let mergedRecords = 0;
    for (const cave of sourceCaves) {
        let rewritten: RewriteResult | null = null;
        try {
            rewritten = await rewriteMessageMediaStorage(
                ctx,
                cave.content,
                targetChannelId,
                targetMode,
                transferMode,
                cfg,
                state,
                stats
            );

            if (keepSource) {
                const nextId = await getNextCavePublicId(ctx);

                await createCaveRecord(ctx, {
                    id: nextId,
                    channelId: targetChannelId,
                    createTime: cave.createTime,
                    userId: cave.userId,
                    originUserId: cave.originUserId,
                    type: cave.type,
                    content: rewritten.content,
                    relatedUsers: cave.relatedUsers,
                    drawCount: cave.drawCount,
                });
            } else {
                if (typeof cave.entryId !== 'number') {
                    throw new Error(`missing_entry_id_for_cave_${cave.id}`);
                }

                await updateCaveByEntryId(ctx, cave.entryId, {
                    channelId: targetChannelId,
                    content: rewritten.content,
                });
            }

            await runTransferPlans(rewritten.plans, 'commit');
            mergedRecords += 1;
        } catch (error) {
            if (rewritten) {
                await runTransferPlans(rewritten.plans, 'rollback');
            }
            failedRecordIds.push(cave.id);
            ctx.logger.warn(`Failed to merge cave #${cave.id}: ${error}`);
        }
    }

    return {
        sourceCount: sourceCaves.length,
        mergedRecords,
        failedRecordIds,
        ...stats,
    };
}
