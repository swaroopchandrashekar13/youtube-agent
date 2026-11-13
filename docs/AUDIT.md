# Phase 0 Audit: darkzOGx/youtube-automation-agent

| | |
|---|---|
| Audited revision | upstream `master` @ `e973d515` (2026-10-26), package version 2.11.0, 82 commits |
| Audit date | 2026-11-13 |
| Size | ~26k lines of JavaScript (CommonJS, Node ≥18.17), no TypeScript, no build step |
| Method | Read the code, plus `npm ci --ignore-scripts`, `npm rebuild sqlite3 sharp`, `npm run lint`, `npm test`, `npm audit` on Node 22, in a scratch clone outside this repo. No code in this repo was changed. |
| Note | The target repo (`swaroopchandrashekar13/youtube-agent`) is **empty** (no commits). Phase 1 must first bring the upstream code in (see Open questions). |

---

## 1. Architecture map and data flow

### 1.1 Process model

One long-running Node process (`npm start` → `index.js`) does everything:

```
index.js  YouTubeAutomationAgent
 ├─ Database (sqlite3, data/youtube_automation.db, 37 tables)
 ├─ CredentialManager (config/credentials.json + config/tokens.json)
 ├─ 7 "agents" (plain classes, not LLM agents with tools)
 │    strategy → scriptWriter → thumbnailDesigner → seoOptimizer → production → publishing, analytics
 ├─ Services: GenerationRecovery, SceneRepair, Provenance, Operator (quality checks + notifications),
 │    AutonomousChannelOperator, ShortsRepurposing, AudienceEngagement, GrowthExperiment,
 │    Discoverability (local heuristic linter "darkzseo"), ProductionReadiness, ActivationMetrics, AnonymousTelemetry
 ├─ Express API + static dashboard (dashboard/*.js) on 127.0.0.1:3456
 └─ DailyAutomation (node-cron, in-process)
```

Other entry points: `setup.js`, `walkthrough.js` (interactive setup), `modern-auth.js` / `oauth-server.js` (OAuth helpers), `agents/*.js` run on their own via `npm run agent:*`.

### 1.2 Generation data flow (`index.js: runGenerationPipeline`)

| Stage (checkpointed) | What happens | Output |
|---|---|---|
| `strategy` | Picks a topic: YouTube `search.list` trend signals + LLM, or the operator's plan | `content_strategies` row |
| `script` | LLM writes a structured script (hook, sections, CTA, `claims[]`) | `scripts` row + `data/scripts/*.json` + `_tts.txt` |
| `thumbnail` | Image model (OpenAI/Gemini) or Playwright HTML→PNG | `data/thumbnails/*.png` |
| `seo` | LLM title/description/tags, validated by `youtube-metadata-validator` | `seo_data` row |
| `production` | **One** TTS call for the whole script → images → video provider clips (hybrid) or Playwright slideshow stills → ffmpeg xfade/concat → SRT captions with *estimated* timings | `data/videos/*.mp4`, `data/audio`, `data/captions` |
| `quality_review` | `OperatorService.runQualityChecks` (metadata-level checks) → `needs_review`, or `approved` if `approval_required=false` | `content_reviews` row, notification |

After approval, a `publish_schedule` row is created. The cron job `*/15` `processPublishQueue` uploads entries whose `publishTime <= now`.

### 1.3 In-process scheduler (`schedules/daily-automation.js`)

node-cron, server-local timezone, only runs while the process is up:

| Cron | Task |
|---|---|
| `0 6 * * *` | daily content generation (queues a job if the buffer is short) |
| `*/15 * * * *` | publish queue processing (**the actual uploader**) |
| `0 9 * * *` | analytics collection |
| `0 8 * * 0` | weekly strategy review |
| `0 22 * * *` | "optimization" |
| `0 3 * * 6` | DB maintenance |
| `0 */4 * * *` | comment sync |
| `30 */4 * * *` | growth experiment refresh (can change live titles/thumbnails via `videos.update` / `thumbnails.set`) |

