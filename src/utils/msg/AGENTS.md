# MESSAGE HELPER NOTES

## OVERVIEW

This directory owns small but shared message utilities: interactive listeners, silent cleanup helpers, CQ node/text builders, and mention parsing.

## WHERE TO LOOK

| Task                                      | File                  | Notes                                                              |
| ----------------------------------------- | --------------------- | ------------------------------------------------------------------ |
| Change prompt listening / timeout cleanup | `message-listener.ts` | shared interactive flow for admin confirmations and user selection |
| Normalize returned message IDs            | `message-listener.ts` | send/delete helpers expect string arrays                           |
| Change mention or user-id parsing         | `element-helper.ts`   | `parseUserIds()` rejects `@all` explicitly                         |
| Build OneBot text/node payloads           | `cqcode-helper.ts`    | thin helpers used by formatter/send flows                          |

## LOCAL CONVENTIONS

- Keep these helpers thin and reusable; command modules should compose them rather than reimplementing prompt listeners or mention parsing.
- Listener helpers identify the same speaker by `userId`, `channelId`, `guildId`, and `platform`; preserve that full match unless behavior intentionally broadens.
- Silent cleanup is best-effort by design; failures are swallowed to avoid turning prompt cleanup into user-visible errors.
- `parseUserIds()` is the single mention parser for command flows. Extend it here rather than hand-parsing `@` content inside commands.

## INVARIANTS

- `listenForUserMessage()` returns prompt message IDs so callers can retract or schedule deletion later.
- Timeout handling must always remove the message listener before optional callbacks run.
- `invalid_all_mention` is a semantic contract with command handlers and locale strings; keep that sentinel stable if logic changes.
- CQ payload helpers should keep returning OneBot-shaped objects (`text`, `node`) without pulling in higher-level formatting rules.

## ANTI-PATTERNS

- Do not embed business decisions here; these helpers should not check cave permissions, maintenance locks, or database state.
- Do not add ad-hoc `ctx.on('message')` listeners in command files when `listenForUserMessage()` can own the lifecycle.
- Do not broaden parsing to accept unsupported mention shapes without updating every caller that relies on current validation.
- Do not move formatting/template logic here; that belongs in `src/core/formatter/`.

## HANDOFF NOTES

- `src/core/command/admin.ts` and `add-cave.ts` are the main listener consumers.
- `src/core/formatter/msg-formatter.ts` consumes CQ helpers; mention parsing is shared across retrieval/search/bind flows.
