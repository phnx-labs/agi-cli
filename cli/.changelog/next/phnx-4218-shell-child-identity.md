- **Editor terminals follow the current agent session after a restart (PHNX-4218).**
  Active/watch rows adopt the live agent descendant's recorded session, transcript,
  terminal ID and launch ID while keeping the tab's shell PID and metadata. The most
  recent recorded start wins, with PID as a stable tie-breaker. Published terminal IDs
  also survive when no descendant supplies one. Rows expose a display-only `accountLabel`
  when the indexed account identifies one registered native slot; ambiguous identities
  stay unlabeled.
