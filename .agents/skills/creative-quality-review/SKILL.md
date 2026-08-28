---
name: creative-quality-review
description: Review short-drama contextual-ad concepts, audiovisual plans, storyboards, images, prompts, and final media against a project-local evidence-based quality matrix. Use for quality scoring, continuity checks, product-truth checks, issue lists, approval readiness, or identifying why a creative result is weak. Keep hard gates separate from creative ranking.
---

# Creative Quality Review

Review the current artifact against evidence, not taste alone. The canonical local matrix is [references/quality-matrix.v2.json](references/quality-matrix.v2.json); load only records relevant to the requested stage or named field.

## Two-axis decision

1. Evaluate hard gates (`QB`) first. Rights, product truth, identity, continuity, routing, unsafe or false claims, unusable text, and missing required evidence can block delivery.
2. Evaluate creative quality (`CQ`) separately: `CQ-0 Block`, `CQ-1 Test`, `CQ-2 Scale`, or `CQ-3 Template`.

CTR, CVR, or aesthetic preference cannot override a hard gate.

## Review procedure

- Identify stage and artifact type.
- Bind factual claims to source path, URL, screenshot/timecode, or approved card.
- Select only relevant matrix records by `record_id`, module, or field name.
- For each issue record severity, evidence, violated check/constraint, owner, correction, and reopen condition.
- Use `unknown` when evidence is absent and `blocked` when missing evidence prevents a required decision.
- Reopen dependent approvals after a source asset, prompt, URL, file hash, or approved payload changes.

Read [references/review-gates.md](references/review-gates.md) for the compact gate set.

## Output

Return `issue_id | stage | severity | QB/CQ | matrix_record | evidence | finding | correction | status | next approval`, followed by overall hard-gate result, CQ level, strongest quality, highest risk, and exact next action. Do not silently rewrite the artifact during a review-only request.

## Matrix provenance

The imported source contains 129 quality records and 60 unique directors (45 complete, 15 partial). It preserves 61 director source rows with one duplicate and a claim gap of five against a stated total of 65. Partial director records may use only supplied fields; `not_provided` fields must not be guessed. Some normalized rows contain derived constraints added during repair; treat `source_raw` as source evidence and `normalization_note` as derived-policy provenance.

## Contextual Studio profile

Do not impose the external matrix's single-video budget on ordinary project runs. Contextual Studio supports approved static storyboard frames, up to three separately generated video shots, per-shot review/regeneration, Novvy MCP or ImaRouter, and deterministic final-card concatenation. Apply `single_final_video_pass` only when explicitly selected.
