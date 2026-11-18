// A run's level, kept in the session: a run that still holds a level when it settles leaves one
// `smart-router.level` custom entry, and a level the router dropped before then is not recorded
// (router.ts, settle; route.ts, takePlan). /smart-router was appends a correction of the run in
// flight, when that run holds a level, or else of the run of the latest record, which is a label
// only: nothing is sent again. A record holds no prompt text and no digest of it; its run's first
// user message sits earlier in the same session, which is where a training review reads both, on
// the host that made them.
//
// Also the words the footer and history use for a run's level: its scope, its level, what decided
// it and what the cost rule compared; and the terms behind it, which /smart-router status shows.
import type { RiskyTrigger, Signal } from "./classify.ts";
import { LEVEL_ENTRY } from "./constants.ts";
import type { CostTerms, LevelSource, PlanLevel } from "./decide.ts";
import type { Demand } from "./demand.ts";
import { isRecord, own } from "./files.ts";
import type { JevFailure } from "./jev.ts";
import type { PendingLevel } from "./route.ts";
import { isScope, parseRef } from "./roster.ts";
import type { Scope } from "./roster.ts";
import { isTier, tierLabel, tierRank } from "./tiers.ts";
import type { Tier } from "./tiers.ts";

/** Jev's part in a record: its answer, its failure, or, for a tagged run, that its opinion had not come when the run settled. */
export type JevRecord =
  | {
      readonly model: string;
      /** Jev's top choice. */
      readonly choice: Tier;
      readonly probabilities: Readonly<Record<Tier, number>>;
      readonly confidence: number;
      readonly ms: number;
    }
  | { readonly model: string; readonly failure: JevFailure; readonly ms: number }
  | { readonly late: true };

/** What the cost rule decided for a run, as its record keeps it: model refs, numbers, level names and outcome names. */
export type CostRecord =
  | { readonly outcome: "unknown"; readonly why: string }
  | {
      readonly outcome: "stayed" | "moved" | "only";
      readonly chosen: string;
      /** The model that answered last, when it was a candidate. */
      readonly current?: string;
      /** The run's expected requests, before the horizon. */
      readonly requests: number;
      readonly horizon: number;
      /** The chance the current model's level is needed again. */
      readonly again: number;
      /** One row per candidate, lowest level first: its expected cost, leaving included, and what it had cached. */
      readonly candidates: ReadonlyArray<{
        readonly ref: string;
        readonly tier: Tier;
        readonly cost: number;
        readonly leaving: number;
        readonly cached: number;
        readonly survival: number;
        readonly compacts: boolean;
      }>;
    };

/** One `smart-router.level` entry: a run's level, or a correction of one. Never prompt text. */
export interface LevelRecord {
  readonly v: 1;
  /** When the run was planned, or the correction made, in milliseconds since the epoch. */
  readonly at: number;
  readonly scope: Scope;
  /** What decided the run's level, or that the record is a correction. `keyword`: an earlier version's run that the keywords decided. */
  readonly source: LevelSource | "keyword" | "correction";
  /** The tier planned for the run, or the one a correction says it should have gone to. */
  readonly tier: Tier;
  /**
   * The level the run needed: its tag's, else its demand's after the guards. Read back from an
   * earlier version's record, which wrote `asked` instead, it is the record's `tier`.
   */
  readonly need?: Tier;
  /** A tagged run's tag. */
  readonly tag?: Tier;
  /** The risky operation that raised the run to HIGH. */
  readonly trigger?: RiskyTrigger;
  /** An untagged run's demand: numbers, level names, signal names and guard names, never text. */
  readonly demand?: Demand;
  /** The keyword classifier's signal and reason for the message. */
  readonly keyword?: { readonly signal: Signal; readonly reason: string };
  /** Absent when Jev was not asked for the run. */
  readonly jev?: JevRecord;
  /** What the cost rule decided; absent for a run it did not price (a tagged one, or one on the scope's chain or stepped up). */
  readonly cost?: CostRecord;
  /**
   * The model of the run's last assistant message that ended without an error, whichever route or
   * selection sent it; absent when no model answered, as for a run refused or ended on an error.
   */
  readonly ref?: string;
  /** The run went to a higher tier than the one its pick started at. */
  readonly steppedUp?: true;
  /** The run went back to an earlier candidate than the model that answered last, at the cost of a prompt-cache miss. */
  readonly returnedToFirst?: true;
  /** The model that answered is one of the scope's fallback chain, not one of the tier's own; `tier` is still the run's. */
  readonly fallback?: true;
  readonly aborted?: true;
  /** A correction's: the `at` of the run it corrects. */
  readonly refers?: number;
}