A 15-minute polling uploader does not fit "scheduled burst job + approval-triggered publish". Phase 2 replaces it with explicit stages.

### 1.4 State storage

- **SQLite** at a hard-coded `data/youtube_automation.db` (no env override). Everything lives here: jobs, checkpoints, reviews, schedule, settings, comments, experiments.
- **Media** on the local filesystem under `data/` with **absolute paths stored in the DB**. Checkpoints check that those paths exist. In an ephemeral Fargate container both the DB and the media disappear after each run, so cloud deployment needs S3 plus a durable state store.
- **Runtime settings** (including `approval_required`) live in the SQLite `settings` table and can be changed from the dashboard.

### 1.5 OAuth tokens

- Google OAuth "Desktop app" client in `config/credentials.json`. Tokens in `config/tokens.json`. Both are written with mode `0600` and gitignored.
- Three separate implementations of the OAuth flow (`credential-manager.js`, `modern-auth.js`, `oauth-server.js`). All use `access_type=offline, prompt=consent`. **None uses a `state` parameter or PKCE.** The callback server binds to 127.0.0.1:8080.
- Tokens are stored as plain JSON, not encrypted. Refreshed tokens are not always written back. There is no `invalid_grant` alerting.
- Scopes requested include YouTube upload, YouTube read-only, force-ssl (comments), and Analytics read-only.

### 1.6 Dashboard protection

- Binds to `HOST` (default `127.0.0.1`). Warns but **still starts** if bound to a non-loopback address without `API_KEY`.
- `requireAPIKey()`: if `API_KEY` is unset, **every mutating route is open**. If set, it checks the `x-api-key` header with `!==` (not a constant-time compare).
- **All GET routes are unauthenticated even when `API_KEY` is set.** That includes `/api/dashboard`, `/api/content/:id`, and asset streaming of videos and thumbnails.
- No `Host`-header allow-list and no CSRF protection. With `API_KEY` unset, a malicious web page in the operator's browser can send a body-less "simple" `POST` to `http://127.0.0.1:3456/api/automation/start`, `/api/operator/start`, and similar routes. DNS rebinding also allows reading the GET routes.

---

## 2. Security review

### 2.1 `npm audit` (lockfile as shipped)

**36 advisories: 2 critical, 19 high, 13 moderate, 2 low.**

| Severity | Package | Direct? | Notes | Fix |
|---|---|---|---|---|
| critical | `tar` | via sqlite3 → node-gyp | Hardlink path traversal; install-time build chain | sqlite3 6.x (major) |
| critical | `proxy-addr` | via express | IP spoofing with trust proxy (not configured) | `npm audit fix` |
| high | `express`, `body-parser`, `path-to-regexp` | express direct | DoS / ReDoS | `npm audit fix` |
| high | `axios` | direct | DoS: no response size check | `npm audit fix` |
| high | `form-data` | direct | CRLF injection | `npm audit fix` |
| high | `sharp` | direct | libvips CVEs | sharp 0.35 (major) |
| high | `sqlite3` | direct | build chain (tar, node-gyp, cacache, make-fetch-happen) | sqlite3 6.x (major) |
| high | `playwright` | direct | Browser download without TLS verification | `npm audit fix`; in Docker, install the browser at build time from a pinned version |
| high | `ws`, `jws`, `lodash`, `js-yaml`, `picomatch`, `brace-expansion`, `tar-fs`, `ip-address` | transitive | various | `npm audit fix` |
| moderate | `uuid` via `node-cron`, `microsoft-cognitiveservices-speech-sdk` | transitive | | major bumps; node-cron goes away in job mode |

**Plan:** in Phase 1, `npm audit fix` (non-breaking). Evaluate sqlite3 6 and sharp 0.35 separately, one commit each with tests. Removing `node-cron` from the job path, and making the Azure speech SDK optional, clears the remaining `uuid` advisories.

