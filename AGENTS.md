# Contextual Studio agent guidance

## Project-local skills

This repository vendors the skills required by its Codex SDK workflows under `.agents/skills/`.

- Short-drama analysis: `.agents/skills/analyze-short-drama/SKILL.md`
- Game store analysis: `.agents/skills/analyze-game-store-page/SKILL.md`
- Novvy creative workflow: `.agents/skills/novvy-ad-creative/SKILL.md`

When a project prompt invokes `$analyze-short-drama`, `$analyze-game-store-page`, or `$novvy-ad-creative`, use the project-local copy. Do not substitute a similarly named personal skill or plugin-cache copy.

Treat these directories as vendored project dependencies. Update them deliberately from their upstream source and review the diff before changing production behavior.

## Local-first skill policy

Every skill used by this product's runtime workflows must live in this repository under `.agents/skills/` and be versioned together with the application.

- Skills from `~/.codex/skills/`, plugin caches, or other repositories are references only. Never make a production workflow depend directly on those copies.
- Before introducing an external skill into a product workflow, copy or adapt it into `.agents/skills/<skill-name>/`, then review and test the project-local version.
- Make product-specific prompt, schema, script, asset, and workflow improvements only in the project-local skill unless the user explicitly requests an upstream change as well.
- Codex SDK prompts must invoke the project-local skill name and must not rely on an external skill's absolute filesystem path.
- Keep each local skill self-contained: include the required `SKILL.md`, referenced scripts, templates, assets, and narrowly required documentation.
- When an external reference is updated, compare it with the local skill and selectively port useful changes. Do not overwrite project-specific behavior automatically.
- New skills created for Contextual Studio must be created in `.agents/skills/` first.
