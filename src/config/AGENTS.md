# CONFIG DOMAIN NOTES

## OVERVIEW

This directory owns the plugin contract: Koishi schema shape, default values, validation ranges, and config-panel i18n labels.

## WHERE TO LOOK

| Task                                       | File                 | Notes                                                              |
| ------------------------------------------ | -------------------- | ------------------------------------------------------------------ |
| Add or rename a config field               | `config.ts`          | interface and schema must change together                          |
| Change labels/help text shown in Koishi UI | `locales/zh-CN.json` | keys map to schema field names                                     |
| Adjust validation or defaults              | `config.ts`          | keep min/max/default semantics aligned with README                 |
| Change S3/send-failure options             | `config.ts`          | these branches are consumed by media/send-failure modules directly |

## LOCAL CONVENTIONS

- Keep `Config` interface and `Config` schema in lockstep; optional field names must stay identical.
- Schema is grouped by behavior (`权限与删除`, `消息行为`, `媒体处理`, `媒体存储`, `发送失败处理`); keep new fields in the right section instead of appending blindly.
- Secret-bearing values stay marked with `.role('secret')`; do not downgrade secret handling for convenience.
- Locale labels are Chinese-first and live in `locales/zh-CN.json`; add the label in the same change as the schema field.
- Numeric defaults here are user-facing product decisions, not placeholders. Preserve units exactly as documented (`MB`, seconds, `HH:mm`).

## INVARIANTS

- `adminIds` gates private maintenance commands; it is distinct from Koishi authority checks used elsewhere.
- `alpha` is bounded (`0` to `2`) because retrieval weighting depends on it staying sane.
- Media storage settings must remain compatible with `src/utils/media/media-helper.ts`; new storage fields are useless unless that module consumes them.
- Send-failure summary settings are separate from general admin IDs; `sendFailureSummaryAdminId` is intentionally not reused from `adminIds`.

## ANTI-PATTERNS

- Do not update `config.ts` without updating `locales/zh-CN.json` when the field is user-visible.
- Do not change config defaults casually to match README drift; fix docs and schema deliberately based on actual intended behavior.
- Do not add command logic here; this directory defines configuration, not runtime flow.
- Do not duplicate media/storage implementation details that belong in `src/utils/media/`.

## HANDOFF NOTES

- If a config change alters runtime behavior, check the main consumer module in the same pass (`add-cave.ts`, `get-cave.ts`, `send-failure.ts`, or `media-helper.ts`).
- Root AGENTS covers toolchain/release rules; this file is only for schema and config-i18n coupling.
