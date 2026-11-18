/**
 * Whether General Auto can run, and what it would run without: decided from
 * each member's state (what it answered, and its switch), never from the
 * settings alone. Auto is never switched on with nothing ready behind it,
 * and what it leaves out is said, the leader included.
 */

/** A provider Auto includes, as it stands now. */
export interface AutoMember {
  readonly id: string;
  readonly name: string;
  /** available: usable now; anything else is why it is left out. */
  readonly state: "available" | "connected" | "configured" | "unavailable" | "error";
  readonly why: string;
}

export interface AutoVerdict {
  /** Auto may be switched on: at least one member is ready. */
  readonly allowed: boolean;
  readonly ready: readonly string[];
  /** Members left out, and why. */
  readonly out: readonly { readonly name: string; readonly why: string }[];
  /** What is wrong with the leader, when something is. */
  readonly leader?: string;
  /** What to say, in full. */
  readonly message: string;
}

const REASON: Readonly<Record<AutoMember["state"], string>> = {
  available: "ready",
  connected: "held back (it bills per token, not allowed)",
  configured: "not signed in",
  unavailable: "switched off or not reachable",
  error: "it failed to answer",
};

/** Whether Auto can run with these members and this leader ("provider/model"), and what to say. */
export function autoVerdict(members: readonly AutoMember[], leader?: string): AutoVerdict {
  if (members.length === 0) {
    return {
      allowed: false,
      ready: [],
      out: [],
      message:
        "Auto includes no provider yet: put the ones it may use in it (/providers, Space on Auto), then switch it on.",
    };
  }
  const ready = members.filter((m) => m.state === "available");
  const out = members
    .filter((m) => m.state !== "available")
    .map((m) => ({
      name: m.name,
      why: m.state === "unavailable" ? m.why || REASON.unavailable : REASON[m.state],
    }));
  const leaderProvider = leader?.split("/")[0];
  const leaderMember = leaderProvider ? members.find((m) => m.id === leaderProvider) : undefined;
  const leaderProblem =
    leader === undefined || leader === ""
      ? undefined
      : !leaderMember
        ? `The leader ${leader} is not in Auto: runs plan without a leader until its provider is in it.`
        : leaderMember.state !== "available"
          ? `The leader ${leader} is not ready (${REASON[leaderMember.state]}): runs plan without it until it is.`
          : undefined;
  const leftOut = out.map((o) => `${o.name}: ${o.why}`).join("; ");
  if (ready.length === 0) {
    return {
      allowed: false,
      ready: [],
      out,
      ...(leaderProblem ? { leader: leaderProblem } : {}),
      message: `Auto stays off: none of its providers is ready (${leftOut}). Switch one on or sign it in, or put a ready one in Auto (/providers).`,
    };
  }
  const message = [
    `General Auto: each message is triaged by a light model, answered directly or planned across ${String(ready.length)} ready provider${ready.length === 1 ? "" : "s"} (${ready.map((m) => m.name).join(", ")}).`,
    ...(out.length > 0 ? [`Left out for now: ${leftOut}.`] : []),
    ...(leaderProblem ? [leaderProblem] : []),
  ].join(" ");
  return {
    allowed: true,
    ready: ready.map((m) => m.id),
    out,
    ...(leaderProblem ? { leader: leaderProblem } : {}),
    message,
  };
}
