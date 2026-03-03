---
name: local-context-retriever
description: Retrieve focused project context from local markdown docs before planning/implementation/review. Use when preparing a task package for Claude Code to avoid missing project rules, known bugs, and architecture constraints.
---

# Local Context Retriever

Use this skill to assemble a compact, relevant context pack from local docs.

## Workflow

1. Identify task intent and scope (feature, bugfix, review, tests).
2. Search only local project docs (`docs/ai-orchestration`, project MDs, known-bugs notes).
3. Extract **top 3–7** most relevant snippets.
4. Return structured output:
   - `rules`
   - `constraints`
   - `known_risks`
   - `related_incidents`
   - `references`
5. Keep output concise; avoid dumping full files.

## Rules

- Prefer project-specific docs over generic guidance.
- If confidence is low, explicitly say what is missing.
- Do not invent rules.
- Keep payload compact for token efficiency.

## Script

Use `scripts/retrieve_context.py` to gather ranked snippets quickly.