### 2.2 Install and postinstall scripts

Packages with install scripts: `sqlite3` (prebuild download / node-gyp), `sharp` (platform check, uses `@img/*` prebuilt packages), `ffmpeg-static` (**downloads an ffmpeg binary from GitHub releases at install time**), `protobufjs`, `@google/genai`, `fsevents` (macOS only).
Upstream's project itself has no `preinstall`/`postinstall` scripts.

**Plan:** in Docker, run `npm ci --ignore-scripts` then `npm rebuild sqlite3 sharp`, and use the distro ffmpeg (`FFMPEG_PATH`). Drop `ffmpeg-static` from the image: it is GPL-3.0 and downloads from the network at install time.

### 2.3 Outbound network calls

Every host found in the code is one the user configures: Google APIs (YouTube Data, Analytics, Gemini), OpenAI, OpenRouter, Moonshot/Kimi, Xiaomi MiMo, Z.ai GLM, DeepSeek, MiniMax, Alibaba DashScope (Wan), Kling, Replicate, ElevenLabs, Azure Speech. **No hard-coded analytics or beacon hosts.**

- `scripts/growth/snapshot-github.js` calls `gh` for repo stars. It is a maintainer tool, not on the runtime path.
- The discoverability adapter (`darkzseo.js`) is a local heuristic linter. Its `spawn` is used only if an external `darkzseo` CLI is configured.

### 2.4 Telemetry and hidden endpoints

`utils/anonymous-telemetry.js` is **off by default**. It sends only if `ANONYMOUS_TELEMETRY_ENABLED=true` **and** `ANONYMOUS_TELEMETRY_ENDPOINT` is set to an HTTPS URL; there is no built-in endpoint. The payload is five allow-listed milestone events plus a random install ID, platform, and Node major version.
**Plan:** delete the module in our fork (or hard-disable it) and record that in `docs/FORK.md`.

### 2.5 eval and child_process

- No `eval` or `new Function` in runtime code.
- `child_process` uses `execFile` with argument arrays for ffmpeg/ffprobe (good, no shell). `spawn('node', ['index.js'])` in `oauth-server.js`. `exec(openCommand)` to open a browser in `modern-auth.js` and `walkthrough.js`, but the URL is not user-controlled. Acceptable; these are local-setup only.

### 2.6 Other findings

| # | Finding | Severity for our use | Location |
|---|---|---|---|
| S1 | **The human approval gate can be switched off.** `approval_required` is a DB setting, writable via `PUT /api/settings` (unauthenticated when `API_KEY` is unset). When `false`, generated content goes straight to `approved` and gets scheduled. | **Blocks rule 1** | `index.js:1250`, `index.js:1542` |
| S2 | `POST /api/content/:id/publish-now` and `emergencyPublish` do not check `review_status === 'approved'` themselves. They rely on a schedule entry existing, which today is only created on approval or when `approval_required=false`. | High | `index.js:1020`, `publishing-scheduling-agent.js:631` |
| S3 | If the schedule time has passed (or `publishNow` is used), the upload uses `DEFAULT_PRIVACY_STATUS` or the editor's choice, which can be `public`. That is direct public upload, with no "private first, then `publishAt`" step. | High (rule 1) | `publishing-scheduling-agent.js:208-222` |
| S4 | **LLM text is put into HTML without escaping** before Chromium renders it (slideshow and thumbnail templates: `${script.title}`, `${section.title}`, …). Untrusted brief or research text could inject `<script>` or remote resources into the render browser. | High once briefs are untrusted (rule 3) | `ai-video-generator.js:~790-860`, thumbnail agent |
| S5 | Untrusted text (YouTube search titles, comments) goes into LLM prompts without delimiters. The LLM step has no tools, which limits the impact, but there is no structural separation. | Medium (rule 3) | `content-strategy-agent.js:351`, engagement service |
| S6 | The logger does **not redact**. Winston writes error objects to `logs/*.log`; axios/OpenAI errors can contain request config and headers. Logs have no retention policy beyond file rotation. | Medium (rule 2) | `utils/logger.js` |
| S7 | No CSRF, no Host check, GET routes unauthenticated, API-key compare not constant-time (see 1.6). | Medium (dashboard is loopback-only) | `index.js:219` |
| S8 | No OAuth `state` / PKCE. | Low (loopback, setup-time only) | three OAuth helpers |
| S9 | Comment reply posting (`comments.insert`) exists, gated by dashboard approval. Our spec says `learn` must never post replies. | Medium (spec) | `audience-engagement-service.js:40` |
| S10 | Growth experiments change **live** video titles and thumbnails via `videos.update` / `thumbnails.set` from cron. Arms are pre-approved, but it is still autonomous mutation of public content. | Medium (spec) | `publishing-scheduling-agent.js:360-377` |
| S11 | Model IDs are hard-coded in `ai-text-service.js` (e.g. `gpt-6.1-sol`, `gemini-3.8-flash-tts`). | Low (rule 9) | `ai-text-service.js:13-60` |

