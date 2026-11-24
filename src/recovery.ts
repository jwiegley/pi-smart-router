// Pi owns the recovery lifecycle. This module only offers a safe alternate for a transient outcome.
import type { Api, AssistantMessage, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRoute, ModelRouteReason } from "@earendil-works/pi-coding-agent";

import type { VirtualId } from "./constants.ts";
import { effortFor, eligibleRole, pickInRole } from "./decide.ts";
import type { TurnType } from "./effort.ts";
import { isDegenerateOutput } from "./output-quality.ts";
import { coolFrom, failureKind, refOf } from "./resolve.ts";
import type { ResolveContext } from "./resolve.ts";
import { assertSafe } from "./route.ts";

// These mirror the optional virtual-model recovery boundary in Pi. Older Pi versions ignore it.
export interface RecoveryAttempt {
  readonly model: { readonly provider: string; readonly id: string };
  readonly kind: "error" | "degenerate";
  readonly status?: number | undefined;
}
export interface RecoveryRequest {
  readonly model: Model<Api>;
  readonly physical: Model<Api>;
  readonly reason: Exclude<ModelRouteReason, "direct">;
  readonly thinkingLevel: ModelThinkingLevel;
  readonly message: AssistantMessage;
  readonly attempts: readonly RecoveryAttempt[];
  readonly signal?: AbortSignal | undefined;
}
export interface Recovery {
  readonly route: ModelRoute;
  readonly kind: "error" | "degenerate";
  readonly status?: number | undefined;
}

/** Errors about the conversation itself, which another model would get too: its size, or a thinking signature it carries. */
export const REQUEST_SIZED = /thought[_ -]?signature|context[ _-]?(?:window|length|overflow)|maximum context|prompt (?:is )?too long|too many (?:input )?tokens/i;

/** Read an HTTP status only from a status prefix or a structured provider error. */
export function recoveryStatus(text: string | undefined): number | undefined {
  const head = (text ?? "").slice(0, 8192).trim();
  const prefix = /^(?:(?:http|error|status(?: code)?)\s*:?\s*)?(\d{3})\b/i.exec(head);
  if (prefix !== null) return Number(prefix[1]);
  try {
    const value: unknown = JSON.parse(head);
    if (typeof value !== "object" || value === null) return undefined;
    const obj = value as Record<string, unknown>;
    const nested = typeof obj.error === "object" && obj.error !== null ? obj.error as Record<string, unknown> : undefined;
    for (const raw of [nested?.code, nested?.status, obj.code, obj.status]) {
      if ((typeof raw === "number" || typeof raw === "string") && /^\d{3}$/.test(String(raw))) return Number(raw);
    }
  } catch {
    // An unstructured error without a status prefix has no reliable status.
  }
  return undefined;
}

/** Offer only failures whose alternate does not undo the fork's existing account cooldown rules. */
export function recoveryChoice(input: {
  readonly id: VirtualId;
  readonly rc: ResolveContext;
  readonly request: RecoveryRequest;
  readonly skipped: ReadonlySet<string>;
  readonly turn: TurnType;
  readonly escalated: boolean;
}): Recovery | undefined {
  const { id, rc, request } = input;
  const { message } = request;
  const degenerate = isDegenerateOutput(message);
  const status = recoveryStatus(message.errorMessage);
  if (!degenerate) {
    const kind = message.stopReason === "error" ? failureKind(message.errorMessage) : "content-filter";
    // Content a model refused is never sent to another model.
    if (kind === "content-filter") return undefined;
    // A usage limit or a credential that was not accepted moves on as Pi's own retry of one does
    // (John, 2026-11-23): the model or its account is cooled first, so the pick passes it over.
    if (kind === "limit") coolFrom(message, rc.roster, rc.cooldowns, rc.now);
    else if (REQUEST_SIZED.test(message.errorMessage ?? "")) return undefined;
    else if (status === undefined || !(status >= 400 && status <= 599)) return undefined;
  }
  const ref = refOf(request.physical);
  const role = eligibleRole(rc, ref);
  if (role === undefined) return undefined;
  const skipped = new Set([...input.skipped, ref, ...request.attempts.map((attempt) => refOf(attempt.model))]);
  const decision = pickInRole(rc, role, { skipped, fallback: !rc.localOnly, strictHolds: true, code: "recovery" });
  if (!decision.ok) return undefined;
  assertSafe(id, rc, decision.choice);
  const effort = effortFor(rc, decision.choice.role, decision.choice.model, request.thinkingLevel, input.turn, input.escalated);
  return { route: { model: decision.choice.model, thinkingLevel: effort.level }, kind: degenerate ? "degenerate" : "error", ...(status === undefined ? {} : { status }) };
}
