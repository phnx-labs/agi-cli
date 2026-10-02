- **Editor terminals follow the current agent session after a restart (PHNX-4218).**
  Active/watch rows adopt the live agent descendant's recorded session, transcript,
  terminal ID and launch ID while keeping the tab's shell PID and metadata. Only the
  nearest recorded agents qualify, so nested agents cannot take over the tab. The most
  recent recorded start wins at that depth, with PID as a stable tie-breaker; known
  tab kinds must match. Windows retains the published identity until process starts
  can be verified. Published terminal IDs
  also survive when no descendant supplies one. Rows expose a display-only `accountLabel`
  when the indexed account identifies one registered native slot; ambiguous identities
  stay unlabeled, and org-only keys require a matching email.
