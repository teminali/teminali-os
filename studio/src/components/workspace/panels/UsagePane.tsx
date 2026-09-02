import React, { useCallback, useEffect, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { UsageService, type UsageSummary } from "../../../services/usageService";
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

const Tile: React.FC<{ label: string; value: string; detail?: string }> = ({ label, value, detail }) => (
  <div className="flex-1 min-w-0 rounded-lg bg-surface-sunken border border-edge px-3 py-2.5">
    <div className="text-2xs text-ink-muted truncate">{label}</div>
    <div className="text-md text-ink-bright mt-0.5 tabular-nums truncate">{value}</div>
    {detail && <div className="text-2xs text-ink-soft mt-0.5 truncate">{detail}</div>}
  </div>
);

export const UsagePane: React.FC = () => {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [unreachable, setUnreachable] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    const next = await UsageService.summary(7, signal);
    if (signal?.aborted) return;
    setSummary(next);
    setUnreachable(next === null);
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
