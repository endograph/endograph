import type { AgentDir } from "../agent/dir.ts";
import { localDate } from "../economy/budget.ts";
import { computeDigest, renderDigest } from "../economy/digest.ts";
import { openSqliteStore } from "../store/sqlite.ts";
import { allFrames } from "./shared.ts";

/** `endo digest [YYYY-MM-DD]` — the day's account, computed from the log. */
export async function cmdDigest(dir: AgentDir, date?: string): Promise<number> {
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("usage: endo digest [YYYY-MM-DD]");
  }
  const store = openSqliteStore(dir.dbPath);
  const digest = computeDigest(allFrames(store), date ?? localDate());
  store.close();
  console.log(renderDigest(digest));
  return 0;
}
