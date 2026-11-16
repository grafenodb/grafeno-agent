# Routing: the minimum sufficient model

Asked by the user on 2026-11-16: runs kept choosing Astra 6 and Sol 6.1 at
high effort for tasks lighter models could do. This says why that
happened, what was changed, how it was checked, and what is still open.

## Why strong models were favoured (the audit)

Found in the code as it was at 0.1.3:

1. **Codex's standard tier started with a deep model.** `standard` was
   `[gpt-6.1-sol, gpt-6.1-terra, gpt-6-sol]`: "one tier lighter" than deep
   still landed on Sol 6.1 (`src/providers/codex.ts`).
2. **Profiles and affinities asked for deep.** Architecture, backend and
   debug tasks defaulted to deep at high effort (`DEFAULT_PROFILES`), and
   the default affinities sent backend, debug and review to deep
   (`DEFAULT_AFFINITY`), whatever the task's size.
3. **The planner rated its own tasks, with no scale.** Its prompt said
   "recommend deep for design and hard logic" and gave no meaning to
   complexity 1–5. A recommendation came before everything else, and a
   complexity of 4 or 5 unlocked deep and high effort.
4. **The learned router could not learn what it never saw.** It kept the
   rules' arm whenever the planner had recommended a tier (nearly always),
   compared only arms that both had ten tasks in the same cell, and nothing
   ever tried a lighter arm (exploration was off, and only for docs and
   tests). The strong arms were the only ones with evidence, so they kept
   being chosen: selection bias, read as superiority.
5. **Statistics blamed and credited the wrong things.** A task counted for
   the arm of its last attempt; its cost was that arm's tokens only, so
   earlier failed attempts cost nothing; a failure caused by a refused
   permission, a missing dependency or a merge conflict counted against the
   model.
6. **A retry was the same choice again.** Three attempts ran on the same
   model and effort: starting cheap was never safe, so the rules started
   strong.
7. **Decisions were not kept.** The route's reasons were recorded only with
   several providers, and never the candidates left out.

## What decides now

In `economy` and `balanced` (the default), with `AGENT_ROUTER` at `learned`
(the default), the model and effort of each attempt are chosen by
`src/orchestrator/sufficient.ts`:

- **The provider** is still chosen by the rules: affinity, room in each
  plan, spreading (`routeAcross`). Quotas of different providers are never
  compared with each other.
- **The candidates** are the provider's arms, weakest first: its models by
  the class its own tiers give them (light, standard, deep; two per class),
  each at low, medium and high effort.
- **What each arm can do** is a stated prior by class and complexity band
  (`PRIOR`), worth four attempts, corrected by the recorded attempts of that
  arm on that kind of task (and, at a third of their weight, on other kinds
  of the same band). With no evidence the prior decides; evidence moves it
  in proportion to how much there is. Counts never decide: an arm used 60
  times is not better than one used 12 times with the same rate.
- **The choice** is the arm with the lowest expected cost of the whole
  execution (its attempt, plus what its failures would bring: the next
  rungs, within the attempts allowed) among those whose first-attempt
  success is over a floor (0.6 in balanced, 0.5 in economy; 0.75 and 0.65
  for high-risk tasks, 0.5 and 0.4 for low-risk ones) and whose whole chain
  reaches 90% (95% for high risk). A stronger arm is chosen only when the
  task needs it or it is cheaper in the end.
- **Cost** is the share of the provider's window an attempt takes: measured
  when the provider reports its usage (`observed`), scaled from the arms
  that were measured (`estimated`), or relative units by class and effort
  when nothing was (`unknown`). No price per token is assumed.
- **Risk** is decided by code from what the task touches (schemas, auth,
  payments, CI and infrastructure are high; documents, and tests or docs
  with a command that checks them, are low).
- **Near a plan's limit** (70% of a window), deep models are kept for hard
  or high-risk tasks. The hold at 95% is unchanged.

`quality` keeps the fixed rules and the planner's advice; `rules` keeps
them with nothing learned; `shadow` records each decision and uses the
rules' choice. Models chosen by the person (`AGENT_AUTO_MODELS`) are never
swapped: the router leaves them to the rules, as before.