### 2.7 Dependency licenses

442 packages in the lockfile. Most are MIT, Apache-2.0, ISC, or BSD. Flags:

| Package | License | Assessment |
|---|---|---|
| `ffmpeg-static` (optional dep) | **GPL-3.0-or-later** | Bundles a GPL ffmpeg build. Fine for a private, self-run service, but **flag (rule 8)**. Plan: drop it and use the distro ffmpeg in Docker (Debian's build is also GPL when compiled with GPL options, but we don't redistribute it). |
| `@img/sharp-libvips-*` | LGPL-3.0-or-later | Dynamically linked prebuilt libvips. OK for our use; keep attribution. |
| `parse-cache-control` | UNKNOWN (no license field) | Transitive. It is MIT upstream; confirm in Phase 1 license check. |
| `url-template` | "BSD" | Transitive; acceptable. |
| `expand-template` | MIT OR WTFPL | OK. |
| `microsoft-cognitiveservices-speech-sdk` | MIT, but the SDK has Microsoft service terms | Optional provider; consider making it an optional dependency. |

Upstream `LICENSE` is MIT ("YouTube Automation Agent Contributors"). We must keep it.

---

## 3. Reality check of README features

Tests: `npm run lint` → **clean**. `npm test` (`node test.js`, a 3,900-line custom harness, no test runner, no coverage) → **49/49 pass** once a real ffmpeg is on the path (`FFMPEG_PATH=/usr/bin/ffmpeg`). Without it, 48/49: `utils/ffmpeg.js` picks the `ffmpeg-static` path even when its binary was never downloaded, and does not fall back to the system `ffmpeg`. That is a small upstream bug. The tests use stubbed providers and temp databases, so they prove logic, not real provider integrations.

