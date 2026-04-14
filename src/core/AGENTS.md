# CORE DOMAIN NOTES

## OVERVIEW

This directory owns the shared runtime layer beneath commands: cave storage, message parsing, send formatting, and send-failure recovery.

## STRUCTURE

```text
core/
├── cave-store.ts       # shared DB accessors for public-id and entryId based mutations
├── formatter/          # outbound message rendering and send path
├── parser/             # quoted/forward message normalization before storage
├── send-failure.ts     # ignore / auto-delete / daily-report recovery policy
└── command/            # user-facing workflows; see child AGENTS.md for flow rules
```

## WHERE TO LOOK

| Task                                                     | Location                     | Notes                                                                                    |
| -------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| Change active cave table or snapshot helpers             | `cave-store.ts`              | `ACTIVE_CAVE_TABLE` is `echo_cave_v3`; public IDs are not DB primary keys                |
| Change send body rendering or template wrapping          | `formatter/msg-formatter.ts` | may send template header before body; partial failures surface as `PartialCaveSendError` |
| Change normal-message media normalization                | `parser/msg-parser.ts`       | thin wrapper around `processMediaElement()`                                              |
| Change forward reconstruction or special sender handling | `parser/forward-parser.ts`   | nested forwards recurse here; special user `1094950020` is adapter-resolved              |
| Change send-failure cleanup/reporting                    | `send-failure.ts`            | scheduler only activates for `daily-report` mode                                         |

## LOCAL CONVENTIONS

- Keep storage concerns centralized in `cave-store.ts`; shared callers should not reinvent public-id lookups or snapshot cloning.
- Keep parser modules thin. Media processing belongs to `src/utils/media/`; parser code should orchestrate, not duplicate storage logic.
- Formatter decides presentation, not retrieval. It resolves media for send, chooses locale templates, and then hands off to OneBot send APIs.
- Send-failure policy is mode-driven (`ignore`, `auto-delete`, `daily-report`). New handling branches should stay inside `send-failure.ts` so command flows keep one recovery path.
- `command/` has its own AGENTS file; put cross-command runtime rules here and user-flow rules there.

## INVARIANTS

- `ACTIVE_CAVE_TABLE` points at `echo_cave_v3`; older tables exist only for migration/bootstrap.
- Once a cave row is loaded, destructive or restorative mutations should use `entryId`; the public `id` is user-facing and can be reindexed.
- `toCaveSnapshotRecord()` / `toCaveBackupRecord()` clone dates and arrays intentionally; preserve that copy semantics for backup and restore paths.
- `sendCaveMsg()` may succeed in sending the template prelude and fail on the body afterward. That is why `PartialCaveSendError` exists and why callers route failures through `handleCaveSendFailure()`.
- Daily send-failure summaries are grouped by `platform:selfId`, delivered through the matching bot, and cleaned up only after successful delivery.
- Forward reconstruction keeps nested forward nodes intact and resolves the special sender ID `1094950020` through the OneBot adapter helper instead of hard-coding a display name.

## ANTI-PATTERNS

- Do not write new runtime logic against `echo_cave` or `echo_cave_v2`.
- Do not mutate cave rows by public `id` when `entryId` is available for the update/delete path.
- Do not duplicate media transformation logic inside parser or formatter modules.
- Do not bypass `handleCaveSendFailure()` when changing retrieval send flow; draw-count and cleanup behavior depend on the shared failure path.
- Do not put command registration here; `src/index.ts` remains the registration boundary.

## HANDOFF NOTES

- If a change touches user-facing command behavior, read `src/core/command/AGENTS.md` next.
- If a change touches stored media refs or upload/delete behavior, pair this file with `src/utils/media/AGENTS.md`.
- If a change adds config-driven behavior in send failure or formatting, update `src/config/config.ts` and config locales in the same pass.
