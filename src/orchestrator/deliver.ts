import type { OperationalStore } from "./store.js";
import type { WorktreeManager } from "./worktrees.js";

/** What became of a run's work and the user's branch (phase D6). */
export type Delivery =
  | {
      readonly status: "merged";
      readonly branch: string;
      readonly commit: string;
      readonly rollback: string;
    }
  | { readonly status: "already"; readonly branch: string }
  | { readonly status: "undone"; readonly branch: string; readonly reason: string }
  | {
      readonly status: "kept";
      readonly branch: string;
      readonly reason: string;
      readonly rollback: string;
    }
  | { readonly status: "conflict"; readonly branch: string; readonly files: readonly string[] }
  | { readonly status: "skipped"; readonly reason: string };

/** The checks run on the user's tree after the merge. */
export type DeliveryChecks = (root: string) => Promise<{ ok: boolean; diagnostic: string }>;

export interface DeliverOptions {
  readonly store: OperationalStore;
  readonly worktrees: WorktreeManager;
  readonly runId: string;
  readonly checks: DeliveryChecks;
}

/**
 * Merges a completed run's integration branch into the branch the user is
 * on (phase D6; the caller allows it only in the extended mode):
 *
 * - only on a branch, with a clean tree (nothing changed, staged or
 *   untracked), so nothing of the user's is mixed in or at risk;
 * - where the branch was is kept under the run's rollback ref first;
 * - the merge commit says where it came from (the run and its branch), and
 *   so does the run's store;
 * - the checks of the run's tasks run on the result; any failing undoes
 *   the merge (`reset --keep` to the rollback ref, never losing a change
 *   made meanwhile);
 * - recorded as an effect, so a restart neither merges twice nor leaves
 *   a merge unchecked;
 * - never pushed.
 */
export async function deliver(options: DeliverOptions): Promise<Delivery> {
  const { store, runId } = options;
  const result = await attempt(options);
  store.event(runId, "delivery", { ...result });
  return result;
}

async function attempt({ store, worktrees, runId, checks }: DeliverOptions): Promise<Delivery> {
  const from = worktrees.integrationBranch(runId);
  const tip = await worktrees.tip(runId);
  if (!tip) return { status: "skipped", reason: "the run changed nothing" };
  const branch = await worktrees.currentBranch();
  if (!branch) return { status: "skipped", reason: "HEAD is detached, not on a branch" };
  const key = `merge-user:${runId}`;
  const merged = await worktrees.contains(tip);

  // A merge made before a crash, whose checks never finished: checked now.
  const made = store
    .events(runId)
    .filter((e) => e.kind === "merged_user")
    .at(-1);
  if (merged && store.effectsInFlight(runId).includes(key) && made) {
    const commit = String(made.data.commit);
    return check({ store, worktrees, runId, checks }, key, branch, commit);
  }
  if (merged) {
    store.finishEffect(key);
    return { status: "already", branch };
  }

  // Changes in the user's tree are kept safe by git, which refuses a merge
  // that would overwrite them; staged ones would go into the merge commit.
  const staged = await worktrees.staged();
  if (staged.length > 0) {
    return {
      status: "skipped",
      reason: `your tree has ${String(staged.length)} file${staged.length === 1 ? "" : "s"} staged; commit or unstage ${staged.length === 1 ? "it" : "them"}, then merge ${from}`,
    };
  }

  store.beginEffect(key, runId, "merge-user", { branch, from });
  const run = store.run(runId);
  const title = (run?.plan.goal ?? run?.request ?? "").split("\n")[0]?.slice(0, 60) ?? "";
  const merge = await worktrees.mergeIntoCurrent(
    runId,
    `Merge ${from}${title ? `: ${title}` : ""}\n\nGrafeno-Run: ${runId}\nGrafeno-Branch: ${from}`,
  );
  if (merge.status !== "merged") {
    store.finishEffect(key);
    return merge.status === "conflict"
      ? { status: "conflict", branch, files: merge.files }
      : { status: "skipped", reason: `git refused the merge: ${merge.reason}` };
  }
  store.event(runId, "merged_user", {
    branch,
    from,
    commit: merge.commit,
    before: merge.before,
    rollback: worktrees.rollbackRef(runId),
  });
  return check({ store, worktrees, runId, checks }, key, branch, merge.commit);
}

