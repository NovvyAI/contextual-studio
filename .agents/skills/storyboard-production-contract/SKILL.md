---
name: storyboard-production-contract
description: Compile an approved short-drama contextual-ad concept and reference set into structured text storyboards, static storyboard-image prompts, and per-shot video tasks for Contextual Studio. Use when generating or revising storyboard candidates, validating shot completeness, creating storyboard images, or compiling the final video prompt. Do not submit media generation by itself.
---

# Storyboard Production Contract

Convert approved intent into a small, auditable shot plan. Use `$audiovisual-language-design` for shot parameters and `$creative-quality-review` before approval.

## Contextual Studio stages

1. After selected character references are confirmed, create three text candidates `storyboard-A/B/C` in the same Codex session.
2. Each candidate contains an overall story and at most three content shots.
3. The user selects one candidate; GPT-image-2 generates one 9:16 static frame per shot.
4. The user can revise individual frames. Only after unified image approval compile `video-prompt-v1`.
5. Each video shot uses its same-number approved storyboard image as the first composition/action reference and all selected character images as identity references.
6. The user chooses Novvy MCP or ImaRouter. Shots are generated and reviewed independently, then combined. The approved final card is appended deterministically after content shots.

## Candidate contract

Every candidate includes an overall narrative line, emotional continuation, one truthful core product verb, and at most three shots. Every shot specifies duration, narrative function, start/peak/result/reaction states, framing/camera/movement, performance, continuity holds, product action, transition, sound, English dialogue/on-screen text, reference bindings, and final-card handoff. Deliver a stage success followed by an unresolved dramatic or product hook.

Do not create a `video_prompt` when only the text storyboard is selected. Static frames must be generated and approved first.

## Static-frame prompt

Bind exact character identities and shot composition, camera angle, spatial layout, pose, action, object positions, lighting, palette, and continuity. Generate one clean 9:16 frame—not a collage, contact sheet, captioned board, UI mockup, or image containing shot labels/subtitles/watermarks.

## Video-task contract

Use [references/storyboard-video-contract.schema.json](references/storyboard-video-contract.schema.json). Keep shot ID/order stable. Chinese review text and English submission text must be equivalent. Each task describes only its content shot; do not ask the video model to recreate the final card.

## Validation

Reject a candidate when a shot lacks readable action/result, motivated audiovisual plan, source/reference binding, continuity state, or transition. Reject a final prompt when task number/order differs from approved storyboard images.
