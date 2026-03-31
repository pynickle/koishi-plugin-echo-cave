# COMMAND DOMAIN NOTES

## OVERVIEW
This directory owns user-facing cave workflows: capture, retrieval, deletion, ranking, search, and admin repair/migration commands.

## STRUCTURE
```text
command/
├── add-cave.ts      # quoted message capture, media processing, related-user selection
├── get-cave.ts      # random / by-id retrieval, draw count updates
├── delete-cave.ts   # permission checks and stored-record deletion
├── search-cave.ts   # related-user lookup by channel
├── rank.ts          # ranking output
├── admin.ts         # merge, migration, inspection, confirmation flows
└── misc/bind-user.ts# manual related-user binding
```

## WHERE TO LOOK
| Task | File | Notes |
|------|------|-------|
| Save quoted content into cave | `add-cave.ts` | branches on forward vs normal messages |
| Adjust random retrieval | `get-cave.ts` | weighted formula uses `alpha` and `drawCount` |
| Change delete permissions | `delete-cave.ts` | contributor/sender/admin checks converge here |
| Add admin tooling | `admin.ts` | keep confirmation UX consistent |
| Bind or search related users | `misc/bind-user.ts`, `search-cave.ts` | both rely on parsed user IDs and group validation |

## LOCAL CONVENTIONS
- Validate session scope early; group-only flows usually return `echo-cave.general.privateChatReminder` or `ensureGuildSession(...)` failures immediately.
- Parse mentions and user lists through shared helpers (`parseUserIds`, user/group checks). Do not hand-roll mention parsing in individual commands.
- Keep localized response keys near the behavior being changed; command handlers are thin flow controllers, not translation generators.
- Reuse interactive confirmation/listener helpers instead of embedding ad-hoc `ctx.on('message')` logic.
- For destructive actions, prefer summary + confirmation + partial-failure reporting over silent best-effort behavior.

## INVARIANTS
- `add-cave.ts` requires a quoted message and may switch normal messages into forward mode when media/reply content makes that safer.
- `get-cave.ts` increments `drawCount` after successful send, and also after partial-send failures; preserve that weighting contract.
- `deleteStoredCave()` is the shared delete primitive because media cleanup may need to happen with record deletion.
- Admin commands are private-admin only; keep `ensureAdminPrivateAccess()` as the gate before any expensive or destructive work.
- Boolean maintenance options in `admin.ts` accept Chinese and English variants (`keep`, `drop`, `保留`, `删除`, etc.); ID ranges are numeric only (`1,2,5-8`).
- `cave.bind` is gated by command registration authority (`authority: 4` in `src/index.ts`), while admin maintenance commands use private chat plus `cfg.adminIds`; keep those admin models distinct.
- Delete permissions rely on Koishi authority/user lookups in the delete flow, not on `cfg.adminIds`.

## ANTI-PATTERNS
- Do not call database writes before permission checks complete.
- Do not bypass `deleteStoredCave()` when removing records.
- Do not add direct media manipulation here if `src/utils/media/media-helper.ts` can own it.
- Do not mix command registration into this directory; registration stays in `src/index.ts`.
- Do not repeat root-level toolchain rules here.

## HANDOFF NOTES
- If a change touches media storage, read `src/utils/media/AGENTS.md` first.
- If a change touches config-driven behavior, update `src/config/config.ts` and locale labels together.