| Feature | Exists? | Works? | Notes |
|---|---|---|---|
| **Evidence / "Research and Provenance" desk** | Yes (`provenance-service.js`, 154 lines) | Yes (tested) | A **manual review ledger**. The LLM's `script.claims[]` and research URLs become claims and sources; publishing is blocked until each claim is marked supported (with a verified source) or waived (with a note). **No automated fact-checking.** "Sources" for the strategy are mostly YouTube search signals, not citations. Useful structure to reuse with our brief `sources[]` and `sourceRefs[]`. |
| **Scene repair** | Yes (`scene-repair-service.js`, 695 lines) | Yes (tested) | Per-scene edit, reorder, regenerate visuals or narration, replace asset, rebuild, intentional-silence override, revision history. Real. Driven from the dashboard, so it needs a Telegram front end ("Regenerate scene N"). |
| **Resumable generation** | Yes (`generation-recovery-service.js`) | Yes (tested) | Stage-level checkpoints in SQLite, artifact validation, retries with backoff on transient errors, downstream invalidation. Sound design. **Limits:** `production` is one coarse stage (TTS, visuals, and assembly all redo together); artifacts are local absolute paths; state is local SQLite. Reusable if we move state and media to S3 + DynamoDB. |
| **Approval gates** | Yes | Partly | Review UI with `factChecked` + `rightsConfirmed` required. Placeholder media is blocked. Provenance, narration, and readiness gates exist at publish. **But** the gate can be turned off (S1), publish-now trusts the schedule entry (S2), and post-approval uploads can be public directly (S3). README claim "Turning on autonomy doesn't skip those checks" is true **only while `approval_required` stays `true`**. |
| **Hybrid assembly** | Yes (`ai-video-generator.js`, `video-providers.js`) | Yes (tested with stubs) | Paid AI clips (Seedance/MiniMax/Kling/Wan/Google) inside a locally assembled ffmpeg timeline, with a `video_max_generated_seconds` cap (default 60s) and slideshow fallback. No support for **our** user-supplied clip inbox (`media-inbox/`), stock footage, or music licensing. |
| Quality checks | Yes (`operator-service.js`) | Yes | Metadata-level only: title length, description ≥50 chars, ≥3 tags, script ≥200 chars, assets present, exact-duplicate topic in 90 days, narration present, banned topics. **Missing:** loudness, silence or black frames, duration, caption sync, sameness/n-gram similarity. |
| Captions | Yes | Weak | SRT with **estimated** timings (8 words per cue, spread evenly). Not tied to the audio. |
| Narration | Yes | English-centric | Whole script in one call (ElevenLabs → OpenAI → Gemini → Azure priority). No per-sentence synthesis, no cache, no loudness normalization, **no language parameter**, so Kannada support is untested. TTS cost is recorded as `amount: null`. |
| Cost control | Partial | Partial | Only a cap on paid video seconds and manual "budget" fields in the ROI studio. **No per-call token/USD ledger, no monthly cap.** |
| Analytics / learning | Yes | Plausible | YouTube Analytics v2 reports, 24h/7d snapshots, retention, recommendations need approval. Reusable. |
| Upload | Yes | OK | `videos.insert` with a streamed body. googleapis sends this as **multipart, not resumable**. Thumbnails and captions are uploaded. `containsSyntheticMedia` is set from provenance. Reconciliation for unknown outcomes is a nice touch. No quota budget. |
| Autonomous operator | Yes | Yes | Plans and queues multiple videos from a mandate. Out of scope for us; strategy lives in Claude scheduled tasks. Disable or remove it. |
| Telemetry | Yes | Off by default | See 2.4. |

**Marketing vs. reality:** the features are largely real and tested. The overstatements:
- The "evidence desk" is human verification, not automated fact-checking.
- "You approve before anything is published" can be switched off.
- "Learns from evidence" means proposals that need approval, not anything automatic.
- "Self-hosted" assumes a long-running desktop process.

---

## 4. Gap analysis against our spec

