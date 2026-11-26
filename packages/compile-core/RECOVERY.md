# Recover a local output reservation

[Russian version](RECOVERY.ru.md)

The writer uses one trusted parent on one local filesystem. The destination is a direct child of that parent. Keep the parent stable while writers use it.

A reservation owns a sibling staging directory. The writer publishes one complete generation by rename. A retry succeeds when the output manifest and file inventory match the requested generation exactly.

After an interrupted writer, call `recoverOutput(destination, parent, currentBootId, isProcessAlive)`. Use the verified boot identity of the local host. The process probe MUST report uncertainty as live or throw. Recovery serializes reservation changes, checks the recorded owner, and removes only its orphaned staging and reservation. The committed destination remains intact.

A busy recovery guard, missing owner record or uncertain process identity requires operator inspection. Confirm the local process has stopped before clearing an orphaned guard using the trusted parent and exact reservation identity.
