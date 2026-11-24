// The branch-local lifecycle entry written by pi-goal-x. Its seed is deliberately not read.
import type { CompactionFigures, Decision, LastResponder } from "./decide.ts";
import { chooseModel, pickInRole } from "./decide.ts";
import { isRecord, own } from "./files.ts";
import type { ResolveContext } from "./resolve.ts";
import { boundedHistory } from "./route.ts";
import { scopeSection } from "./roster.ts";

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

/** Pick SUPER's role, including the scope's existing fallback chain. */
export function goalSuper(rc: ResolveContext, last: LastResponder | undefined, compaction: CompactionFigures): { readonly decision: Decision; readonly role: string } | undefined {
  if (rc.roster.version !== 2) return undefined;
  if (rc.localOnly) {
    const role = rc.roster.local?.levels?.super;
    if (typeof role !== "string") return undefined;
    return { role, decision: pickInRole(rc, role, { fallback: false, code: "goal" }) };
  }
  const section = scopeSection(rc.roster, rc.scope);
  if (section === undefined) return undefined;
  const role = section.levels.super.role;
  const { decision } = chooseModel({ rc, section, need: "super", code: "goal", last, promptTokens: 0, compaction, figures: undefined, priced: false, pinned: true });
  return { role, decision };
}
