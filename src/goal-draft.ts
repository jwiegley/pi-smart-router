// The branch-local lifecycle entry written by pi-goal-x. Its seed is deliberately not read.
import { isRecord, own } from "./files.ts";
import { boundedHistory } from "./route.ts";

export function activeGoalDraft(sessionManager: unknown): string | undefined {
  try {
    const entry = boundedHistory(sessionManager)?.getLatestCustomEntry("pi-goal-draft", { scope: "active" });
    if (!isRecord(entry) || own(entry, "type") !== "custom" || own(entry, "customType") !== "pi-goal-draft") return undefined;
    const data = own(entry, "data");
    if (!isRecord(data) || own(data, "version") !== 1 || own(data, "clearedAt") !== undefined) return undefined;
    const mode = own(data, "mode");
    const startedAt = own(data, "startedAt");
    return (mode === "goal" || mode === "sisyphus") && typeof startedAt === "string" && startedAt !== "" ? `${mode}:${startedAt}` : undefined;
  } catch {
    return undefined;
  }
}
