---
kind: plan
title: PHNX-3229 — Repository-root cleanup
status: In progress
summary: Consolidate product media under assets, retire stale root documents, and make the installed system repository canonical for agent skills.
links:
  - label: Linear PHNX-3229
    url: https://linear.app/phoenixlabs/issue/PHNX-3229
---

# Repository-root cleanup

## Outcome

The repository root contains only product entry points and monorepo components. Product-owned promotional source lives with product assets; agent resources come from the system DotAgents repository instead of being duplicated in this product repository.

## Before and after

```text
BEFORE                              AFTER
agents-cli/                         agents-cli/
├── assets/                         ├── assets/
├── demo/                           │   └── demo/        Remotion source
├── openspec/                       ├── cli/
├── skills/                         │   └── docs/
├── agents.yaml                     │       └── security.md
├── SECURITY.md                     ├── packages/
└── NPM_CONSOLIDATION.md            └── .agents/plans/

agents-cli/skills/workflows ───────▶ phnx-labs/.agents-system/skills/workflows
seven older skill copies ──────────▶ removed; system versions remain canonical
```

## Delivery

1. Add the missing `workflows` skill to `phnx-labs/.agents-system`, update its human catalog and changelog, and verify the resource contract.
2. Move `demo/` to `assets/demo/`; remove the empty project pin, stale OpenSpec document, obsolete one-off npm note, and project skill duplicates.
3. Move security reporting guidance to `cli/docs/security.md`, correct stale component paths, and update every repository reference and CI ownership mapping.
4. Run focused repository checks, open both linked PRs, obtain a non-author verdict, merge on green, and verify the system skill is available after sync.

## Decisions

- Keep `assets/` at the product root. These files are README/design/demo product inputs, while `.agents/` is reserved for agent-authored plans, reports, scratch, and worktrees.
- Keep `packages/`. It is the conventional monorepo home for the session tracker and deprecated compatibility packages.
- Retire `NPM_CONSOLIDATION.md` instead of moving it. The alias packages already state their deprecation and the document is a completed one-off operator instruction, not durable architecture.
- Do not copy older project skill text into the system repository. The installed system versions already cover the current command surfaces; only `workflows` is absent.

## Tracking

- Linear: PHNX-3229
- agents-cli PR: pending
- phnx-labs/.agents-system PR: pending