async function check(
  { store, worktrees, runId, checks }: DeliverOptions,
  key: string,
  branch: string,
  commit: string,
): Promise<Delivery> {
  const rollback = worktrees.rollbackRef(runId);
  let verdict: { ok: boolean; diagnostic: string };
  try {
    verdict = await checks(worktrees.repo);
  } catch (error) {
    verdict = { ok: false, diagnostic: error instanceof Error ? error.message : String(error) };
  }
  if (verdict.ok) {
    store.finishEffect(key);
    return { status: "merged", branch, commit, rollback };
  }
  const why = await worktrees.undoMerge(runId, commit);
  store.finishEffect(key);
  const reason = `the checks failed on ${branch} after the merge:\n${verdict.diagnostic}`;
  return why === undefined
    ? { status: "undone", branch, reason }
    : {
        status: "kept",
        branch,
        rollback,
        reason: `${reason}\nIt could not be undone (${why}); undo it with: git reset --keep ${rollback}`,
      };
}

/** What happened to the user's branch, as lines for a person. */
export function describeDelivery(delivery: Delivery, from: string): string[] {
  switch (delivery.status) {
    case "merged":
      return [
        `\nMerged ${from} into ${delivery.branch} (${delivery.commit.slice(0, 8)}); the checks pass there. Nothing was pushed.`,
        `To undo it: git reset --keep ${delivery.rollback}`,
      ];
    case "already":
      return [`\n${from} is already in ${delivery.branch}.`];
    case "undone":
      return [
        `\nNot merged into ${delivery.branch}: ${delivery.reason}`,
        "Your branch is as it was.",
      ];
    case "kept":
      return [`\nMerged into ${delivery.branch}, but ${delivery.reason}`];
    case "conflict":
      return [
        `\nNot merged into ${delivery.branch}: it conflicts in ${delivery.files.join(", ")}. Your branch is as it was.`,
      ];
    case "skipped":
      return [`\nNot merged into your branch: ${delivery.reason}.`];
  }
}

/** What became of one task's work in the user's branch, delivered as soon as it was merged. */
export type PartDelivery =
  | { readonly status: "delivered"; readonly branch: string; readonly commit: string }
  | { readonly status: "already" }
  | { readonly status: "skipped"; readonly reason: string };

/**
 * Brings the integration branch, with the task just merged into it, into
 * the branch the user is on: the run's work lands in the project's folder
 * task by task, as each passes its checks, so the person sees it grow. A
 * merge commit per task says where it came from. The user's changes are
 * kept safe by git (a merge that would overwrite them is refused, and tried
 * again with the next task or at the end). The run's end checks everything
 * together (`deliver`), and undoes all of it if they fail. Never pushed.
 */
export async function deliverPart(
  options: Omit<DeliverOptions, "checks">,
  taskId: string,
): Promise<PartDelivery> {
  const { store, runId } = options;
  const result = await attemptPart(options, taskId);
  store.event(runId, "delivered_part", { ...result }, taskId);
  return result;
}

async function attemptPart(
  { worktrees, runId }: Omit<DeliverOptions, "checks">,
  taskId: string,
): Promise<PartDelivery> {
  const tip = await worktrees.tip(runId);
  if (!tip) return { status: "skipped", reason: "nothing merged yet" };
  const branch = await worktrees.currentBranch();
  if (!branch) return { status: "skipped", reason: "HEAD is detached, not on a branch" };
  if (await worktrees.contains(tip)) return { status: "already" };
  const staged = await worktrees.staged();
  if (staged.length > 0) {
    return { status: "skipped", reason: `${String(staged.length)} files are staged in your tree` };
  }
  const from = worktrees.integrationBranch(runId);
  const merge = await worktrees.mergeIntoCurrent(
    runId,
    `Merge ${taskId} from ${from}\n\nGrafeno-Run: ${runId}\nGrafeno-Task: ${taskId}`,
  );
  if (merge.status === "merged") return { status: "delivered", branch, commit: merge.commit };
  return merge.status === "conflict"
    ? { status: "skipped", reason: `it would conflict in ${merge.files.join(", ")}` }
    : { status: "skipped", reason: `git refused it: ${merge.reason.split("\n")[0] ?? ""}` };
}
