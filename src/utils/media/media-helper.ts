import { Config } from '../../config/config';
import axios from 'axios';
import { Context } from 'koishi';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

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
    const mediaName = uuidv4().replace(/-/g, ''); // 移除连字符，生成唯一文件名
    const fullMediaPath = path.join(mediaDir, `${mediaName}.${ext}`);

    ctx.logger.info(`Saving ${type} from ${mediaUrl} -> ${fullMediaPath}`);

    try {
        await fs.mkdir(mediaDir, { recursive: true });

        const res = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            validateStatus: () => true,
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
            `${type.charAt(0).toUpperCase() + type.slice(1)} saved successfully: ${fullMediaPath}`
        );

        // Check and clean media files after saving
        await checkAndCleanMediaFiles(ctx, cfg, type);

        return fullMediaPath;
    } catch (err) {
        ctx.logger.error(`Failed to save ${type}: ${err}`);
        return mediaUrl;
    }
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

// Convert file URI to base64 data URL
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

        try {
            // Read file content and convert to base64
            const buffer = await fs.readFile(filePath);
            const base64 = buffer.toString('base64');

            // Determine MIME type
            const mimeTypes: Record<string, string> = {
                image: 'image/jpeg',
                video: 'video/mp4',
                record: 'audio/mpeg',
                file: 'application/octet-stream',
            };

            const mimeType = mimeTypes[element.type] || 'application/octet-stream';
            const dataUrl = `data:${mimeType};base64,${base64}`;

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
        const files = await fs.readdir(mediaDir);
        if (files.length === 0) {
            return;
        }

        // Get file information (path, size, creation time)
        const fileInfos = await Promise.all(
            files.map(async (file) => {
                const filePath = path.join(mediaDir, file);
                const stats = await fs.stat(filePath);
                return {
                    path: filePath,
                    size: stats.size,
                    mtime: stats.mtimeMs,
                };
            })
        );

        // Calculate total size
        const totalSize = fileInfos.reduce((sum, file) => sum + file.size, 0);
        ctx.logger.info(
            `${type} directory total size: ${(totalSize / (1024 * 1024)).toFixed(2)} MB, max allowed: ${(maxSize / (1024 * 1024)).toFixed(2)} MB`
        );

        // If total size exceeds limit, delete the oldest files
        if (totalSize > maxSize) {
            ctx.logger.warn(
                `${type} directory size exceeds limit! Total: ${(totalSize / (1024 * 1024)).toFixed(2)} MB, Max: ${(maxSize / (1024 * 1024)).toFixed(2)} MB`
            );

            // Sort by modification time, oldest files first
            fileInfos.sort((a, b) => a.mtime - b.mtime);

            let currentSize = totalSize;
            let filesToDelete = [];

            // Calculate which files to delete
            for (const file of fileInfos) {
                if (currentSize <= maxSize) {
                    break;
                }
                filesToDelete.push(file);
                currentSize -= file.size;
            }

            // Delete files
            for (const file of filesToDelete) {
                await fs.unlink(file.path);
                ctx.logger.info(
                    `Deleted oldest ${type} file: ${path.basename(file.path)} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`
                );
            }

            ctx.logger.info(
                `Cleanup completed. ${type} directory new size: ${(currentSize / (1024 * 1024)).toFixed(2)} MB`
            );
        }
    } catch (err) {
        ctx.logger.error(`Failed to check and clean ${type} files: ${err}`);
    }
}

// Delete media files contained in messages
export async function deleteMediaFilesFromMessage(ctx: Context, content: string) {
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
                    ctx.logger.info(`Deleted media file: ${filePath}`);
                } catch (err) {
                    ctx.logger.warn(`Failed to delete media file: ${filePath}, error: ${err}`);
                }
            }
        } else if (element.type === 'node' && element.data?.content) {
            // Recursively process content elements in node type
            for (const contentElement of element.data.content) {
                await processElement(contentElement);
            }
        }
    }

    try {
        const elements = JSON.parse(content);
        const mediaElements = Array.isArray(elements) ? elements : [elements];

        for (const element of mediaElements) {
            await processElement(element);
        }
    } catch (err) {
        ctx.logger.error(`Failed to parse message content when deleting media: ${err}`);
    }
}
