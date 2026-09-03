import React, { useCallback, useEffect, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { UsageService, type PlanAccount, type PlanSummary, type UsageSummary } from "../../../services/usageService";
import { EmptyState, IconButton } from "../../ui";

/**
 * What the models have cost, in tokens and in dollars.
 *
 * Three questions, three forms, chosen by the job each one does rather than by
 * what looks impressive:
 *
 *   - "how much per day, typically" is a *number*, so it is a stat tile. A
 *     four-point sparkline of an average is decoration.
 *   - "how did the last seven days go" is magnitude over time on a discrete
 *     axis, so it is a column chart — seven columns, one series, no legend
 *     needed because the heading already says what is plotted.
 *   - "which model spent it" is a comparison across named entities with two
 *     measures, so it is a table with a magnitude bar in the row. A pie would
 *     make the small models unreadable, and a two-series chart of tokens and
 *     dollars on one axis would be a dual-axis chart, which is never right.
 *
 * One hue throughout (`--chart`): every mark here encodes magnitude, never
 * identity, so a categorical palette would be inventing a distinction the data
 * does not have. Text stays on the ink tokens — the bar beside a label carries
 * the value, the label never wears the data colour.
 *
 * Above all of that sits a fourth question the ledger cannot answer — "how much
 * of my plan is left" — read from server/plan.js. It leads because it is the
 * one with a deadline attached: spend is history, headroom is a constraint on
 * the next hour. It breaks the one-hue rule deliberately and only at the top of
 * a window's range, where the bar stops reporting magnitude and starts warning.
 */

const nf = new Intl.NumberFormat();

/** 1,234,567 → 1.2M. An axis of nine-digit numbers is unreadable. */
function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return `${Math.round(value)}`;
}

function money(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** Mon, Tue… — a 7-column axis wants a weekday, not a date. */
function weekday(day: string): string {
  const date = new Date(`${day}T12:00:00`);
  return Number.isNaN(date.getTime()) ? day.slice(5) : date.toLocaleDateString([], { weekday: "short" });
}

/**
 * The CLI names its windows, it does not label them. The two every subscription
 * has are named here to match what Claude Code calls them; anything else the
 * account carries is derived from its id rather than dropped, because a window
 * we have no label for is still a window the operator is being limited by.
 */
const WINDOW_LABELS: Record<string, string> = {
  five_hour: "Session (5hr)",
  seven_day: "Weekly (7 day)",
  seven_day_overage_included: "Weekly (incl. overage)",
};

function windowLabel(id: string): string {
  const known = WINDOW_LABELS[id];
  if (known) return known;
  const rest = (suffix: string) => id.slice(suffix.length).replace(/_/g, " ");
  if (id.startsWith("seven_day_")) return `Weekly ${rest("seven_day_")}`;
  if (id.startsWith("five_hour_")) return `Session ${rest("five_hour_")}`;
  return id.replace(/_/g, " ");
}

/** "Resets in 28m" — a deadline is easier to act on than a timestamp. */
function resetsIn(resetsAt: number | null): string | null {
  if (resetsAt === null) return null;
  const seconds = resetsAt - Date.now() / 1000;
  if (seconds <= 0) return "Resetting now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Resets in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Resets in ${hours}h`;
  return `Resets in ${Math.round(hours / 24)}d`;
}

/** "as of 14:32" — these windows move only on a turn. See server/plan.js. */
function observedAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay
    ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : at.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * One window. The track carries the whole plan, the fill carries what is gone.
 *
 * The fill leaves `--chart` for `--danger` at 90%, which is the one place in
 * this pane where colour means something other than magnitude: past that point
 * the number has stopped being a measurement the operator reads and started
 * being a limit that is about to interrupt them.
 */
const Meter: React.FC<{ label: string; utilization: number; detail?: string | null }> = ({ label, utilization, detail }) => {
  const percent = Math.min(100, Math.max(0, Math.round(utilization * 100)));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-2xs text-ink-body truncate">{label}</span>
        <span className="text-2xs text-ink-bright tabular-nums flex-shrink-0">{percent}%</span>
      </div>
      <div className="h-1.5 mt-1.5 rounded-full bg-chart-track overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-slow ease-ds ${percent >= 90 ? "bg-danger" : "bg-chart"}`}
          style={{ width: `${Math.max(1, percent)}%` }}
        />
      </div>
      {detail && <div className="text-3xs text-ink-soft mt-1">{detail}</div>}
    </div>
  );
};

