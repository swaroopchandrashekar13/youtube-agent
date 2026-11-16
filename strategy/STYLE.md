# Script style guide (all channels)

These rules are checked by a human at approval and partly by automated QA.

1. **Hook in the first 15 seconds.** Open inside the story: the scam's first move, or the surprising number. Never "welcome to the channel", "in this video".
2. **One idea per video.** One scam, or one dataset question. If the outline needs "also", it is two videos.
3. **Every factual claim has a source** in `sources[]`, cited from the scene's `sourceRefs`. Prefer primary sources (Parliament replies, PIB, RBI, NPCI, cybercrime.gov.in, data.gov.in, IMD, Census). Say where a number comes from in the narration.
4. **Original value in every video:** our own framing, our own example, our own chart. Never re-narrate someone else's video or article.
5. **Vary the structure.** Do not reuse the same sequence of scene types as the previous two videos on the channel (QA blocks it).
6. **Spoken language.** Short sentences. Numbers written the way they are spoken ("one lakh twenty-three thousand"); spell out abbreviations the voice may misread ("I 4 C", "C B I"). Indian English for `en`.
7. **Hindi (`hi`) translations** are natural spoken Hindi, not word-for-word; keep common English words people actually use (video call, scam, report). Keep each scene about as long as the English one (QA warns if the dub must be sped up more than 25%).
8. **No advice personas.** Safety steps and official helplines are fine (`containsAdvice: "safety"`). No financial, medical or legal advice; no investment or product recommendations.
9. **No private individuals by name.** No unverified accusations against companies. No graphic or distressing detail.
10. **Honest packaging.** The title and `thumbnailText` promise only what the video delivers. Thumbnail text is 1-3 words.
11. **Length:** 90-180 seconds while the channels are new. End with one clear action for the viewer.

## Scene types (`visual.type`)

`title` (hook), `stat` (one big number), `bars` (2-8 bars), `steps`, `redflags`, `checklist`, `bullets` (2-5 items each), `quote`, `outro`. For lists, `revealAt` gives the 0-based sentence of the narration at which each item appears.
