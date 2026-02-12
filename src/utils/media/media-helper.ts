import { Config } from '../../config/config';
import axios from 'axios';
import { Context } from 'koishi';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

// LRU Cache for base64 conversions
class LRUCache<K, V> {
    private cache: Map<K, V>;
    private maxSize: number;

    constructor(maxSize: number = 100) {
        this.cache = new Map();
        this.maxSize = maxSize;
    }

    get(key: K): V | undefined {
        if (!this.cache.has(key)) return undefined;

        // Move to end (most recently used)
        const value = this.cache.get(key)!;
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    set(key: K, value: V): void {
        // Remove if exists
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }

        // Add to end
        this.cache.set(key, value);

        // Remove oldest if over limit
        if (this.cache.size > this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
    }

    clear(): void {
        this.cache.clear();
    }
}

// Global cache for base64 data
const base64Cache = new LRUCache<string, string>(200);

// Debounce timer for cleanup operations
const cleanupTimers: Map<string, NodeJS.Timeout> = new Map();

// Counter to reduce cleanup frequency
const saveCounters: Map<string, number> = new Map();

export async function saveMedia(
    ctx: Context,
    mediaElement: Record<string, any>,
    type: 'image' | 'video' | 'file' | 'record',
    cfg: Config
) {
    const mediaUrl: string = mediaElement.url;
    const originalMediaName: string = mediaElement.file;

    const ext = (() => {
        const i = originalMediaName.lastIndexOf('.');
        return i === -1
            ? type === 'image'
                ? 'png'
                : type === 'video'
                  ? 'mp4'
                  : type === 'record'
                    ? 'mp3'
                    : 'bin'
            : originalMediaName.slice(i + 1).toLowerCase();
    })();

    const mediaDir = path.join(ctx.baseDir, 'data', 'cave', type + 's');
    const mediaName = uuidv4().replace(/-/g, '');
    const fullMediaPath = path.join(mediaDir, `${mediaName}.${ext}`);

    ctx.logger.info(`Saving ${type} from ${mediaUrl} -> ${fullMediaPath}`);

    try {
        await fs.mkdir(mediaDir, { recursive: true });

        const res = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            validateStatus: () => true,
            timeout: 30000,
        });

        if (res.status < 200 || res.status >= 300) {
            ctx.logger.warn(
                `${type.charAt(0).toUpperCase() + type.slice(1)} download failed: HTTP ${res.status}`
            );
            return mediaUrl;
        }

        const contentType = res.headers['content-type'];
        if (contentType) {
            if (type === 'image' && !contentType.startsWith('image/')) {
                ctx.logger.warn(`Invalid image content-type: ${contentType}`);
                return mediaUrl;
            }
            if (
                type === 'video' &&
                !contentType.startsWith('video/') &&
                contentType !== 'application/octet-stream'
            ) {
                ctx.logger.warn(`Invalid video content-type: ${contentType}`);
                return mediaUrl;
            }
            if (type === 'record' && !contentType.startsWith('audio/')) {
                ctx.logger.warn(`Invalid record content-type: ${contentType}`);
                return mediaUrl;
            }
            // For file type, don't strictly check content-type
        }

        const buffer = Buffer.from(res.data);
        if (!buffer || buffer.length === 0) {
            ctx.logger.warn(`Downloaded ${type} buffer is empty`);
            return mediaUrl;
        }

        await fs.writeFile(fullMediaPath, buffer);

        ctx.logger.info(
            `${type.charAt(0).toUpperCase() + type.slice(1)} saved successfully: ${fullMediaPath} (${(buffer.length / (1024 * 1024)).toFixed(2)} MB)`
        );

        await debouncedCleanup(ctx, cfg, type);

        return fullMediaPath;
    } catch (err) {
        ctx.logger.error(`Failed to save ${type}: ${err}`);
        return mediaUrl;
    }
}

async function debouncedCleanup(
    ctx: Context,
    cfg: Config,
    type: 'image' | 'video' | 'file' | 'record'
) {
    const key = type;

    if (cleanupTimers.has(key)) {
        clearTimeout(cleanupTimers.get(key)!);
    }

    const timer = setTimeout(async () => {
        await checkAndCleanMediaFiles(ctx, cfg, type);
        cleanupTimers.delete(key);
    }, 5000);

    cleanupTimers.set(key, timer);
}

