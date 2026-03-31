# MEDIA PIPELINE NOTES

## OVERVIEW
This directory is the storage and media lifecycle boundary: save, rewrite, migrate, clean up, inspect, and resolve media references for cave content.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Save media during cave creation | `saveMedia()` | download + validate + store |
| Rewrite stored message refs | `rewriteMessageMediaStorage()` family | migration and merge backbone |
| Switch local vs S3 behavior | `getStorageMode()`, S3 helpers | keep backend branching centralized |
| Clean size-limited local storage | `checkAndCleanMediaFiles()` | only applies in local mode |
| Delete media with cave deletion | `deleteMediaFilesFromMessage()` | handles file URIs, local paths, S3 URIs |
| Inspect media refs before migration | `inspectCaveMediaRefs()` | admin inspection entry |

## LOCAL CONVENTIONS
- Keep storage-mode branching centralized; callers should pass config, not precompute backend behavior.
- Prefer ref rewriting over piecemeal string edits. Migration logic assumes structured transforms and transfer plans.
- Preserve commit/rollback semantics around transfer plans. Rewrite first, then commit side effects only after DB updates succeed.
- Cache behavior is local to this module (`base64Cache`, S3 client cache, cleanup timers). Extend caches here instead of leaking them outward.
- Log failures and return survivable fallbacks (`mediaUrl`, skipped item, failed record list) where the existing code already chooses resilience over hard failure.

## INVARIANTS
- Supported storage refs include local paths, `file://` URIs, HTTP(S) URLs, and `s3://` URIs; conversions must remain reversible enough for later cleanup/migration.
- `getS3Client()` caches by effective config tuple; do not create throwaway clients in new helpers.
- Cleanup by size limit only runs for local storage with `enableSizeLimit` turned on.
- Migration helpers track stats and failed record IDs; preserve these summaries because admin commands surface them directly.
- Message content mutation flows are content-aware, not regex-only. New ref rewrites should stay inside the existing mutation helpers.

## ANTI-PATTERNS
- Do not duplicate S3 upload/delete logic in command handlers.
- Do not write directly to filesystem or S3 outside the transfer-plan / helper flow.
- Do not add new URI formats unless every reader, deleter, and migrator path can understand them.
- Do not treat empty downloads or invalid content types as success cases.
- Do not split this file casually; most complexity here is shared state and lifecycle coupling, not accidental sprawl.

## HANDOFF NOTES
- Changes here often require checking `add-cave.ts`, `forward-parser.ts`, and `admin.ts` because they are the main callers.
- The root `AGENTS.md` covers toolchain and release rules; this file is intentionally local to media behavior only.