function costRecord(cost: CostTerms | undefined): CostRecord | undefined {
  if (cost === undefined) return undefined;
  if (cost.outcome === "unknown") return { outcome: "unknown", why: cost.why };
  return {
    outcome: cost.outcome,
    chosen: cost.chosen,
    ...(cost.current === undefined ? {} : { current: cost.current }),
    requests: cost.workload.requests,
    horizon: cost.workload.horizon,
    again: cost.again,
    candidates: cost.priced.map(({ ref, tier, cost: dollars, leaving, cached, survival, compacts }) => ({ ref, tier, cost: dollars, leaving, cached, survival, compacts })),
  };
}

function jevRecord(jev: PendingLevel["jev"]): JevRecord | undefined {
  if (jev === undefined) return undefined;
  if (jev === "pending") return { late: true };
  if (jev.kind === "failure") return { model: jev.model, failure: jev.failure, ms: jev.ms };
  return { model: jev.model, choice: jev.choice, probabilities: { ...jev.probabilities }, confidence: jev.confidence, ms: jev.ms };
}

/**
 * A settled run's record, from the level its input planned. Neither the digest nor anything else of
 * the text goes in. `fallback`: whether the answering model is one of the scope's fallback chain.
 */
export function levelRecord(pending: PendingLevel, answeringRef: string | undefined, aborted: boolean, fallback = false): LevelRecord {
  const { level, keyword } = pending;
  const jev = jevRecord(pending.jev);
  const cost = costRecord(level.cost);
  return {
    v: 1,
    at: pending.at,
    scope: level.scope,
    source: level.source,
    tier: level.tier,
    need: level.need,
    ...(level.source === "tag" ? { tag: level.need } : {}),
    ...(level.trigger === undefined ? {} : { trigger: level.trigger }),
    ...(level.demand === undefined ? {} : { demand: level.demand }),
    keyword: { signal: keyword.signal, reason: keyword.reason },
    ...(jev === undefined ? {} : { jev }),
    ...(cost === undefined ? {} : { cost }),
    ...(answeringRef === undefined ? {} : { ref: answeringRef }),
    ...(level.steppedUp ? { steppedUp: true as const } : {}),
    ...(level.returnedToFirst ? { returnedToFirst: true as const } : {}),
    ...(fallback ? { fallback: true as const } : {}),
    ...(aborted ? { aborted: true as const } : {}),
  };
}

/** A correction of the latest record's run. A correction of a correction corrects the run that one named. */
export function correctionRecord(previous: LevelRecord, tier: Tier, at: number): LevelRecord {
  const refers = previous.source === "correction" && previous.refers !== undefined ? previous.refers : previous.at;
  return { v: 1, at, scope: previous.scope, source: "correction", tier, refers };
}

const SOURCES: ReadonlySet<string> = new Set<LevelRecord["source"]>(["tag", "jev", "heuristics", "floor", "keyword", "correction"]);

const isSource = (value: unknown): value is LevelRecord["source"] => typeof value === "string" && SOURCES.has(value);
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * What a correction or a resumed session reads of a level entry: its time, scope, source and tier, a
 * run's need and a correction's `refers`, as this version or an earlier one wrote them. An earlier
 * version's run has `source: "keyword"` or `asked` and no `need`: its need is its tier. Undefined for
 * anything else, a custom_message of the type included.
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
  if (source !== "correction") {
    const need = own(data, "need");
    if (need === undefined) return { v: 1, at, scope, source, tier, need: tier };
    return isTier(need) ? { v: 1, at, scope, source, tier, need } : undefined;
  }
  const refers = own(data, "refers");
  return isTime(refers) ? { v: 1, at, scope, source, tier, refers } : undefined;
}

/** Dollars, to the cent. */
const money = (value: number): string => `$${value.toFixed(2)}`;

/** A whole number with a comma between each group of three digits. */
const thousands = (value: number): string => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** A model's id, without its provider. */
const modelId = (ref: string): string => parseRef(ref)?.id ?? ref;

/**
 * What the cost rule compared, after the demand: "; stayed, $0.10 vs $0.16" (the current model
 * against the cheapest other), "; moved, $0.63 vs $2.00" (the chosen model against the current one),
 * "; cost unknown", or nothing: for a run it did not price, one with no current model among the
 * candidates, and one that stayed where there was no other.
 */
