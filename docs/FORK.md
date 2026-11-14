# About this fork

This repository is a private fork of [darkzOGx/youtube-automation-agent](https://github.com/darkzOGx/youtube-automation-agent) (MIT). The upstream `LICENSE` and its attribution are kept unchanged.

It turns the upstream "self-hosted autonomous channel" into the **execution side** of a hybrid pipeline. Strategy and briefs come from Claude scheduled tasks. This repo turns briefs into videos, asks a human to approve them on Telegram, uploads approved videos, and writes analytics back. The standing rules are in [`CLAUDE.md`](../CLAUDE.md); the audit that motivated the changes is in [`AUDIT.md`](AUDIT.md).

## Upstream tracking

| | |
|---|---|
| Upstream remote | `git remote add upstream https://github.com/darkzOGx/youtube-automation-agent.git` |
| Imported at | upstream `master` @ `e973d51` (2026-10-26, v2.11.0), merged with full history (`--allow-unrelated-histories`) |
| Merging upstream later | `git fetch upstream && git merge upstream/master`, then `npm test && npm run dry-run` |

To keep merges cheap, fork changes are **additive**: new modules under `utils/` and `scripts/`, plus small, commented hooks in upstream files. Each hook is marked with a `Fork:` comment, so `git grep -n "Fork"` lists every divergence point.

## Owner decisions (2026-11-13)

| Question | Decision |
|---|---|
| How to import upstream | Full-history merge |
| Branches | Commit series per phase on the session branch; owner opens and merges PRs |
| Dashboard | Kept as a **local-only** operator console; Telegram becomes the primary interface (Phase 7) |
| Unwanted upstream features | **Disabled via config** (feature switches below), not deleted |
| Monthly cap | `$15` hard cap on paid API spend (Phase 3 ledger); AWS guarded separately by an AWS Budget alert (~₹500) |
| AWS account | `858082489874`, region `ap-southeast-2` |
| Language / niche | See [`CHANNEL.md`](CHANNEL.md) (recommendation, pending owner confirmation) |

## Divergences from upstream

### Safety (non-negotiable rules)

| Area | Upstream behaviour | Fork behaviour | Where |
|---|---|---|---|
| Approval gate (rule 1) | `approval_required` DB setting could be turned off from the API/dashboard; content then auto-scheduled | Setting ignored; generated content always waits in `needs_review`; the settings API no longer accepts it; the dashboard toggle is locked on | `index.js` (quality stage, `PUT /api/settings`), `dashboard/app.js`, `database/db.js` |
| Publish check (rule 1) | `publishContent` trusted that a schedule entry existed | `utils/approval-gate.js` checks the recorded human approval (`review_status=approved` + `reviewed_at`) right before every upload; fails closed. Shorts also need an approved source video | `agents/publishing-scheduling-agent.js` |
| Upload privacy (rule 1) | Past-due or "publish now" uploads went out as `public`/`unlisted` directly | Every upload is `private`. A public release becomes a scheduled `publishAt` (approved time, or at least 15 minutes ahead). `unlisted` stays private, with a warning to change it by hand | `utils/approval-gate.js` `resolveUploadPrivacy` |
| Synthetic disclosure (rule 7) | Only a manual provenance toggle | Also derived from assets: AI narration, AI video clips, or AI images set `containsSyntheticMedia=true`; unknown origin counts as synthetic | `utils/disclosure.js`, uploader |
| Template injection (rule 3) | LLM text interpolated raw into the Playwright slideshow HTML and thumbnail SVG | All text escaped; only plain CSS colours and base64 image data URLs allowed; the render page blocks every network request | `utils/html-escape.js`, `utils/ai-video-generator.js`, `agents/thumbnail-designer-agent.js` |
| Secrets in logs (rule 2) | No redaction | Every log record (file and console) passes through `utils/redact.js`: known secret env values, any `*_KEY/*_TOKEN/*_SECRET/*_PASSWORD` value, common token shapes, and sensitive object keys. `LOG_FORMAT=json` gives structured stdout logs with no log files | `utils/logger.js` |
| Dashboard API | Mutating routes open when `API_KEY` unset; GETs always open; no Host/Origin checks; non-constant-time compare; non-loopback `HOST` only warned | Host allow-list (DNS rebinding); cross-origin writes refused (CSRF); with `API_KEY`, all `/api` and legacy data routes need it (header or `SameSite=Strict` cookie); constant-time compare; **refuses to start** on a non-loopback `HOST` without a 24+ character `API_KEY` | `utils/http-security.js`, `index.js` |
| Config | Ad-hoc `process.env` reads | `utils/config.js` (zod) validates fork settings; errors name the variable, never its value | `index.js start()` |

### Feature switches (all default `false`)

Each switch is enforced where the action happens, not only in the UI. A disabled feature throws `FEATURE_DISABLED` (HTTP 403).

| Variable | Disables | Enforced in |
|---|---|---|
| `FEATURE_SCHEDULER` | In-process node-cron (generation, 15-minute publish polling, analytics, …). Job mode (Phase 2) replaces it | `index.js initialize()` |
| `FEATURE_AUTONOMOUS_OPERATOR` | Autonomous channel operator runs | `utils/autonomous-channel-operator.js` |
| `FEATURE_GROWTH_EXPERIMENTS` | Live title/thumbnail swaps on published videos | `utils/growth-experiment-service.js`, `applyVideoPackaging` |
| `FEATURE_REPLY_POSTING` | Posting comment replies | `utils/audience-engagement-service.js` |
| `FEATURE_SHORTS` | Approving/scheduling Shorts uploads | `utils/shorts-repurposing-service.js` |
| `FEATURE_ANONYMOUS_TELEMETRY` | Upstream opt-in telemetry (also needs its own upstream variables) | `utils/anonymous-telemetry.js` |

The upstream test harness (`test.js`) turns the first five on for its own process, because it tests those features directly.

### Offline fake-provider mode

`PROVIDERS_MODE=fake` (refused when `NODE_ENV=production`):
- builds no paid or networked client, even if keys are present;
- narration is real ffmpeg audio sized to the text (`FAKE_TTS_MAX_SECONDS`, default 20);
- visuals use the local Playwright slideshow;
- YouTube Data/Analytics are in-process fakes that write `calls.jsonl` to `FAKE_YOUTUBE_DIR`.

Text uses upstream's template fallbacks until the Phase 3 provider layer adds a schema-driven fake `TextProvider`.

`npm run dry-run` runs the whole pipeline in an isolated `DATABASE_PATH`: generate → `needs_review` → publish refused → approve → fake upload. It then checks the MP4 with ffprobe and checks the privacy and disclosure fields. CI runs it on every push.

### Job mode (Phase 2)

`npm run job -- --stage=<ingest|generate|qa|publish|learn> [--topic=…] [--brief=<id>] [--content=<id>] [--length=short|medium|long] [--timeout-ms=N]` runs one stage and exits. It never starts the HTTP server or the scheduler. The last stdout line is a JSON summary. The server mode (`npm start`) still works.

| Exit code | Meaning | Examples |
|---|---|---|
| 0 | done, or nothing to do | upload finished; nothing approved to upload |
| 10 | waiting for a human | video awaits review; publish blocked by the approval gate; a disabled feature |
| 20 | transient, retry later | network or rate limit; another run holds the lease; timeout; SIGTERM |
| 30 | fatal, retrying won't help | bad arguments or config; missing credentials; unknown errors |

| Stage | What it does now | Idempotency |
|---|---|---|
| `generate` | Runs the upstream pipeline once and ends in `needs_review` | Keyed `brief:<id>`, `topic:<normalised>`, or `daily:<UTC date>`. A completed key does nothing; a failed or interrupted key **resumes from upstream's checkpoints** |
| `qa` | Re-runs quality checks on unapproved content | Never approves; moves only between `needs_review` and `needs_attention` |
| `publish` | Uploads every approved, not-yet-uploaded item (private + `publishAt`) | One upload per item (schedule status and upstream reconciliation for unknown outcomes) |
| `learn` | Records 24h/7d analytics evidence | Reports partial and total failures (upstream swallowed them) |
| `ingest` | Exits 30: arrives in Phase 5 | n/a |

Single-runner lease: `jobs/lease.js` (file-based; `JOB_LEASE_DIR`). It is acquired **before** the agent initialises, because initialisation marks unfinished jobs as interrupted. A lease past its expiry, or held by a dead process on the same host, is taken over. In AWS it is replaced by a DynamoDB conditional-write lease with the same interface (Phase 9). Stage timeout: `JOB_TIMEOUT_MS` (default 45 minutes). SIGTERM releases the lease and exits 20.

Tested in this sandbox: a hard `kill -9` in the middle of `generate`, followed by a re-run, took over the lease and resumed the same job, reusing the strategy, script, thumbnail and SEO checkpoints. Running `publish` twice uploaded once.

### State in ephemeral containers (design, built in Phase 9)

Fargate tasks start with an empty disk, and upstream keeps everything in `data/` (SQLite plus media with absolute paths). Plan:
1. Acquire the DynamoDB lease, then download `state/youtube_automation.db` and the media referenced by unfinished jobs from S3 into `data/`.
2. Run the stage, uploading new media under `s3://…/media/<productionId>/` as it is produced.
3. Upload the SQLite file (versioned bucket, so a bad run can be rolled back), then release the lease.

One SQLite file per channel keeps upstream's database code unchanged. At one or two videos a day, a database service is not worth its cost or its rule-6 risk (no RDS). Absolute media paths will be rewritten to `data/`-relative keys when the S3 adapter lands.

### Docker image

`Dockerfile` builds `node:22-bookworm-slim` for arm64 and amd64:
- **deps stage:** `npm ci --omit=dev --ignore-scripts`; only sqlite3 and sharp are rebuilt.
- **runtime stage:** distro ffmpeg, Noto fonts including Kannada, Playwright's headless Chromium shell, and tini.
- **user:** non-root uid 10001; code is root-owned and only `data/ logs/ uploads/ temp/` are writable.
- **defaults:** `NODE_ENV=production`, `LOG_FORMAT=json`, `FEATURE_SCHEDULER=false`, `DISABLE_TELEMETRY=true`.
- **no default stage.**

```bash
docker run --rm --init <image> --stage=generate --topic="..."
```

CI builds amd64 and runs container checks: uid, Kannada font, ffmpeg subtitle filter, no secrets in the image, exit 30 without `--stage`, and a fake-mode `generate` that exits 10. CI also builds arm64 under QEMU. This sandbox blocks the Debian mirrors, so the image is verified in CI rather than locally.

### Small fixes

- `utils/ffmpeg.js`: fall back to system `ffmpeg` when `ffmpeg-static` is installed without its binary.
- `database/db.js`: optional `DATABASE_PATH`.
- `utils/ai-video-generator.js`: optional `CHROMIUM_PATH` for Playwright.

### Tooling

| Tool | Command | Notes |
|---|---|---|
| Unit tests | `npm run test:unit` | `node:test`, in `test/unit/`; `npm test` runs upstream `test.js` and then these |
| Dry run | `npm run dry-run [-- --out DIR]` | Exit 0 ok, 1 check failed, 30 fatal |
| License check | `npm run license:check` | Policy and dated exceptions in `license-policy.json` |
| Secret scan | `npm run secrets:scan` (needs gitleaks) | Reviewed historical fixtures in `.gitleaksignore` |
| Pre-commit | `npm run hooks:install` | Or `.pre-commit-config.yaml` for the pre-commit framework |
| CI | `.github/workflows/ci.yml` | Lint and test (Node 20/22), license check, gitleaks over full history, dry run with artifacts, audit report |

## Known remaining issues

| Item | Status | Plan |
|---|---|---|
| `npm audit` | **Resolved in Phase 2:** 0 advisories after upgrading sqlite3 6, sharp 0.35 and node-cron 4; the CI audit is now blocking | n/a |
| AUDIT S5: untrusted text in LLM prompts without delimiters | Open | Phase 3 provider layer (delimited untrusted blocks, no tools) |
| AUDIT S8: OAuth flows have no `state`/PKCE; three duplicate implementations | Open (setup-time, loopback only) | Consolidate in Phase 8 |
| AUDIT S11: model IDs hard-coded in `utils/ai-text-service.js` | Open | Phase 3 router config resolved at runtime |
| Upload is multipart, not resumable | Open | Phase 8 |
| Approval comes from the dashboard, not Telegram | Open by design | Phase 7 |
| Raw `console.log` calls outside `Logger` are not redacted | Partial: they print status text, not secrets | Route through `Logger` as files are touched |

## Dependency changes

| Package | Change | License | Why |
|---|---|---|---|
| `zod` ^4.6.7 | added | MIT | Config and input schema validation |
| transitive | `npm audit fix` (non-breaking) | unchanged | 36 → 10 advisories |
| `sqlite3` 5 → 6 | major | BSD-3-Clause | Drops the vulnerable node-gyp/tar install chain |
| `sharp` 0.34 → 0.35 | major | Apache-2.0 (libvips LGPL, existing exception) | libvips security fixes |
| `node-cron` 3 → 4 | major | ISC | uuid advisory; `createTask()` replaces `schedule(…, { scheduled: false })` |
| Node engine | `>=18.17` → `>=20.17` | n/a | Required by the three upgrades; Node 18 is end-of-life (April 2025). **Diverges from CLAUDE.md's "Node 18.17+"** |
