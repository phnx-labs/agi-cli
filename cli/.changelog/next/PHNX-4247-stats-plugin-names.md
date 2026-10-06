- **`agents sessions stats` ranks a plugin skill under the same name `--zero` lists it.**
  A plugin skill invoked by its bare name (`Skill image` from the `create` plugin) was
  recorded as `image`, while the installed inventory calls it `create:image`, so the
  same skill showed as invoked in the ranked list and as never invoked in `--zero`.
  Usage is now recorded as `<plugin>:<name>` when the plugin is known, and a `/name`
  slash invocation that only resolves to a skill counts as a skill. Existing bare
  rows are renamed when the index opens; run `agents sessions backfill resources` once
  to reclassify older slash-typed skills (the coverage line prompts for it). Source:
  `cli/src/lib/session/db.ts`.
