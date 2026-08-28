---
name: analyze-short-drama
description: Analyze short-drama video files or episodes by reconstructing plot, character relationships, emotional turns, memorable dialogue, visual motifs, and reusable advertising context. Use when Codex is asked to read, watch, summarize, break down, compare, or extract creative hooks from vertical dramas, mini-series episodes, reels, or short narrative videos, especially before designing contextual ads, trailers, hooks, recaps, or playable-ad transitions.
---

# Analyze Short Drama

Produce an evidence-based narrative and creative analysis from the video itself. Separate observed facts from interpretation and from proposed creative reuse.

## Workflow

1. Inspect the source before interpreting it.
   - Confirm file existence, duration, dimensions, codecs, orientation, and audio/subtitle streams with `ffprobe`.
   - If the file is remote, obtain or open the actual artifact when authorized. Do not infer an episode from its title alone.

2. Build visual coverage.
   - Run `scripts/make_contact_sheets.sh VIDEO OUTPUT_DIR` when `ffmpeg` is available.
   - Inspect the overview sheet first, then the denser sheet and individual frames around reversals, reveals, entrances, exits, injuries, kisses, slaps, confrontations, and cliffhangers.
   - Increase sampling density for rapid editing or unclear action. A contact sheet is navigation, not proof that nothing happened between frames.

3. Recover dialogue and chronology.
   - Prefer embedded subtitles when present.
   - Otherwise inspect burned-in captions from sampled frames and listen to ambiguous sections when possible.
   - Quote only dialogue visible or audible in the artifact. Mark approximate wording when certainty is limited.
   - Construct the episode as a sequence of actions and decisions, not merely a theme summary.

4. Analyze with the rubric in `references/analysis-rubric.md`.
   - Identify setup, escalation, reversal, reveal, emotional payoff, and cliffhanger.
   - Track what each character knows, wants, believes, and chooses.
   - Distinguish surface emotion from the deeper audience emotion: pity, anger, vindication, betrayal, anticipation, relief, or romantic tension.

5. Extract reusable creative material.
   - List iconic props, colors, costumes, locations, gestures, compositions, sound cues, and lines.
   - Explain the dramatic meaning of each item before proposing reuse.
   - For contextual advertising, identify transition bridges that preserve both visual continuity and emotional causality.

6. Report confidence and limitations.
   - Label direct observations, strong inferences, and speculative interpretations.
   - State when missing subtitles, inaudible audio, sparse sampling, or absent preceding episodes limits certainty.

## Output Shape

Adapt length to the request. For a full analysis, use:

1. **One-sentence episode thesis** — the irreversible change in this episode.
2. **Beat-by-beat chronology** — preferably timestamped when precision matters.
3. **Character and relationship movement** — desire, choice, power shift, knowledge gap.
4. **Emotional curve** — audience emotion at each major beat and the peak payoff.
5. **Key dialogue** — exact or explicitly approximate, with why it matters.
6. **Visual and audio motifs** — reusable elements and their narrative meaning.
7. **Hook and cliffhanger mechanics** — why viewers continue watching.
8. **Creative handoff** — elements safe to reuse, elements likely to break continuity, and 2–4 transition opportunities.
9. **Confidence notes** — unresolved identities, dialogue, or chronology.

## Guardrails

- Do not invent names, relationships, prior events, motives, or dialogue. Use role labels until the artifact establishes identity.
- Do not confuse costume color or proximity with relationship proof.
- Do not reduce the analysis to plot summary; explain decisions, power shifts, and audience emotion.
- Do not treat a sampled frame as the exact order of events without checking neighboring frames.
- Do not let a downstream product or ad concept distort the source analysis. Finish the source reading first, then map it to the brief.
- When proposing an ad transition, preserve the protagonist's agency and the emotional promise of the ending; avoid turning serious injury or abuse into a cheerful visual gag.
- If the user asks only for analysis, do not create or modify an ad asset without separate authorization.

## Resources

- `scripts/make_contact_sheets.sh`: Generate overview, dense contact sheets, media metadata, and sequential sample frames.
- `references/analysis-rubric.md`: Use for detailed narrative, emotion, visual, and contextual-ad analysis criteria.
