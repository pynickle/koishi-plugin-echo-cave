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
- 📊 **排行榜功能**：支持查看不同时间段内的回声洞排行榜
- 🎨 **模板化展示**：消息展示时自带多种风格的外部包裹信息
- 🔒 **管理员保护**：可配置管理员消息保护
- 📏 **媒体限制**：支持配置媒体文件大小限制
- 👥 **转发消息用户选择**：支持从转发消息中选择相关用户进行绑定
- 🎯 **按人随机抽取**：支持通过 `@用户` 或用户 ID 定向随机抽取该用户相关的回声洞，且不影响全局抽取权重
- 🧭 **转发绑定体验优化**：转发消息关联用户的详细输入指南仅在用户首次成功完成选择前显示，选择完成或超时后会尝试撤回提示消息
- 🤖 **特殊转发用户处理**：可配置在检测到转发记录中包含特殊用户 `1094950020` 时直接拒绝存储，或要求二次确认后再存储
- 🛠️ **回声洞 ID 重排**：提供管理员维护命令，可在写入备份后安全重排现有回声洞 ID
- ⚖️ **加权随机抽取**：根据消息被抽取次数动态调整抽取概率，被抽取次数越多，概率越低。使用公式：
  ```
  权重 = 1 / (1 + drawCount * α)
  概率 = 权重 / 总权重
  ```
  其中，`drawCount` 为消息被抽取次数，`α` 为调整因子（可配置，默认0.2）

## 📋 命令列表

| 命令                            | 说明               | 权限要求            |
|-------------------------------|------------------|-----------------|
| `cave`                        | 随机获取一条回声洞消息      | 所有人             |
| `cave <id>`                   | 获取特定 ID 的回声洞消息   | 所有人             |
| `cave <@用户/用户ID>`          | 随机获取与该用户相关的一条回声洞消息（不计入抽取次数） | 所有人 |
| `cave.echo [...userIds]`      | 将引用的消息存入回声洞      | 所有人             |
| `cave.drop <id>`              | 删除特定 ID 的回声洞消息   | 消息存储者、原始发送者或管理员 |
| `cave.listen`                 | 获取自己投稿的回声洞列表     | 所有人             |
| `cave.trace`                  | 获取自己发言被投稿的回声洞列表  | 所有人             |
| `cave.purge <...ids>`         | 批量删除多个 ID 的回声洞消息 | 消息存储者、原始发送者或管理员 |
| `cave.search <id>`            | 搜索特定 ID 的回声洞消息   | 所有人             |
| `cave.bind <id> <...userIds>` | 将用户绑定到特定 ID 的回声洞 | 所有人             |
| `cave.rank [period]`          | 查看回声洞排行榜，支持多种时间段 | 所有人             |
| `cave.admin.reindex`          | 安全重排所有现有回声洞 ID，并先写入备份 | 管理员（私聊） |

## 🚀 使用指南

### 安装插件

```bash
npm install koishi-plugin-echo-cave
```

或在插件商城中搜索 `koishi-plugin-echo-cave` 进行安装。

## 🛠️ 配置选项

| 配置项                          | 类型      | 默认值     | 说明                            |
|------------------------------|---------|---------|-------------------------------|
| `adminMessageProtection`     | boolean | `false` | 开启管理员消息保护，使管理员发布的消息只能由其他管理员删除 |
| `allowContributorDelete`     | boolean | `true`  | 允许消息投稿者删除自己投稿的消息              |
| `allowSenderDelete`          | boolean | `true`  | 允许原始消息发送者删除自己被投稿的消息           |
| `deleteMediaWhenDeletingMsg` | boolean | `true`  | 删除消息时是否同时删除媒体文件               |
| `enableSizeLimit`            | boolean | `false` | 启用媒体文件大小限制                    |
| `maxImageSize`               | number  | `2048`  | 最大图片大小（KB）                    |
| `maxVideoSize`               | number  | `512`   | 最大视频大小（KB）                    |
| `maxFileSize`                | number  | `512`   | 最大文件大小（KB）                    |
| `maxRecordSize`              | number  | `512`   | 最大录音大小（KB）                    |
| `useBase64ForMedia`          | boolean | `false` | 是否使用 Base64 编码发送媒体文件          |
| `sendAllAsForwardMsg`        | boolean | `false` | 是否将所有消息以转发消息形式发送              |
| `rankingTopCount`            | number  | `10`    | 排行榜显示的用户数量                    |
| `forwardSelectTimeout`       | number  | `20`    | 转发消息用户选择超时时间（秒）              |
| `enableForwardUserSelection` | boolean | `true`  | 启用转发消息用户选择功能                  |
| `autoBindSingleForwardUser`  | boolean | `false` | 转发消息仅识别到一个用户时，是否默认自动绑定该用户 |
| `forwardSpecialUserHandlingMode` | `'ignore' \| 'reject' \| 'confirm'` | `'ignore'` | 检测到转发消息中包含用户 `1094950020` 时的处理方式：忽略、提醒后拒绝存储、或提醒并要求确认后再存储 |
| `alpha`                      | number  | `0.2`   | 加权随机抽取的调整因子，控制抽取次数对概率的影响程度，值越大影响越明显 |

## 📝 注意事项

- 插件仅在群聊中可用，私聊模式下无法正常工作
- 使用 `cave.echo` 命令前必须先引用一条消息
- 使用 `cave @用户`、`cave <用户ID>` 可定向随机抽取该用户相关的回声洞，这类抽取不会增加 `drawCount`
- 删除消息权限可通过配置项灵活控制
- 存储的消息会保留原始发送者信息
- 支持媒体文件大小限制，可通过配置项调整
- 自动检测并避免存储重复消息
- 支持嵌套转发消息的递归处理
- 转发消息可选择相关用户进行绑定，超时后自动跳过
- 转发消息关联用户的详细示例只会在用户首次成功完成一次选择前显示；如果只是超时，则下次仍会显示
- 可通过配置项禁用转发消息用户选择、开启单用户自动绑定，或配置检测到特殊用户 `1094950020` 时的处理模式
- `cave.admin.reindex` 会先在 `logs/` 下写入备份文件，再执行 ID 重排；建议仅在单实例维护时段执行
- 如果重排前备份写入失败，命令会直接终止，不会开始改写数据库

## 🤝 贡献指南

欢迎提交 Issue 或 Pull Request 来帮助改进这个插件！

## 📄 许可证

本项目采用 MIT 许可证 - 详情请查看 [LICENSE](LICENSE) 文件