| Spec requirement | Upstream status | Gap / action | Phase |
|---|---|---|---|
| Upstream remote, FORK.md, CI with gitleaks + license check | CI runs lint and test only | Add gitleaks, license check, dependency audit | 1 |
| `.env` schema validation | None (dotenv, ad-hoc reads) | zod/ajv config schema | 1 |
| Redacting logger | None (S6) | Redaction + structured JSON | 1 |
| Dashboard loopback default, `API_KEY` required otherwise | Loopback default; only warns | **Refuse to start** non-loopback without `API_KEY`; protect GETs; Host check; constant-time compare | 1 |
| Fake-provider offline mode | Tests stub internally; no runtime fake mode | `PROVIDERS_MODE=fake` for text/TTS/image/video/YouTube/Telegram | 1 |
| Approval cannot be bypassed | **Violated (S1-S3)** | Remove the `approval_required` setting; enforce approval inside `publishContent` against a signed or recorded human decision; always upload `private` + `publishAt` | 1 (hard-fix) + 7 |
| One-shot `npm run job --stage=…` with exit codes | None (cron only) | New job runner; keep server mode | 2 |
| Lease / lock | `activeJobs` in-memory map only | File lock locally, DynamoDB lease in cloud | 2 |
| Durable state for ephemeral containers | Local SQLite + local paths | Pull/push state per run: S3 for media and an SQLite snapshot, DynamoDB for approvals and leases. Store relative keys, not absolute paths. | 2 / 9 |
| Dockerfile (arm64, ffmpeg, Chromium, Noto Kannada, non-root) | None | New | 2 |
| `TextProvider` + router + Bedrock + OpenAI-compatible base URL | `AITextService` with OpenAI-compatible presets + Gemini | Wrap in an interface; add Bedrock Converse, config-driven router, Kannada allow-list, JSON-schema output with retries | 3 |
| Cost ledger, monthly / per-video cap, Gemini credit | None | New; every provider call goes through it | 3 |
| `TTSProvider`, per-sentence synthesis, cache, loudnorm, SRT from real timings | Whole-script TTS, estimated SRT | New layer; Sarvam, Indic Parler sidecar, Google TTS, Piper/Kokoro | 4 |
| Kannada bake-off via Telegram | None (no Telegram at all) | New | 4 |
| Brief/feedback JSON Schemas, git sync, quarantine | None | New ingest stage; map brief → existing `strategy`/`script` records so downstream reuse works | 5 |
| Clip inbox, stock fallback with license records, music license gate, thumb inbox | Partial (AI clips, slideshow) | New ingest + manifest | 6 |
| Kannada subtitle burn-in with shaping test | No burn-in; HTML slides only | ffmpeg `subtitles`/ASS with libass + HarfBuzz and Noto Sans Kannada; render test | 6 |
| QA: loudness, silence/black, duration, caption sync, sameness | Metadata checks only | Extend `OperatorService` checks | 7 |
| Telegram approval + Lambda webhook + DynamoDB + `ecs:RunTask` | Dashboard approval only | New (serverless) | 7 |
| Resumable upload, quota budget, `invalid_grant` alert, captions, chapters | Multipart upload; captions yes | Switch to resumable; quota ledger; alerting | 8 |
| `learn` proposes only, never posts | Engagement can post replies; experiments mutate live videos (S9, S10) | Disable reply posting and live experiments in job mode | 8 |
| CDK stack, OIDC, budgets, digest | None | New `infra/` (TypeScript) | 9 |
| `strategy/` prompts | None | New | 10 |
| Tests per module, e2e 20-second MP4 in CI | Single custom harness | Add `node:test` alongside `test.js` (no new framework dependency); keep upstream harness running | all |

### What to reuse vs. replace

- **Reuse:** DB layer, generation checkpoints, provenance ledger, scene manifest and repair logic, metadata validator, ffmpeg helpers, upload reconciliation, analytics agent, quality-check framework.
- **Bypass in job mode:** node-cron scheduler, autonomous operator, growth experiments, reply posting, trend research, upstream strategy and script authoring (briefs replace them; the script stage becomes "polish").
- **Replace:** TTS path, caption generation, OAuth helpers (consolidate to one), logger.

---

## 5. Phased plan and risks

The phases are as in the kickoff prompt. Adjustments I recommend:

1. **Phase 1 hard-fixes the approval bypass (S1-S3) and the HTML escaping (S4)** rather than waiting for Phase 7, because they break non-negotiable rules 1 and 3. The fix is small: remove the toggle, add an approval assertion in `publishContent`, force `private` + `publishAt`, and escape template text.
2. **Phase 2 includes the state-durability design** (S3 + DynamoDB), because job mode on Fargate is meaningless without it. Proposal: one SQLite file per channel, synced to S3 at stage start and end under the DynamoDB lease. That is simple and keeps upstream's DB code. Full migration to DynamoDB is not worth it at this volume.
3. **The Kannada TTS bake-off (Phase 4) is the biggest quality unknown.** Run it as early as possible; everything else is plumbing.

### Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Kannada TTS quality (pronunciation of English technical terms, prosody) is not good enough with affordable providers | Channel quality | Blind bake-off before committing; `codemix` normalization rules; budget for Sarvam if it wins |
| Indic Parler TTS on CPU is slow (a 60s passage could take several minutes on 2 vCPU) and the model is large (GBs) | Fargate time and cost, image size, ephemeral storage | Measure in Phase 4; cache per sentence; store the model in S3 or a separate image layer; skip it if too slow |
| YouTube API: unverified projects' uploads may be locked private until audit; Data API daily quota is small (upload cost must be verified, historically ~1,600 units of 10,000) | Can't publish publicly | Start the audit request early (Phase 8 docs); quota ledger; drop `search.list` (100 units each) from our path |
| Synthetic-content disclosure: `status.containsSyntheticMedia` exists in the API version upstream uses, but this must be verified against current docs | Policy compliance | Verify in Phase 8; manual Telegram checklist fallback |
| Fargate ARM + Playwright Chromium + Kannada fonts image size (~1.5-2.5 GB) and cold-pull time | Cost and latency | Multi-stage build, slim base, ECR lifecycle; measure in Phase 2 |
| Shared AWS account collisions | Breaks the other app | Read-only discovery first; unique names with `yt-agent-` prefix; tag everything; no account-level changes besides one Budget |
| Upstream drift (active project, frequent releases) | Merge pain | Keep changes additive (new modules, thin hooks); record divergences in FORK.md |
| Lambda → `ecs:RunTask` needs subnets and a public IP (no NAT) | Networking | Public subnets with `assignPublicIp=ENABLED`, egress-only security group (as spec'd) |
| GPL `ffmpeg-static` and unknown-license transitive dependency | License hygiene | Drop `ffmpeg-static` in Docker; license-check allow-list in CI |
| Free-tier assumptions (Lambda, DynamoDB, EventBridge Scheduler) | Cost | Verify current terms in Phase 9 with `lastVerified`; budget alarm at ~₹500 |

### Cost impact of Phase 0

None. No AWS resources were created and no paid API calls were made. Only a public `git clone` and an npm install in a scratch directory.

---

## 6. Open questions for the owner

1. **Importing the code:** the target repo is empty. Should Phase 1 (a) merge upstream `master` with its **full history** (recommended: keeps attribution and makes `git merge upstream/master` possible later), or (b) a single squashed import commit?
2. **Branching:** this cloud session can only push to `claude/festive-dirac-k7alqd`. CLAUDE.md asks for `phase/N-name` branches. OK to keep using the session branch, with one commit series per phase, and you open or merge the PRs? Or do you want me to try creating `phase/*` branches?
3. **Launch language and niche** are still `<en|kn>` / `<my niche>` in the prompt. Please confirm. This affects Phase 4 priorities and the sample passages.
4. **Dashboard:** keep it at all (local-only operator console), or make Telegram the only UI and leave the dashboard as an upstream feature we don't use?
5. **Upstream features to disable or remove in our fork:** autonomous operator, growth experiments (live title/thumbnail swaps), comment reply posting, anonymous telemetry, shorts repurposing. Disable via config (smaller diff, easier upstream merges), or delete?
6. **AWS account ID** and confirmation that I may run *read-only* discovery commands. Note: this cloud container has no AWS credentials; you would run the commands I give you and paste the output.
7. **Monthly cap:** the spec says default `$15`, and the target is ₹500-1,500 (~$6-18). Is $15 the hard cap including AWS, or API spend only (AWS then guarded separately by the ₹500 Budget alert)?
