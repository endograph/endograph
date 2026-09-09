import { Database } from "bun:sqlite";

/** Read-only resume check after the worker has recovered the frame store.
 * Executor enqueueFrame calls stage outputs; only the machine's later commit
 * establishes that they survived. Native session metadata cannot decide this.
 */
export function hasCommittedActivation(path: string, activationId: string): boolean {
  const db = new Database(path, { readonly: true });
  try {
    return !!db.query(`SELECT 1 FROM frames, json_each(frames.payload, '$.messages') AS message
      WHERE frames.type IN ('completion', 'activation')
      AND json_extract(message.value, '$.type') = 'work'
      AND json_extract(message.value, '$.kind') = 'completion'
      AND json_extract(message.value, '$.activationId') = ?
      AND json_extract(message.value, '$.reason') NOT IN ('cancelled', 'error', 'absorbed', 'suppressed') LIMIT 1`).get(activationId);
  } finally { db.close(); }
}
