# PROJECT KNOWLEDGE BASE

**Generated:** 2026-04-14 Asia/Shanghai
**Commit:** 3cab819
**Branch:** master

## OVERVIEW
Koishi plugin for storing, retrieving, ranking, and administrating group chat "echo cave" records. Core work happens in TypeScript under `src/`, with compiled output in `lib/` and release automation via semantic-release.

## STRUCTURE
```text
./
├── src/               # source of truth; edit here, not in lib/
│   ├── index.ts       # plugin entry, table declarations, command registration
│   ├── config/        # Koishi schema + config i18n labels
│   ├── core/          # command flows, parsing, formatting, send-failure handling
│   ├── adapters/      # OneBot-specific user helpers
│   ├── utils/         # media storage + message/listener helpers
│   └── locales/       # plugin locale strings
├── lib/               # build output
├── .github/workflows/ # release-only CI
└── logs/              # runtime artifacts, not source
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Add or register a command | `src/index.ts`, `src/core/command/` | `index.ts` wires commands; `src/core/command/AGENTS.md` covers handler flow rules |
| Change shared cave storage / public-ID behavior | `src/core/cave-store.ts`, `src/core/` | `ACTIVE_CAVE_TABLE` is `echo_cave_v3`; updates/deletes should key by `entryId` |
| Change send formatting or send-failure policy | `src/core/formatter/`, `src/core/send-failure.ts` | shared send path may partially succeed before failure handling runs |
| Change plugin config | `src/config/config.ts`, `src/config/locales/zh-CN.json` | schema + config labels stay aligned |
| Change prompt/listener or mention parsing helpers | `src/utils/msg/` | `listenForUserMessage()` owns interactive prompts; `parseUserIds()` owns mention parsing |
| Debug media save/send/migration | `src/utils/media/media-helper.ts` | local/S3, cleanup, migration, URI rewriting |
| Change user/group checks | `src/adapters/onebot/user.ts` | membership and display-name resolution |
| Adjust forward/quoted message parsing | `src/core/parser/` | `forward-parser.ts` and `msg-parser.ts` split responsibilities |
| Change cave retrieval/delete semantics | `src/core/command/get-cave.ts`, `delete-cave.ts` | runtime reads/writes target `echo_cave_v3`; delete may remove media |
| Admin repair and migration flows | `src/core/command/admin.ts` | merge, local-v2 migration, S3 migration, media inspection |
| Send failure policy | `src/core/send-failure.ts` | ignore vs auto-delete vs daily-report |
| Locale text for commands | `src/locales/zh-CN.json` | command/runtime strings |

## CODE MAP
| Symbol / Module | Kind | Location | Refs | Role |
|-----------------|------|----------|------|------|
| `apply()` | entry | `src/index.ts` | root entry | declares tables and binds all commands |
| `Config` / `Config` schema | config hub | `src/config/config.ts` | 11 imports | central plugin contract |
| `ACTIVE_CAVE_TABLE` / `cave-store.ts` | storage hub | `src/core/cave-store.ts` | shared DB helpers | runtime table is `echo_cave_v3`; public IDs are separate from DB primary keys |
| `media-helper.ts` | utility hub | `src/utils/media/media-helper.ts` | 6 imports | media processing, storage, migration |
| `listenForUserMessage()` | helper flow | `src/utils/msg/message-listener.ts` | prompt/listener utility | interactive admin and selection prompts with silent cleanup |
| `user.ts` | adapter hub | `src/adapters/onebot/user.ts` | 6 imports | OneBot-specific user lookup and validation |
| `addCave()` | command flow | `src/core/command/add-cave.ts` | command entry | quote capture, media processing, user selection |
| `getCave()` | command flow | `src/core/command/get-cave.ts` | command entry | weighted random retrieval + draw count |
| `admin.ts` | command flow | `src/core/command/admin.ts` | command entry | repair/migration operations with confirmations |
| `handleCaveSendFailure()` | reliability flow | `src/core/send-failure.ts` | 2 imports | send failure persistence and reporting |

## CONVENTIONS
- Source lives in `src/`; `lib/` is generated output.
- Formatting is Oxfmt: 2-space indent, single quotes, trailing commas `es5`, JSON excluded.
- Linting is Oxlint, with `correctness` disabled and several unicorn style rules intentionally off.
- TypeScript is not strict (`strict: false`), so preserve existing runtime guards instead of assuming narrow types.
- Package manager and CI both use pnpm, even though local scripts are npm-compatible.
- Release flow expects conventional commit types from `.releaserc.json`, including custom `imp`.
- Verification is lint/build driven: there are no tests, so `pnpm run lint` and `pnpm run build` are the real safety checks.

## ANTI-PATTERNS (THIS PROJECT)
- Do not edit `lib/` directly.
- Do not document or add test commands that do not exist; this repo currently has no test suite.
- Do not assume private-chat support for normal cave flows; README and handlers enforce guild/group usage for most commands.
- Do not bypass quote requirements in `cave.echo`; the handler depends on `session.quote`.
- Do not duplicate root guidance into child AGENTS files; child files should contain only local deltas.
- Do not auto-format JSON locale files with Oxfmt assumptions; JSON is intentionally ignored.
- Do not split config schema fields from their locale labels; `src/config/config.ts` and `src/config/locales/zh-CN.json` move together.

## UNIQUE STYLES
- Command handlers return localized `session.text(...)` keys instead of inline prose.
- Admin maintenance flows favor explicit second confirmation through `listenForUserMessage()`.
- Media operations preserve storage-mode abstraction: local path, `file://`, `s3://`, and presigned URL concerns stay centralized.
- Business logic is function-first; there are no classes besides small internal helpers like the media LRU cache.

## DATA MODEL NOTES
- `echo_cave_v3` is the active runtime table for cave records (`ACTIVE_CAVE_TABLE` in `src/core/cave-store.ts`).
- `echo_cave_v2` is now a migration source; `echo_cave` remains the oldest legacy table consumed by `ctx.model.migrate(...)`.
- Public cave IDs (`id`) are user-facing; storage mutations should use `entryId` once a row has been loaded.

## COMMANDS
```bash
pnpm install
pnpm run lint
pnpm run lint:fix
pnpm run fmt
pnpm run build
pnpm run release
```

## NOTES
- `src/utils/media/media-helper.ts` is the biggest hotspot in the repo; read existing helpers before adding new storage branches.
- `src/core/` now has a local AGENTS file for shared storage/parser/formatter/send-failure rules; `src/core/command/` stays the command-flow hotspot beneath it.
- `src/utils/msg/` and `src/config/` now have local AGENTS files; prefer those before changing interactive helper flows or schema definitions.
- `logs/` exists at repo root but is not part of the plugin source model.
