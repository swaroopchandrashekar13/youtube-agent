# ADR 0001: How videos get their visuals (Phase 6 input)

- **Status:** proposed (2026-11-14), to be confirmed when Phase 6 starts
- **Context:** no GPU anywhere; paid API spend capped at $15/month; quality first; Kannada (code-mixed) explainer channel on tech careers; YouTube's 2026 "inauthentic content" enforcement punishes template-like channels.

## Options researched

### A. Open-weight AI video models (text → footage)

| Model | License | Hardware | Verdict |
|---|---|---|---|
| Wan 2.2 (Alibaba) | Apache-2.0 | 16 GB+ VRAM GPU | Best open option; **hosted API only** |
| LTX-2.3 (Lightricks) | Community license; paid agreement at about $10M revenue | GPU (8-20 GB reported) | Flagged under rule 8 (not standard OSS) |
| HunyuanVideo 1.5 (Tencent) | Custom Tencent license | 14-24 GB VRAM | Read the terms before any use |
| Mochi 1, CogVideoX | Apache / custom | GPU | Older and lower quality |

Running any of these on CPU takes minutes to hours per short clip, so self-hosting is ruled out by the no-GPU constraint. Hosted Wan 2.2 is reported at roughly $0.02-0.40 per generated second, depending on host and resolution. Those figures come from aggregator sites that conflict, so verify live prices before use (rule 9).

### B. Code-driven rendering on CPU (free)

| Tool | License | Last release (npm/PyPI, checked 2026-11-14) | Notes |
|---|---|---|---|
| **Revideo** | MIT | 0.11.0, 2026-07-10 | Fork of Motion Canvas with a headless `renderVideo()` API. Tested below |
| Motion Canvas | MIT | 3.17.2, 2025-02-16 | No release in ~21 months; editor-centred, no supported headless render |
| Manim Community | MIT | (not tested) | Python stack; strong for diagrams |
| MoviePy | MIT | (not tested) | Mostly duplicates what we already do with FFmpeg |
| Remotion | Source-available, company licence | | Excluded by rule 8 |
| Current upstream renderer | MIT (ours) | | Playwright HTML stills + FFmpeg crossfades; no animation timeline |

## Render test: Revideo (2026-11-14)

Test setup: a 1920×1080 scene with a Kannada title, Kannada conjunct clusters (ಕ್ಷ ತ್ರ ಜ್ಞ ಶ್ರೀ ಸ್ತ್ರೀ ರ್ಕ ಕ್ತ್ಯ) and code-mixed lines ("ನಿಮ್ಮ resume ಅನ್ನು ATS ಗೆ ಹೊಂದಿಸಿ"), with fade and scale animations. Fonts were `fonts-noto-core`. It ran on 4 vCPUs with a system Chromium.

| Check | Result |
|---|---|
| Renders headless on CPU | Yes: 4.3 s of 1080p30 H.264 in **2.5 s** wall time |
| Kannada shaping | Conjuncts and vowel signs join correctly (Chromium HarfBuzz). **One cluster (ಕ್ತ್ಯ) needs a Kannada reader to confirm**; this is what the planned Telegram frame check is for |
| Latin in code-mixed text | Fell back to a serif face. **Fix: explicit font stack** (`Noto Sans`, then `Noto Sans Kannada`) |
| Telemetry | **On by default.** `@revideo/telemetry` sends render, server-start and error events to PostHog EU and writes an install id to `~/.revideo/id.txt`. Disabled only by `DISABLE_TELEMETRY=true` |
| Container compatibility | Revideo **forces Chrome's `--single-process` flag**, and the current Chromium crashes with it. It had to be patched out for the test. Its bundled ffmpeg/ffprobe also lost their exec bit under `npm ci --ignore-scripts` |
| Extra packages | `@revideo/ui` is required even for headless rendering; pulls puppeteer 25, vite 8, `@ffmpeg-installer/*` (GPL/LGPL binaries) and `posthog-node` |

## Decision (proposed)

Build each video from three layers, cheapest first:

1. **Base layer, CPU, free: Revideo templates**, with these conditions:
   - `DISABLE_TELEMETRY=true` is forced by our wrapper, and the render runs with outbound network blocked (rules 2 and 3). A test asserts that no request leaves the render process.
   - The `--single-process` launch flag is removed with a reviewed `patch-package` patch, or Chrome is pinned to the build that puppeteer expects. Whichever works in the Phase 2 Docker image wins.
   - Our system ffmpeg is used, not the bundled binaries.
   - Several template families (diagram, step list, code walkthrough, comparison table, quote/stat card), rotated, so the Phase 7 sameness check does not flag the channel.
   - **Fallback:** if any condition can't be met, extend the existing Playwright HTML renderer, which already shapes Kannada through the same Chromium engine but has no animation timeline.
2. **Footage layer:** the owner's Google Flow clips via `media-inbox/`, then Pexels/Pixabay stock, with the license and URL recorded per asset.
3. **Optional AI shots:** hosted Wan 2.2 for at most a few seconds per video (hook only), behind the Phase 3 cost ledger and a per-video cap. No self-hosted models.

## Consequences

- No GPU, no new paid services. The only optional spend is capped Wan seconds.
- The new Node dependencies (Revideo, puppeteer, vite) need a license-policy review when added. The `@ffmpeg-installer` binaries go into the policy as an exception, or are excluded.
- A Kannada-reading reviewer confirms the conjunct render frame once per template family (Phase 6 Telegram check).

## Sources

[Thunder Compute](https://www.thundercompute.com/blog/best-open-source-ai-video-generation-models), [DEV benchmark](https://dev.to/jondavis/open-source-ai-video-generators-in-2026-a-developers-benchmark-stack-guide-54i3), [Magic Hour: LTX-2.3 vs Wan 2.2](https://magichour.ai/blog/ltx-2-3-vs-wan-2-2), [Clore comparison](https://docs.clore.ai/guides/comparisons/video-gen-comparison), [Local AI Master](https://localaimaster.com/blog/local-text-to-video-low-vram), [PkgPulse: Remotion vs Motion Canvas vs Revideo](https://www.pkgpulse.com/guides/remotion-vs-motion-canvas-vs-revideo-programmatic-video-2026), [Remotion docs](https://www.remotion.dev/docs/compare/motion-canvas), [AIIdeList: Wan 2.2 API pricing](https://aiidelist.com/blog/cheapest-wan-2-2-api-pricing-2026), [Pruna: Wan 2.2](https://www.pruna.ai/blog/wan-2-2-video-juiced-fastest-and-cheapest-video-generation). Package versions, licenses and telemetry behaviour were checked directly from the npm registry and package source.