export function costNote(cost: CostTerms | undefined): string {
  if (cost === undefined) return "";
  if (cost.outcome === "unknown") return "; cost unknown";
  const current = cost.priced.find((entry) => entry.ref === cost.current);
  if (current === undefined) return "";
  if (cost.outcome === "moved") {
    const chosen = cost.priced.find((entry) => entry.ref === cost.chosen);
    return chosen === undefined ? "" : `; moved, ${money(chosen.cost)} vs ${money(current.cost)}`;
  }
  if (cost.outcome !== "stayed") return "";
  const others = cost.priced.filter((entry) => entry !== current).map((entry) => entry.cost);
  return others.length === 0 ? "" : `; stayed, ${money(current.cost)} vs ${money(Math.min(...others))}`;
}

/**
 * What decided a run's level, in a few words: "tag"; else its demand to one decimal, then
 * ", jev timeout" (or another failure) when Jev was asked and gave no answer, then ", floor" when a
 * floor raised the level, then what the cost rule compared (costNote).
 */
export function levelNote(level: PlanLevel): string {
  if (level.source === "tag") return "tag";
  const { jev, demand } = level;
  const decided = [
    demand === undefined ? "demand unknown" : `demand ${demand.value.toFixed(1)}`,
    ...(jev?.kind === "failure" ? [`jev ${jev.failure}`] : []),
    ...(level.source === "floor" ? ["floor"] : []),
  ].join(", ");
  return `${decided}${costNote(level.cost)}`;
}

/**
 * The terms behind an untagged level, for /smart-router status: the demand line (the blend, Jev's
 * term or why there was none, the heuristics with their three largest signals, and the floors that
 * applied), then, when the cost rule was asked, the cost line (the run priced, and each candidate,
 * the stronger first, with its expected cost, its cache and what leaving the current model adds),
 * or why the cost was unknown. A tagged level gives none.
 */
export function decisionLines(level: PlanLevel): string[] {
  const { demand, cost } = level;
  if (level.source === "tag" || demand === undefined) return [];
  const jev =
    demand.jev !== undefined
      ? `Jev ${demand.jev.value.toFixed(2)} at ${Math.round(demand.jev.confidence * 100)}%`
      : `no Jev answer${level.jev?.kind === "failure" ? ` (${level.jev.failure})` : ""}`;
  const top = demand.heuristics.top.map(([signal, share]) => `${signal} ${share.toFixed(2)}`).join(", ");
  const floors = demand.guards.filter((guard) => guard === "risky" || guard === "deep-session");
  const lines = [
    `  Demand ${demand.value.toFixed(2)} → ${tierLabel(level.need)}: ${jev}, heuristics ${demand.heuristics.value.toFixed(2)}${top === "" ? "" : ` (${top})`}${
      floors.length === 0 ? "" : `; floors: ${floors.join(", ")}`
    }.`,
  ];
  if (cost === undefined) return lines;
  if (cost.outcome === "unknown") return [...lines, `  Cost unknown: ${cost.why}.`];
  const { requests, horizon } = cost.workload;
  const count = Number.isInteger(requests) ? String(requests) : requests.toFixed(1);
  const leaving = cost.current === undefined ? "" : modelId(cost.current);
  const rows = [...cost.priced]
    .sort((a, b) => tierRank(b.tier) - tierRank(a.tier))
    .map((entry) => {
      const cached = entry.cached > 0 ? `${thousands(entry.cached)} cached, ${Math.round(entry.survival * 100)}%` : "nothing cached";
      const compacts = entry.compacts ? ", after a compaction" : "";
      const left = entry.leaving > 0 ? `; leaving ${leaving} ${money(entry.leaving)}` : "";
      return `${modelId(entry.ref)} ${money(entry.cost)} (${cached}${compacts}${left})`;
    });
  return [...lines, `  Cost of ${count} request${requests === 1 ? "" : "s"}, horizon ${horizon}: ${rows.join("; ")}.`];
}

/**
 * The footer's item for a run: its scope, the level it needs, the model, and what decided the
 * level. `fallback`: whether the model is one of the scope's fallback chain, as the plan's pick was
 * unless the caller knows the model that answered.
 */
export function footerText(level: PlanLevel, modelId: string, fallback: boolean = level.fallback === true): string {
  return `${level.scope} ${tierLabel(level.need)} → ${modelId} (${levelNote(level)}${fallback ? "; fallback" : ""})`;
}
