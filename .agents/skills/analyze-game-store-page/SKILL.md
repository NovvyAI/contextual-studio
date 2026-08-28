---
name: analyze-game-store-page
description: Analyze mobile-game product pages from Google Play or Apple App Store URLs and produce evidence-based product, positioning, creative, and market briefs. Use when Codex is asked to evaluate a game URL, identify its real core loop and selling points, interpret store screenshots or trailers, analyze reviews and monetization signals, compare store positioning with gameplay, infer likely user-acquisition creative directions, or prepare inputs for ad concepts, contextual ads, trailers, and playable ads.
---

# Analyze Game Store Page

Turn a store URL into a product-and-creative brief. Browse because store metadata, ratings, versions, screenshots, and positioning change over time. Separate verified store evidence from external evidence and creative inference.

## Workflow

1. Validate the URL and product identity.
   - Recognize `play.google.com/store/apps/details` as Google Play and `apps.apple.com` as Apple App Store. Refer to the latter as Apple App Store, not “Apple Play.”
   - Record app name, developer, package or bundle ID, platform, locale, category, age rating, monetization labels, update date, rating, review count, and download range when available.
   - Follow locale parameters intentionally. Note when ratings, descriptions, or screenshots appear market-specific.

2. Capture current first-party evidence.
   - Open the supplied page and inspect the description, feature bullets, update notes, screenshots, preview video, icon, and visible reviews.
   - Open or download screenshot assets when visual inspection materially affects the answer.
   - Prefer the official store page and developer site for product facts. Cite current claims near the relevant analysis.

3. Reconstruct product truth.
   - Infer the moment-to-moment input, legal moves, success condition, failure or pressure state, feedback, level progression, meta loop, rewards, boosters, economy, narrative wrapper, and monetization.
   - Use `references/product-analysis-rubric.md` to distinguish core mechanic, session loop, progression loop, and marketing wrapper.
   - If the description is ambiguous, verify through an official trailer or reputable gameplay recording. Label anything not directly demonstrated.

4. Analyze selling points as a hierarchy.
   - Identify the category promise, functional benefit, sensory reward, emotional benefit, challenge or mastery promise, progression promise, and differentiation.
   - Rank each selling point by product truth, visual demonstrability, distinctiveness, and likely acquisition value.
   - Phrase each selling point as player value, not merely a feature list.

5. Decode the store creative system.
   - Read screenshot order as a funnel: hook, mechanic, reward, progression, narrative, breadth, trust, and CTA.
   - For every screenshot, record visible claim, demonstrated feature, target emotion, and whether the claim is supported by actual gameplay.
   - Inspect icon, palette, characters, food or objects, typography, UI density, before/after states, hands, arrows, failure cues, and reward bursts.

6. Read user and business signals.
   - Sample positive, mixed, and negative reviews across dates when available.
   - Separate recurring themes from isolated anecdotes. Never treat one review as prevalence data.
   - Note signals about ad load, paywalls, difficulty spikes, content exhaustion, lost progress, misleading ads, feature changes, and developer responsiveness.
   - Do not estimate revenue, retention, CPI, ROAS, or demographic composition without a cited data source.

7. Investigate acquisition creative only when requested or useful.
   - Search official social accounts, public ad libraries, gameplay channels, and indexed creative intelligence sources when accessible.
   - Distinguish: **verified live ad**, **historical ad**, **store creative**, **organic gameplay**, and **inferred creative pattern**.
   - Never call store screenshots “currently running ads.” State coverage limitations explicitly.

8. Produce the brief using `references/output-template.md`.
   - Lead with the product thesis and strongest selling point.
   - Support every temporal or externally verifiable claim with a citation.
   - Mark facts, strong inferences, hypotheses, and unknowns.

## Evidence Labels

Use these labels when ambiguity matters:

- **Store fact:** directly stated or shown on the official page.
- **Gameplay evidence:** directly demonstrated in a trailer or recording.
- **Review signal:** reported by one or more users; not independently verified.
- **External market evidence:** supported by a named outside source.
- **Strong inference:** multiple cues support it, but the product does not state it.
- **Creative hypothesis:** a testable advertising idea, not evidence of current practice.

## Guardrails

- Do not copy the store description and call it analysis.
- Do not confuse theme with mechanic, mechanic with meta loop, or narrative wrapper with playable core.
- Do not assume screenshot order or assets are identical across countries and platforms.
- Do not infer target demographics solely from character gender, colors, or art style.
- Do not claim an ad concept is live without a dated, inspectable ad source.
- Do not describe ratings, reviews, download counts, versions, prices, or update dates from memory; verify them during the task.
- Do not hide product–marketing mismatch. Treat it as a strategic finding and explain its acquisition and expectation risks.
- If the user supplies only a URL, make reasonable progress without asking what fields to analyze; use the full brief by default.

## Resources

- `references/product-analysis-rubric.md`: Read when reconstructing gameplay, selling points, creative strategy, and evidence strength.
- `references/output-template.md`: Read when producing a full game-store analysis or a downstream advertising brief.
