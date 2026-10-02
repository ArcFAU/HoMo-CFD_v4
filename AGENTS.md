# Contributor instructions

Before changing this project, read `CHAT_HISTORY.md`, `SHARED_CONTEXT.md`, and `STATUS.md`.

## Required conversation log

Every human or AI contributor must append to `CHAT_HISTORY.md` for each work task. Do this before considering the task complete:

1. Record the user's request and any clarifications verbatim.
2. Record the contributor's user-visible responses verbatim, including the final response.
3. Add a concise work record with changed files, important decisions, and checks/results.
4. Append a new dated entry; never replace, rewrite, or silently summarize an existing entry.

Log only conversation content visible to the user. Do not include hidden reasoning, credentials, tokens, or other secrets. If a complete earlier transcript is unavailable, say so and link to the existing project notes instead of inventing verbatim history.

## Completion rule

Do not finish a project task without updating `CHAT_HISTORY.md`. If an environment or permission prevents updating it, tell the user explicitly and provide the exact content they should append.