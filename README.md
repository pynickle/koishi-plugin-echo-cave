# 📣 koishi-plugin-echo-cave

[![npm](https://img.shields.io/npm/v/koishi-plugin-echo-cave?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-echo-cave)
[![downloads](https://img.shields.io/npm/dm/koishi-plugin-echo-cave?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-echo-cave)
[![license](https://img.shields.io/github/license/pynickle/koishi-plugin-echo-cave?style=flat-square)](LICENSE)

## 🌌 插件简介

**koishi-plugin-echo-cave** 是一个为 Koishi 机器人框架设计的群聊消息存储与回溯插件。它能够将群聊中的消息（包括普通消息和转发消息）存储到"回声洞"中，并支持随时随机或指定 ID 调取这些消息，为群聊增添更多互动乐趣和记录功能。

## ✨ 功能特性

- 📥 **消息存储**：支持存储普通消息和转发消息到数据库
- 🔍 **消息查询**：支持随机获取消息或通过 ID 精确查找
- 🗑️ **消息管理**：支持删除特定 ID 的消息（消息存储者、原始发送者或管理员）
- 👤 **个人追踪**：支持查看自己投稿的消息列表
- 🔍 **发言回溯**：支持查看自己被他人投稿的消息列表
- 🎨 **模板化展示**：消息展示时自带多种风格的外部包裹信息
- 🔒 **管理员保护**：可配置管理员消息保护
- 📏 **媒体限制**：支持配置媒体文件大小限制

## 📋 命令列表

| 命令               | 说明              | 权限要求            |
|------------------|-----------------|-----------------|
| `cave`           | 随机获取一条回声洞消息     | 所有人             |
| `cave <id>`      | 获取特定 ID 的回声洞消息  | 所有人             |
| `cave.echo`      | 将引用的消息存入回声洞     | 所有人             |
| `cave.drop <id>` | 删除特定 ID 的回声洞消息  | 消息存储者、原始发送者或管理员 |
| `cave.listen`    | 获取自己投稿的回声洞列表    | 所有人             |
| `cave.trace`     | 获取自己发言被投稿的回声洞列表 | 所有人             |

## 🚀 使用指南

### 安装插件

```bash
npm install koishi-plugin-echo-cave
```

或在插件商城中搜索 `koishi-plugin-echo-cave` 进行安装。

## 🛠️ 配置选项

| 配置项                      | 类型      | 默认值     | 说明                            |
|--------------------------|---------|---------|-------------------------------|
| `adminMessageProtection` | boolean | `false` | 开启管理员消息保护，使管理员发布的消息只能由其他管理员删除 |
| `allowContributorDelete` | boolean | `true`  | 允许消息投稿者删除自己投稿的消息              |
| `allowSenderDelete`      | boolean | `true`  | 允许原始消息发送者删除自己被投稿的消息           |
| `enableSizeLimit`        | boolean | `false` | 启用媒体文件大小限制                    |
| `maxImageSize`           | number  | `2048`  | 最大图片大小（KB）                    |
| `maxVideoSize`           | number  | `512`   | 最大视频大小（MB）                    |
| `maxFileSize`            | number  | `512`   | 最大文件大小（MB）                    |

## 📝 注意事项

- 插件只能在群聊中使用，私聊模式下无法正常工作
- 使用 `cave.echo` 命令前必须先引用一条消息
- 删除消息权限可通过配置项灵活控制，包括管理员保护、投稿者删除权限和原始发送者删除权限
- 存储的转发消息会保留原始发送者信息
- 消息展示时会自动添加精美的外部包裹信息，包括消息 ID、创建时间、原始发送者和投递者信息
- 外部包裹信息有多种随机风格，为每次消息展示带来不同的视觉体验
- 支持媒体文件大小限制，可通过配置项调整不同类型文件的大小限制
- 自动检测重复消息，避免存储重复内容
- 支持嵌套转发消息的递归处理
- 支持多语言配置，目前已提供中文语言包

## 🤝 贡献指南

欢迎提交 Issue 或 Pull Request 来帮助改进这个插件！

## 📄 许可证

本项目采用 MIT 许可证 - 详情请查看 [LICENSE](LICENSE) 文件