export async function processMediaElement(ctx: Context, element: any, cfg: Config) {
    if (
        element.type === 'image' ||
        element.type === 'video' ||
        element.type === 'file' ||
        element.type === 'record'
    ) {
        const savedPath = await saveMedia(
            ctx,
            element.data,
            element.type as 'image' | 'video' | 'file' | 'record',
            cfg
        );

        // Convert savedPath to file URI
        const fileUri = `file:///${savedPath.replace(/\\/g, '/')}`;

        return {
            ...element,
            data: {
                ...element.data,
                file: fileUri,
                // Remove the url field
                url: undefined,
            },
        };
    }
    return element;
}

// Convert file URI to base64 data URL with caching
export async function convertFileUriToBase64(ctx: Context, element: any): Promise<any> {
    if (
        element.type === 'image' ||
        element.type === 'video' ||
        element.type === 'file' ||
        element.type === 'record'
    ) {
        // Extract file path from file URI
        const fileUri = element.data.file;
        const filePath = decodeURIComponent(fileUri.replace('file:///', ''));

        // 检查缓存
        const cachedData = base64Cache.get(filePath);
        if (cachedData) {
            ctx.logger.debug(`Using cached base64 for: ${filePath}`);
            return {
                ...element,
                data: {
                    ...element.data,
                    file: cachedData,
                },
            };
        }

        try {
            const startTime = Date.now();

            // Read file content and convert to base64
            const buffer = await fs.readFile(filePath);
            const base64 = buffer.toString('base64');

            // Determine MIME type
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes: Record<string, string> = {
                // Images
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.png': 'image/png',
                '.gif': 'image/gif',
                '.webp': 'image/webp',
                // Videos
                '.mp4': 'video/mp4',
                '.webm': 'video/webm',
                '.mov': 'video/quicktime',
                // Audio
                '.mp3': 'audio/mpeg',
                '.wav': 'audio/wav',
                '.ogg': 'audio/ogg',
            };

            const mimeType =
                mimeTypes[ext] ||
                (() => {
                    switch (element.type) {
                        case 'image':
                            return 'image/jpeg';
                        case 'video':
                            return 'video/mp4';
                        case 'record':
                            return 'audio/mpeg';
                        default:
                            return 'application/octet-stream';
                    }
                })();

            const dataUrl = `data:${mimeType};base64,${base64}`;

            base64Cache.set(filePath, dataUrl);

            const duration = Date.now() - startTime;
            ctx.logger.debug(
                `Converted ${element.type} to base64: ${filePath} (${(buffer.length / (1024 * 1024)).toFixed(2)} MB, ${duration}ms)`
            );

            return {
                ...element,
                data: {
                    ...element.data,
                    file: dataUrl,
                },
            };
        } catch (err) {
            ctx.logger.error(`Failed to convert ${element.type} to base64: ${err}`);
            return element; // Return original element if conversion fails
        }
    } else if (element.type === 'node') {
        // Handle node type, which contains an array of content elements
        const processedContent = await Promise.all(
            element.data.content.map(async (contentElement: any) => {
                // Recursively convert any media elements in the content array
                return await convertFileUriToBase64(ctx, contentElement);
            })
        );

        return {
            ...element,
            data: {
                ...element.data,
                content: processedContent,
            },
        };
    }
    return element;
}

