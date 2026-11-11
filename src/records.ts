// Each routed run's level, kept in the session: a version 2 run on smart-router/auto that an input
// planned leaves one `smart-router.level` custom entry when it settles, none when its plan no longer
// applied at its first request (route.ts, takePlan), and /smart-router was appends a correction of
// the latest run, which is a label only: nothing is sent again. A record holds no prompt text and
// no digest of it; the user message sits just before it in the same session, which is where a
// training review reads both, on the host that made them.
//
// Also the words the footer and history use for a run's level: its scope, its tier, and what
// decided it.
import type { RiskyTrigger, Signal } from "./classify.ts";
import { LEVEL_ENTRY } from "./constants.ts";
import type { LevelSource, PlanLevel } from "./decide.ts";
import { isRecord, own } from "./files.ts";
import type { JevFailure } from "./jev.ts";
import type { PendingLevel } from "./route.ts";
import { isScope } from "./roster.ts";
import type { Scope } from "./roster.ts";
import { isTier, tierLabel } from "./tiers.ts";
import type { Tier } from "./tiers.ts";

/** Jev's part in a record: its answer, its failure, or, for a tagged run, that its opinion had not come when the run settled. */
export type JevRecord =
  | {
      readonly model: string;
      /** The tier Jev chose, before the close-call rule. */
      readonly choice: Tier;
      readonly probabilities: Readonly<Record<Tier, number>>;
      readonly confidence: number;
      readonly ms: number;
    }
  | { readonly model: string; readonly failure: JevFailure; readonly ms: number }
  | { readonly late: true };

/** One `smart-router.level` entry: a run's level, or a correction of one. Never prompt text. */
export interface LevelRecord {
  readonly v: 1;
  /** When the run was planned, or the correction made, in milliseconds since the epoch. */
  readonly at: number;
  readonly scope: Scope;
  readonly source: LevelSource | "correction";
  /** The tier the run went to, or the one a correction says it should have gone to. */
  readonly tier: Tier;
  /** The tier the tag, Jev or the keywords asked for, before the floor, the hold rules and any step-up. */
  readonly asked?: Tier;
  /** A tagged run's tag. */
  readonly tag?: Tier;
  /** The risky operation that raised the run to the floor. */
  readonly trigger?: RiskyTrigger;
  /** The keyword classifier's signal and reason for the message. */
  readonly keyword?: { readonly signal: Signal; readonly reason: string };
  /** Absent when Jev was not asked for the run. */
  readonly jev?: JevRecord;
  /**
   * The model of the run's last assistant message that ended without an error, whichever route or
   * selection sent it; absent when no model answered, as for a run refused or ended on an error.
   */
  readonly ref?: string;
  /** The run went to a higher tier than the one its pick started at. */
  readonly steppedUp?: true;
  /** The run went back to an earlier candidate than the model that answered last, at the cost of a prompt-cache miss. */
  readonly returnedToFirst?: true;
  readonly aborted?: true;
  /** A correction's: the `at` of the run it corrects. */
  readonly refers?: number;
}

function jevRecord(jev: PendingLevel["jev"]): JevRecord | undefined {
  if (jev === undefined) return undefined;
  if (jev === "pending") return { late: true };
  if (jev.kind === "failure") return { model: jev.model, failure: jev.failure, ms: jev.ms };
  return { model: jev.model, choice: jev.choice, probabilities: { ...jev.probabilities }, confidence: jev.confidence, ms: jev.ms };
}

/** A settled run's record, from the level its input planned. Neither the digest nor anything else of the text goes in. */
export function levelRecord(pending: PendingLevel, answeringRef: string | undefined, aborted: boolean): LevelRecord {
  const { level, keyword } = pending;
  const jev = jevRecord(pending.jev);
  return {
    v: 1,
    at: pending.at,
    scope: level.scope,
    source: level.source,
    tier: level.tier,
    asked: level.asked,
    ...(level.source === "tag" ? { tag: level.asked } : {}),
    ...(level.trigger === undefined ? {} : { trigger: level.trigger }),
    keyword: { signal: keyword.signal, reason: keyword.reason },
    ...(jev === undefined ? {} : { jev }),
    ...(answeringRef === undefined ? {} : { ref: answeringRef }),
    ...(level.steppedUp ? { steppedUp: true as const } : {}),
    ...(level.returnedToFirst ? { returnedToFirst: true as const } : {}),
    ...(aborted ? { aborted: true as const } : {}),
  };
}

/** A correction of the latest record's run. A correction of a correction corrects the run that one named. */
export function correctionRecord(previous: LevelRecord, tier: Tier, at: number): LevelRecord {
  const refers = previous.source === "correction" && previous.refers !== undefined ? previous.refers : previous.at;
  return { v: 1, at, scope: previous.scope, source: "correction", tier, refers };
}

const SOURCES: ReadonlySet<string> = new Set<LevelRecord["source"]>(["tag", "jev", "keyword", "floor", "correction"]);

const isSource = (value: unknown): value is LevelRecord["source"] => typeof value === "string" && SOURCES.has(value);
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * What a correction reads of a level entry: its time, scope, source and tier, and a correction's
 * `refers`, as the router writes them. Undefined for anything else, a custom_message of the type
 * included.
 */
export function readLevelRecord(entry: unknown): LevelRecord | undefined {
  if (!isRecord(entry) || own(entry, "type") !== "custom" || own(entry, "customType") !== LEVEL_ENTRY) return undefined;
  const data = own(entry, "data");
  if (!isRecord(data) || own(data, "v") !== 1) return undefined;
  const at = own(data, "at");
  const scope = own(data, "scope");
  const source = own(data, "source");
  const tier = own(data, "tier");
  if (!isTime(at) || !isScope(scope) || !isSource(source) || !isTier(tier)) return undefined;
  if (source !== "correction") return { v: 1, at, scope, source, tier };
  const refers = own(data, "refers");
  return isTime(refers) ? { v: 1, at, scope, source, tier, refers } : undefined;
}

/**
 * What decided a run's tier, in a few words: Jev with the probability it gave its tier, a tag, the
 * floor, or the keywords and why Jev did not decide. A hold or a step-up can take the run to another
 * tier than Jev's, and the note then names Jev's, so its probability is never read as the run's.
 */
export function levelNote(level: PlanLevel): string {
  const { jev } = level;
  switch (level.source) {
    case "tag":
      return "tag";
    case "floor":
      return "floor";
    case "jev": {
      if (jev?.kind !== "answer") return "jev";
      const share = `${Math.round(jev.probabilities[jev.tier] * 100)}%`;
      return jev.tier === level.tier ? `jev ${share}` : `jev ${tierLabel(jev.tier)} ${share}`;
    }
    case "keyword":
      return jev?.kind === "failure" ? `keywords; jev ${jev.failure}` : "keywords";
  }
}

/** The footer's item for a run: its scope, its tier, the model, and what decided the tier. */
export function footerText(level: PlanLevel, modelId: string): string {
  return `${level.scope} ${tierLabel(level.tier)} → ${modelId} (${levelNote(level)})`;
}
