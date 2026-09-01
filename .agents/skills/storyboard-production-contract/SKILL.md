---
name: storyboard-production-contract
description: Compile an approved short-drama contextual-ad concept and reference set into structured text storyboards, static storyboard-image prompts, and per-shot video tasks for Contextual Studio. Use when generating or revising storyboard candidates, validating shot completeness, creating storyboard images, or compiling the final video prompt. Do not submit media generation by itself.
---

# Storyboard Production Contract

Convert approved intent into a small, auditable shot plan. Use `$audiovisual-language-design` for shot parameters and `$creative-quality-review` before approval.

## Contextual Studio stages

1. After selected character references are confirmed, create and approve a final-card direction, then approve the audiovisual direction before creating three text candidates `storyboard-A/B/C` in the same Codex session.
2. Each candidate contains an overall story and at most three content shots.
3. The user selects one candidate; GPT-image-2 generates one 9:16 static frame per shot.
4. The user can revise individual frames. After unified image approval, use the last frame to calibrate and generate the real final-card image; only after that image is approved compile `video-prompt-v1`.
5. Each video shot uses its same-number approved storyboard image as the first composition/action reference and all selected character images as identity references.
6. The user chooses Novvy MCP or ImaRouter. Shots are generated and reviewed independently, then combined. The approved final card is appended deterministically after content shots.

## Candidate contract

Every candidate includes an overall narrative line, emotional continuation, one truthful core product verb, and at most three shots. Every shot specifies duration, narrative function, start/peak/result/reaction states, framing/camera/movement, performance, continuity holds, product action, transition, sound, English dialogue/on-screen text, reference bindings, and final-card handoff. Deliver a stage success followed by an unresolved dramatic or product hook.

Do not create a `video_prompt` when only the text storyboard is selected. Static frames must be generated and approved first.

Apply this visible causal chain to every shot or state:

`character_or_user_input -> physical_world_action -> physical_world_result -> ui_feedback -> character_reaction -> larger_hook`

UI success, narration, or celebration cannot replace the physical result. The reaction must occur after the character can perceive that result.

## Static-frame prompt

Bind exact character identities and shot composition, camera angle, spatial layout, pose, action, object positions, lighting, palette, and continuity. Generate one clean 9:16 frame—not a collage, contact sheet, captioned board, UI mockup, or image containing shot labels/subtitles/watermarks.

Before unified approval, the static frames together must cover the source handoff, first complete operation, escalation when present, stage success, reaction, larger hook, and risky transition boundaries. Use `references/image-preflight-contract.md` for the compact Contextual Studio adaptation of the Suite's image preflight gates.

## Video-task contract

Use [references/storyboard-video-contract.schema.json](references/storyboard-video-contract.schema.json). Keep shot ID/order stable. Chinese review text and English submission text must be equivalent. Each task describes only its content shot; do not ask the video model to recreate the final card.

For richer persisted handoffs, use only the relevant local schemas:

- `references/reference-manifest.schema.json` for evidence/reference purpose and permission boundaries.
- `references/dialogue-performance-manifest.schema.json` for speaker, addressee, why-now, gaze, gesture, blocking, breathing, stress, and fourth-wall rules.
- `references/creative-production-dossier.schema.json` for a generated review view; it must never become a second manually edited source of truth.
- `references/visual-handoff-package.schema.json` for approved frame lineage and video readiness. Contextual Studio may keep remote provider URLs; only fields backed by real local files may claim a local hash.

## Validation

Reject a candidate when a shot lacks readable action/result, motivated audiovisual plan, source/reference binding, continuity state, or transition. Reject a final prompt when task number/order differs from approved storyboard images.