The planner, the reviewer and the orchestrator's decisions are routed the
same way, as tasks of their own kind: each kind of task is learned apart
(planning, implementation, debugging and review do not share evidence,
except at the reduced weight above).

## Escalation

Each attempt after a failure is decided from the task's history in the run:

1. The first attempt runs on the minimum sufficient arm.
2. A failure the environment caused (a limit, a refused permission, a
   missing tool or dependency, a conflict) changes nothing: the same arm is
   tried again, and the model is not blamed.
3. Failed checks come with a diagnostic the same model can act on: the same
   arm is retried once.
4. A second failure, or one that shows the model was not enough (out of
   steps, declined), moves up: to the cheapest arm above that reaches the
   target, or, when none does (a last attempt), the one most likely to pass.
5. The top of the ladder is retried, never passed; a task stops when its
   attempts took a quarter of a window (`TASK_SHARE_CAP`), and at the
   scheduler's three attempts.

## What is recorded

For each attempt (`metrics.db`, with columns added to older files): whether
its checks passed (run by code), whose doing a failure was
(`classifyFailure`: model, environment or ambiguous), how often a person
answered, the task's risk and technology, the exact model version, the arm
it escalated from, the share of a window it took, its time. Task outcomes
also say when a run's work failed its checks on the user's branch.

An older model version's attempts count half once a newer one answers.

For each decision (`route_decision` in the run's events): every candidate
with its estimate, prior, attempts and interval, cost and its source,
expected cost of the whole execution and why it was left out; the arm
chosen and why; the confidence (`prior`, `some`, `evidence`); what the
fixed rules would have chosen; and the escalation, when it is one.

`grafeno-agent router` shows the evidence per kind and band, how many arms
have enough attempts, how many attempts were not held against a model, and
warns when deep models take more than a quarter of the attempts on tasks
that are not hard, or when only one arm was ever tried for a kind of task.
`grafeno-agent router --decisions <run>` prints a run's decisions.

## How it was checked

`npm run eval:routing` (`test/eval/routing-sim.ts`) runs the old rules and
the new router over the same 400 fixed tasks, three seeds of outcomes.
**It is a simulation**: each arm's true success and cost are assumed in the
file, hidden from the routers and different from the new router's priors.
It shows how each policy behaves given a truth, not what real models do.

| Policy                | Success | First try | Attempts | Windows | Hours | Deep, easy tasks | Deep, hard tasks |
| --------------------- | ------- | --------- | -------- | ------- | ----- | ---------------- | ---------------- |
| rules · quality       | 97.3%   | 82.9%     | 1.23     | 15.93   | 18.2  | 45.2%            | 47.7%            |
| rules · balanced      | 98.0%   | 81.6%     | 1.24     | 8.61    | 13.6  | 0.0%             | 47.7%            |
| sufficient · balanced | 98.1%   | 72.1%     | 1.38     | 5.76    | 13.0  | 0.0%             | 75.8%            |
| sufficient · economy  | 96.5%   | 64.9%     | 1.49     | 5.19    | 11.5  | 0.0%             | 35.2%            |

Under those assumptions the new router in `balanced` spends 33% less of the
plans than the balanced rules and 64% less than `quality`, with the same
final success, at the price of more attempts (it starts cheap and
escalates). The unit tests assert the properties, not these exact figures.

## Open

- **No real-model comparison yet.** The figures above are simulated. The
  evidence starts empty on a real installation: for the first runs the
  priors decide, and they are assumptions (`PRIOR` in `sufficient.ts`).
- **Comparative runs in isolated worktrees** (the same task on two arms,
  within a budget) are not built: evidence comes only from the work the
  user asks for.
- **Technology is recorded, not yet used** to choose: per kind, band and
  technology the samples would be too small to mean anything.
- **Planner and reviewer attempts are not in the metrics**: they are routed
  like tasks of their kind, but what they do is not judged by code, so
  nothing is learned from them.
- **Failure classification is by patterns** in the checks' diagnostics and
  the errors' messages: an unusual environment failure may be read as the
  model's.
