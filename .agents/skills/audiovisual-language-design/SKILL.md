---
name: audiovisual-language-design
description: Design executable audiovisual language for short-drama contextual ads, including composition, camera position, lens, movement, blocking, lighting, color, editing, performance, sound, UI timing, and continuity. Use when creating or revising creative directions, scripts, storyboards, storyboard images, or per-shot video prompts. Do not use director names as a substitute for observable production parameters.
---

# Audiovisual Language Design

Turn an approved dramatic and product idea into decisions a storyboard artist or generation model can execute. Preserve the source drama before adding advertising language.

## Required context

- Source-drama ending, emotional residue, character relationships, visual style, and continuity evidence.
- Product truth: core verb, visible state change, stage success, audience, market message, and CTA boundary.
- Approved creative direction and current production stage.

If evidence is missing, mark the affected field `unknown`; do not invent source-drama or product facts.

## Design order

1. State each shot's narrative job, new information, emotional change, and product action.
2. Choose framing, subject placement, headroom, lead room, depth layers, and mobile safe areas.
3. Specify camera height, direction, lens class, perspective, depth of field, and focus target.
4. Add movement only when an event motivates it. State trigger, path/direction, speed/easing, duration, and terminal composition.
5. Describe blocking and performance: position, eyeline, weight shift, hand action, subtext, reaction delay, and end pose.
6. Lock lighting direction/quality, color temperature, contrast, exposure, materials, skin tone, and cross-shot color continuity.
7. Define edit-in/edit-out points, action or eyeline match, J/L cut, rhythm, and transition. Never use a transition to hide continuity errors.
8. Define dialogue, room tone, ambience, foley, music, UI/VFX sound, silence, and mix priority. World action and result must precede UI feedback and UI sound.

## Style references

Director or film references are analysis shorthand only. Compile them into 2–4 observable parameters across composition, light, movement, edit, sound, and performance. Preserve the original drama's world and do not copy a protected scene, character, plot, or distinctive shot wholesale.

For terminology and parameter requirements, read [references/audiovisual-contract.md](references/audiovisual-contract.md). For field-level rubrics, use `$creative-quality-review` and its project-local matrix.

## Output contract

For every shot return: stable ID/order/duration; narrative function and irreversible state change; start/peak/result/reaction states; framing/camera/lens/depth/focus; blocking/performance; continuity holds; lighting/color/material rules; motivated movement; edit and sound; English dialogue/on-screen text; bound assets; risks; Chinese review text and equivalent English generation instructions.

Avoid empty adjectives such as “cinematic”, “premium”, or “natural” unless followed by observable parameters.

For a production handoff, use these local contracts selectively:

- `references/emotion-continuity-contract.schema.json`: separate character emotion, audience emotion, brand temperature, forbidden jumps, and expression rules.
- `references/audiovisual-language-bible.schema.json`: lock creative bridge, time/rhythm, visual, directing, editing, sound, effects, and continuity systems.
- `references/visual-direction-bible.schema.json`: lock global direction, environment anchors, shot plans, and the prompt manifest.

Do not emit three large documents for a simple revision. Use the relevant fields in the current card or storyboard, and materialize a full contract only when it will be persisted or handed to another production stage.

## Contextual Studio profile

This project approves static storyboard images before video generation. It may generate up to three shots separately and lets the user choose Novvy MCP or ImaRouter, revise individual shots, and combine approved results. The external `single_final_video_pass` rule is an optional strict profile only; never apply it unless the user explicitly selects that profile.

The active budget and timing rules come from `config/production-profile.json`; do not copy fixed limits from external contracts.
