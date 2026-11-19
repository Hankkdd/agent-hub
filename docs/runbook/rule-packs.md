# Repository rule packs

Operators maintain packs in `<dataDir>/rules/<tag>.md`, next to `repos.json`, outside
repositories. Never copy private operator rules into this repository.

An invented pack, `sample-checks.md`:

```markdown
---
tag: sample-checks
params: [docsRoot]
roles: [author, reviewer, planner]
source: invented documentation example
---

# Sample checks

Documentation lives at {docsRoot}.

## Mandatory

- **sc-1 Explain behavior**: Describe changed behavior in {docsRoot}.

## Reference

Examples and background belong here and are never injected.
```

Select packs per repository in `<dataDir>/repos.json`:

```json
{
  "/absolute/path/to/repository": {
    "rules": { "sample-checks": { "docsRoot": "/absolute/path/to/docs" } }
  }
}
```

Tags match `^[a-z][a-z0-9-]*$`; parameter names match `^[A-Za-z][A-Za-z0-9]*$`.
Frontmatter requires a matching `tag`, an inline `params` list (possibly `[]`), and
an inline nonempty `roles` list drawn from `author`, `reviewer`, `planner`.
Other frontmatter keys are ignored. Every declared parameter must be supplied;
extra parameters are rejected. Values must be nonempty single-line strings without
CR, LF or NUL, at most 500 characters. Only declared `{param}` tokens are replaced;
other brace expressions remain literal. Rule IDs are conventions, not parsed pack metadata.

The Hub injects the title, intro before the first level-two heading, and sections
headed `## Mandatory` or `## 必守`. Reference sections (`## Reference` or `## 參考`)
and other sections are excluded. A pack without mandatory sections is valid and
listed as applied, but injects nothing. Keep Markdown headings outside code fences.

Settings reads validate only the shape of `rules`: tag names, parameter objects,
and nonempty single-line string values of at most 500 characters. They never read
pack files. A broken pack does not block settings reads or chat tasks, nor tasks
for other repositories. Missing or undeclared parameters are checked against the
selected pack's frontmatter only when a coding or planning task is created.

For plan, implement and review tasks, only the selected repository's packs are
read, validated and resolved before the task is created, sorted by tag, and saved
as immutable task options with their raw
file SHA-256, roles and resolved text. Missing files, invalid metadata or parameters
reject creation for that repository with HTTP 400, without creating a task. Editing
a pack affects new tasks only: existing tasks, including resumed tasks after
restart, use their snapshot. Chat and video receive
no rule snapshots or injected rules. The task header shows tags and seven-character
hashes so operators can identify the applied versions.

Reviewers check rules that can be judged from the diff. Findings may include an
optional rule ID matching `^[a-z][a-z0-9]*-\d+$`:

```text
- [medium] [sc-1] docs/example.md:12 - Describe the changed behavior.
```

Process rules that cannot be judged from a diff are not findings. A rule finding
requires changes only when an acceptance criterion is broken or the diff clearly
violates the rule; otherwise the reviewer leaves the verdict unchanged.