// Check and clean up media files to ensure they don't exceed the configured size limit
export async function checkAndCleanMediaFiles(
    ctx: Context,
    cfg: Config,
    type: 'image' | 'video' | 'file' | 'record'
) {
    // If size limit is not enabled, return directly
    if (!cfg.enableSizeLimit) {
        return;
    }

    const startTime = Date.now();
    const mediaDir = path.join(ctx.baseDir, 'data', 'cave', type + 's');
    const maxSize = (() => {
        switch (type) {
            case 'image':
                return (cfg.maxImageSize || 100) * 1024 * 1024; // Convert to bytes
            case 'video':
                return (cfg.maxVideoSize || 500) * 1024 * 1024;
            case 'file':
                return (cfg.maxFileSize || 1000) * 1024 * 1024;
            case 'record':
                return (cfg.maxRecordSize || 200) * 1024 * 1024;
        }
    })();

    try {
        // Get all files in the directory
        let files: string[];
        try {
            files = await fs.readdir(mediaDir);
        } catch (err) {
            return;
        }

        if (files.length === 0) {
            return;
        }

        // Get file information (path, size, creation time)
        const fileInfos = await Promise.all(
            files.map(async (file) => {
                const filePath = path.join(mediaDir, file);
                try {
                    const stats = await fs.stat(filePath);
                    return {
                        path: filePath,
                        size: stats.size,
                        mtime: stats.mtimeMs,
                    };
                } catch (err) {
                    return null;
                }
            })
        );

        const validFileInfos = fileInfos.filter(
            (info): info is NonNullable<typeof info> => info !== null
        );

        if (validFileInfos.length === 0) {
            return;
        }

        // Calculate total size
        const totalSize = validFileInfos.reduce((sum, file) => sum + file.size, 0);

        const totalSizeMB = (totalSize / (1024 * 1024)).toFixed(2);
        const maxSizeMB = (maxSize / (1024 * 1024)).toFixed(2);

        ctx.logger.debug(
            `${type} directory: ${validFileInfos.length} files, ${totalSizeMB} MB / ${maxSizeMB} MB`
        );

        // If total size exceeds limit, delete the oldest files
        if (totalSize > maxSize) {
            ctx.logger.warn(
                `${type} directory size exceeds limit! Total: ${totalSizeMB} MB, Max: ${maxSizeMB} MB`
            );

            // Sort by modification time, oldest files first
            validFileInfos.sort((a, b) => a.mtime - b.mtime);

            let currentSize = totalSize;
            const filesToDelete: typeof validFileInfos = [];

            // Calculate which files to delete
            for (const file of validFileInfos) {
                if (currentSize <= maxSize) {
                    break;
                }
                filesToDelete.push(file);
                currentSize -= file.size;
            }

            const deleteResults = await Promise.allSettled(
                filesToDelete.map(async (file) => {
                    await fs.unlink(file.path);

                    base64Cache.get(file.path);

                    return file;
                })
            );

            let deletedCount = 0;
            let deletedSize = 0;

            deleteResults.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    deletedCount++;
                    deletedSize += filesToDelete[index].size;
                    ctx.logger.info(
                        `Deleted old ${type}: ${path.basename(filesToDelete[index].path)} (${(filesToDelete[index].size / (1024 * 1024)).toFixed(2)} MB)`
                    );
                } else {
                    ctx.logger.warn(
                        `Failed to delete ${type}: ${path.basename(filesToDelete[index].path)} - ${result.reason}`
                    );
                }
            });

            const duration = Date.now() - startTime;
            ctx.logger.info(
                `Cleanup completed in ${duration}ms: deleted ${deletedCount}/${filesToDelete.length} files (${(deletedSize / (1024 * 1024)).toFixed(2)} MB), new size: ${((totalSize - deletedSize) / (1024 * 1024)).toFixed(2)} MB`
            );
        } else {
            const duration = Date.now() - startTime;
            ctx.logger.debug(`${type} check completed in ${duration}ms: no cleanup needed`);
        }
    } catch (err) {
        ctx.logger.error(`Failed to check and clean ${type} files: ${err}`);
    }
}

// Delete media files contained in messages
export async function deleteMediaFilesFromMessage(ctx: Context, content: string) {
    const deletedFiles: string[] = [];
    const failedFiles: string[] = [];

    async function processElement(element: any) {
        if (
            element.type === 'image' ||
            element.type === 'video' ||
            element.type === 'file' ||
            element.type === 'record'
        ) {
            const fileUri = element.data?.file;
            if (fileUri && fileUri.startsWith('file:///')) {
                // Extract local file path
                const filePath = decodeURIComponent(fileUri.replace('file:///', ''));

                // Check if file exists and delete it
                try {
                    await fs.access(filePath);
                    await fs.unlink(filePath);

                    base64Cache.get(filePath);

                    deletedFiles.push(filePath);
                    ctx.logger.debug(`Deleted media file: ${filePath}`);
                } catch (err) {
                    failedFiles.push(filePath);
                    ctx.logger.warn(`Failed to delete media file: ${filePath}, error: ${err}`);
                }
            }
        } else if (element.type === 'node' && element.data?.content) {
            // Recursively process content elements in node type
            await Promise.all(
                element.data.content.map((contentElement: any) => processElement(contentElement))
            );
        }
    }

    try {
        const elements = JSON.parse(content);
        const mediaElements = Array.isArray(elements) ? elements : [elements];

        await Promise.all(mediaElements.map((element) => processElement(element)));

        if (deletedFiles.length > 0) {
            ctx.logger.info(`Deleted ${deletedFiles.length} media file(s) from message`);
        }
        if (failedFiles.length > 0) {
            ctx.logger.warn(`Failed to delete ${failedFiles.length} media file(s)`);
        }
    } catch (err) {
        ctx.logger.error(`Failed to parse message content when deleting media: ${err}`);
    }
}