/** The identity line. Says which CLI, so two logins are never confused. */
const AccountLine: React.FC<{ engine: string; account: PlanAccount }> = ({ engine, account }) => {
  const identity = account.email || account.detail || (account.loggedIn ? "Signed in" : "Not signed in");
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-2xs text-ink-muted flex-shrink-0">{engine}</span>
      <span className="text-2xs text-ink-body truncate text-right" title={account.organization ?? undefined}>
        {identity}
        {account.plan && <span className="text-ink-soft"> · {account.plan}</span>}
      </span>
    </div>
  );
};

const Tile: React.FC<{ label: string; value: string; detail?: string }> = ({ label, value, detail }) => (
  <div className="flex-1 min-w-0 rounded-lg bg-surface-sunken border border-edge px-3 py-2.5">
    <div className="text-2xs text-ink-muted truncate">{label}</div>
    <div className="text-md text-ink-bright mt-0.5 tabular-nums truncate">{value}</div>
    {detail && <div className="text-2xs text-ink-soft mt-0.5 truncate">{detail}</div>}
  </div>
);

export const UsagePane: React.FC = () => {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [unreachable, setUnreachable] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    // Fetched together so one refresh answers both questions. The plan half is
    // allowed to be null — an API-key login has no plan — and only the ledger
    // decides whether the gateway is reachable at all.
    const [nextSummary, nextPlan] = await Promise.all([
      UsageService.summary(7, signal),
      UsageService.plan(signal),
    ]);
    if (signal?.aborted) return;
    setSummary(nextSummary);
    setPlan(nextPlan);
    setUnreachable(nextSummary === null);
    setLoading(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (unreachable) {
    return <EmptyState title="Usage is unavailable" detail="The gateway did not answer. Start it and refresh." />;
  }

  if (!summary || (loading && summary === null)) {
    return (
      <div className="flex-1 flex items-center justify-center text-ink-muted">
        <LoaderCircle size={16} className="animate-spin" />
      </div>
    );
  }

  const accounts = Object.entries(plan?.accounts ?? {}).filter(([, account]) => account);
  const planLimits = plan?.limits?.claude ?? null;
  const peak = Math.max(1, ...summary.daily.map((day) => day.tokens));
  const biggestModel = Math.max(1, ...summary.models.map((model) => model.tokens));
  const nothingYet = summary.totals.turns === 0;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-8 flex-shrink-0 flex items-center justify-between pl-3.5 pr-2">
        <span className="text-sm text-ink-faint">Last 7 days</span>
        <IconButton onClick={() => void load()} disabled={loading} title="Refresh" size={24}>
          {loading ? <LoaderCircle size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </IconButton>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-4 space-y-4">
        {/* ── Plan headroom ─────────────────────────────────────────────────
            Ahead of the ledger, and ahead of the no-turns empty state: an
            operator who has run nothing here still has a plan and an identity,
            and both are worth showing. */}
        {(accounts.length > 0 || planLimits) && (
          <section className="rounded-lg bg-surface-sunken border border-edge px-3 py-2.5 space-y-2.5">
            {accounts.length > 0 && (
              <div className="space-y-1">
                {accounts.map(([engine, account]) => (
                  <AccountLine key={engine} engine={engine === "claude" ? "Claude Code" : "Codex"} account={account!} />
                ))}
              </div>
            )}

            {planLimits ? (
              <>
                <div className="space-y-2.5 pt-0.5">
                  {planLimits.windows.map((window) => (
                    <Meter
                      key={window.id}
                      label={windowLabel(window.id)}
                      utilization={window.utilization}
                      detail={resetsIn(window.resetsAt)}
                    />
                  ))}
                </div>
                {/* Not decoration. These windows move only when a turn runs, so
                    a reading without its timestamp would claim to be live. */}
                <p className="text-3xs text-ink-disabled">
                  As reported by Claude Code at {observedAt(planLimits.observedAt)}
                  {planLimits.isUsingOverage && " · using overage"}
                </p>
              </>
            ) : (
              <p className="text-3xs text-ink-disabled leading-relaxed">
                {plan?.accounts?.claude?.authMethod === "claude.ai"
                  ? "Plan limits appear after the next Claude Code turn — the CLI reports them with the turn, not on request."
                  : "Plan limits are reported only for a Claude subscription login."}
              </p>
            )}
          </section>
        )}

        {nothingYet ? (
          <EmptyState title="No turns yet" detail="Usage appears here as soon as a model runs." />
        ) : (
          <>
            {/* ── The headline numbers ───────────────────────────────────── */}
            <div className="flex gap-2">
              <Tile
                label="Tokens / day"
                value={compact(summary.average.perDay.tokens)}
                detail={`${compact(summary.average.perActiveDay.tokens)} on the ${summary.average.activeDays} active ${
                  summary.average.activeDays === 1 ? "day" : "days"
                }`}
              />
              <Tile
                label="Cost / day"
                value={money(summary.average.perDay.costUsd)}
                detail={`${money(summary.average.perActiveDay.costUsd)} per active day`}
              />
            </div>
            <div className="flex gap-2">
              <Tile label="Tokens, 7 days" value={nf.format(summary.totals.tokens)} detail={`${summary.totals.turns} turns`} />
              <Tile
                label="Cost, 7 days"
                value={money(summary.totals.costUsd)}
                // Codex reports no cost. Saying so beats implying its turns were free.
                detail={summary.totals.costReported ? "as reported by each agent" : "no agent reported a cost"}
              />
            </div>

            {/* ── Seven columns, one series ──────────────────────────────────
                Every day in the window is drawn, including the empty ones: a
                chart that omits quiet days compresses its own axis and makes a
                slow week look busy. */}
            <section>
              <h3 className="text-2xs text-ink-muted px-0.5 pb-2">Tokens per day</h3>
              <div className="flex items-end gap-[2px] h-24">
                {summary.daily.map((day) => {
                  const height = day.tokens === 0 ? 0 : Math.max(3, Math.round((day.tokens / peak) * 92));
                  return (
                    <div key={day.day} className="flex-1 min-w-0 flex flex-col items-center justify-end h-full">
                      <div
                        className="w-full rounded-t bg-chart transition-all duration-slow ease-ds"
                        style={{ height: `${height}px`, maxWidth: 24 }}
                        title={`${weekday(day.day)} ${day.day}\n${nf.format(day.tokens)} tokens · ${money(day.costUsd)} · ${day.turns} turns`}
                      />
                      {/* An empty day still needs a footprint, or the axis lies
                          about which column is which. */}
                      {day.tokens === 0 && <div className="w-full h-px bg-chart-track" style={{ maxWidth: 24 }} />}
                    </div>
                  );
                })}
              </div>
              <div className="flex gap-[2px] pt-1.5">
                {summary.daily.map((day) => (
                  <div key={day.day} className="flex-1 min-w-0 text-center text-3xs text-ink-soft truncate">
                    {weekday(day.day)}
                  </div>
                ))}
              </div>
            </section>

            {/* ── Per model ─────────────────────────────────────────────────
                A table, because the reader is comparing named things on two
                measures. The bar is a magnitude cue inside the row, not a
                second chart. */}
            <section>
              <h3 className="text-2xs text-ink-muted px-0.5 pb-1.5">Per model</h3>
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="text-3xs text-ink-soft">
                    <th className="font-normal pb-1">Model</th>
                    <th className="font-normal pb-1 text-right tabular-nums">Tokens</th>
                    <th className="font-normal pb-1 text-right tabular-nums">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.models.map((model) => (
                    <tr key={model.id} className="align-middle">
                      <td className="py-1 pr-2 max-w-0">
                        <div className="text-2xs text-ink-body truncate" title={`${model.id} · ${model.turns} turns`}>
                          {model.id}
                        </div>
                        <div className="h-1 mt-1 rounded-full bg-chart-track overflow-hidden">
                          <div
                            className="h-full rounded-full bg-chart"
                            style={{ width: `${Math.max(2, (model.tokens / biggestModel) * 100)}%` }}
                          />
                        </div>
                      </td>
                      <td className="py-1 text-right text-2xs text-ink-muted tabular-nums whitespace-nowrap align-top">
                        {nf.format(model.tokens)}
                      </td>
                      <td className="py-1 pl-2 text-right text-2xs text-ink-muted tabular-nums whitespace-nowrap align-top">
                        {model.costReported ? money(model.costUsd) : <span className="text-ink-disabled">not reported</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <p className="text-3xs text-ink-disabled leading-relaxed px-0.5">
              Tokens count everything the model was given and produced — fresh input, cache
              reads, cache writes and output. Costs are whatever the agent itself reported.
            </p>
          </>
        )}
      </div>
    </div>
  );
};
