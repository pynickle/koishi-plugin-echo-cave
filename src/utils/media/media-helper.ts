import { Config } from '../../config/config';
import axios from 'axios';
import { Context } from 'koishi';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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
    const mediaName = Date.now().toString();
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
            if (type === 'video' && !contentType.startsWith('video/')) {
                ctx.logger.warn(`Invalid video content-type: ${contentType}`);
                return mediaUrl;
            }
            if (type === 'record' && !contentType.startsWith('audio/')) {
                ctx.logger.warn(`Invalid record content-type: ${contentType}`);
                return mediaUrl;
            }
            // 对于 file 类型，不严格检查 content-type
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

        // 保存完成后检查并清理媒体文件
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
    }
    return element;
}

// 检查并清理媒体文件，确保不超过配置的大小限制
export async function checkAndCleanMediaFiles(
    ctx: Context,
    cfg: Config,
    type: 'image' | 'video' | 'file' | 'record'
) {
    // 如果未启用大小限制，直接返回
    if (!cfg.enableSizeLimit) {
        return;
    }

    const mediaDir = path.join(ctx.baseDir, 'data', 'cave', type + 's');
    const maxSize = (() => {
        switch (type) {
            case 'image':
                return (cfg.maxImageSize || 100) * 1024 * 1024; // 转换为字节
            case 'video':
                return (cfg.maxVideoSize || 500) * 1024 * 1024;
            case 'file':
                return (cfg.maxFileSize || 1000) * 1024 * 1024;
            case 'record':
                return (cfg.maxRecordSize || 200) * 1024 * 1024;
        }
    })();

    try {
        // 获取目录中的所有文件
        const files = await fs.readdir(mediaDir);
        if (files.length === 0) {
            return;
        }

        // 获取文件信息（路径、大小、创建时间）
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

        // 计算总大小
        const totalSize = fileInfos.reduce((sum, file) => sum + file.size, 0);
        ctx.logger.info(
            `${type} directory total size: ${(totalSize / (1024 * 1024)).toFixed(2)} MB, max allowed: ${(maxSize / (1024 * 1024)).toFixed(2)} MB`
        );

        // 如果总大小超过限制，删除最早的文件
        if (totalSize > maxSize) {
            ctx.logger.warn(
                `${type} directory size exceeds limit! Total: ${(totalSize / (1024 * 1024)).toFixed(2)} MB, Max: ${(maxSize / (1024 * 1024)).toFixed(2)} MB`
            );

            // 按修改时间排序，最早的文件排在前面
            fileInfos.sort((a, b) => a.mtime - b.mtime);

            let currentSize = totalSize;
            let filesToDelete = [];

            // 计算需要删除的文件
            for (const file of fileInfos) {
                if (currentSize <= maxSize) {
                    break;
                }
                filesToDelete.push(file);
                currentSize -= file.size;
            }

            // 删除文件
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

// 删除消息中包含的媒体文件
export async function deleteMediaFilesFromMessage(ctx: Context, content: string) {
    try {
        const elements = JSON.parse(content);
        const mediaElements = Array.isArray(elements) ? elements : [elements];

        for (const element of mediaElements) {
            if (
                element.type === 'image' ||
                element.type === 'video' ||
                element.type === 'file' ||
                element.type === 'record'
            ) {
                const fileUri = element.data?.file;
                if (fileUri && fileUri.startsWith('file:///')) {
                    // 提取本地文件路径
                    const filePath = decodeURIComponent(fileUri.replace('file:///', ''));

                    // 检查文件是否存在并删除
                    try {
                        await fs.access(filePath);
                        await fs.unlink(filePath);
                        ctx.logger.info(`Deleted media file: ${filePath}`);
                    } catch (err) {
                        ctx.logger.warn(`Failed to delete media file: ${filePath}, error: ${err}`);
                    }
                }
            }
        }
    } catch (err) {
        ctx.logger.error(`Failed to parse message content when deleting media: ${err}`);
    }
}
