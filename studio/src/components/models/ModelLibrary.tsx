import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, Check, Cpu, Download, Eye, Gauge, HardDrive, Loader2,
  RefreshCw, Search, Sparkles, Wand2, Zap,
} from "lucide-react";
import {
  FIT_COPY, ModelService, SPEED_COPY, formatBytes, formatParams,
  type LibraryModel, type LibraryResponse, type RoutingLane,
} from "../../services/modelService";
import { IconButton, StatusDot } from "../ui";

/**
 * The local model library.
 *
 * Its job is to answer one question honestly for every model: *will this run
 * on my machine, and how fast*. Everything on screen is derived from measured
 * device capability and published model sizes — the badge is arithmetic, not
 * marketing. A model that will swap this laptop says so, and Frontier Auto is
 * shown picking from the same numbers, so the routing is never a black box.
 */

type Filter = "all" | "installed" | "code" | "reasoning" | "vision" | "fits";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "installed", label: "Installed" },
  { id: "fits", label: "Runs well here" },
  { id: "code", label: "Code" },
  { id: "reasoning", label: "Reasoning" },
  { id: "vision", label: "Vision" },
];

const TONE_CLASS = {
  success: "bg-success/12 text-success border-success/25",
  accent: "bg-accent/12 text-accent border-accent/25",
  warning: "bg-warning/12 text-warning border-warning/25",
  danger: "bg-danger/12 text-danger border-danger/25",
} as const;

export const ModelLibrary: React.FC = () => {
  const [data, setData] = useState<LibraryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [pulling, setPulling] = useState<string | null>(null);

  const load = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      setData(await ModelService.library(signal));
      setError(null);
    } catch (failure) {
      if (!signal?.aborted) setError((failure as Error).message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const visible = useMemo(() => {
    if (!data) return [];
    const needle = query.trim().toLowerCase();
    return data.models
      .filter((model) => {
        if (needle && !`${model.name} ${model.tag} ${model.family} ${model.useCase}`.toLowerCase().includes(needle)) {
          return false;
        }
        switch (filter) {
          case "installed": return model.installed;
          case "fits": return model.fit.level === "recommended" || model.fit.level === "supported";
          case "code": return model.capabilities.includes("code");
          case "reasoning": return model.capabilities.includes("reasoning");
          case "vision": return model.capabilities.includes("vision");
          default: return true;
        }
      })
      // Installed first, then by how well they fit, then by size.
      .sort((a, b) => {
        if (a.installed !== b.installed) return a.installed ? -1 : 1;
        const order = ["recommended", "supported", "tight", "unsupported"];
        const fitDelta = order.indexOf(a.fit.level) - order.indexOf(b.fit.level);
        if (fitDelta !== 0) return fitDelta;
        return b.bytes - a.bytes;
      });
  }, [data, query, filter]);

  const installed = visible.filter((model) => model.installed);
  const available = visible.filter((model) => !model.installed);

  const pull = async (tag: string) => {
    setPulling(tag);
    try {
      await ModelService.pull(tag);
      await load();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPulling(null);
    }
  };

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-16 text-ink-muted">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {data && <DeviceStrip data={data} onRefresh={() => void load()} loading={loading} />}
      {data && <RoutingCard routing={data.routing} connected={data.connected} />}

      {error && (
        <div className="flex items-start gap-2 rounded-lg bg-danger/10 border border-danger/25 px-3 py-2 text-2xs text-danger">
          <AlertTriangle size={13} className="flex-shrink-0 mt-px" />
          {error}
        </div>
      )}

      {/* ── Search and filters ───────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models"
            className="lit lit-inner w-full h-7 pl-7 pr-2 bg-surface rounded-md text-xs text-ink-high placeholder:text-ink-placeholder outline-none"
          />
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setFilter(entry.id)}
              className={`h-7 px-2.5 rounded-md text-2xs transition-colors duration-ds ease-ds ${
                filter === entry.id
                  ? "bg-accent/12 text-accent border border-accent/25"
                  : "text-ink-muted hover:text-ink-high hover:bg-surface-chip border border-transparent"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Rows ─────────────────────────────────────────────────────────── */}
      {installed.length > 0 && (
        <Section title="On this machine" count={installed.length}>
          {installed.map((model) => (
            <ModelRow key={model.tag} model={model} routing={data?.routing} />
          ))}
        </Section>
      )}

      {available.length > 0 && (
        <Section title="Library" count={available.length}>
          {available.map((model) => (
            <ModelRow
              key={model.tag}
              model={model}
              routing={data?.routing}
              pulling={pulling === model.tag}
              onPull={model.fit.level === "unsupported" ? undefined : () => void pull(model.tag)}
            />
          ))}
        </Section>
      )}

      {visible.length === 0 && (
        <p className="text-2xs text-ink-faint py-6 text-center">No model matches that search.</p>
      )}
    </div>
  );
};

/* ── Device ───────────────────────────────────────────────────────────────── */

const DeviceStrip: React.FC<{ data: LibraryResponse; onRefresh: () => void; loading: boolean }> = ({
  data, onRefresh, loading,
}) => {
  const { device, connected } = data;
  return (
    <div className="lit lit-inner flex items-center gap-4 rounded-lg bg-surface px-3 py-2.5">
      <Cpu size={15} className="text-accent flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-xs text-ink-bright truncate">{device.chip ?? device.brand ?? "This machine"}</div>
        <div className="text-2xs text-ink-faint font-mono">
          {formatBytes(device.totalMemoryBytes)} memory · {formatBytes(device.usableMemoryBytes)} usable for models
          {device.bandwidthGBs ? ` · ${device.bandwidthGBs} GB/s` : ""}
          {device.performanceCores ? ` · ${device.performanceCores}P cores` : ""}
        </div>
      </div>
      <span className="flex items-center gap-1.5 text-2xs text-ink-muted flex-shrink-0">
        <StatusDot tone={connected ? "success" : "danger"} />
        {connected ? "Ollama connected" : "Ollama offline"}
      </span>
      <IconButton onClick={onRefresh} title="Re-scan" size={24}>
        {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
      </IconButton>
    </div>
  );
};

/* ── Routing ──────────────────────────────────────────────────────────────── */

const RoutingCard: React.FC<{ routing: LibraryResponse["routing"]; connected: boolean }> = ({ routing, connected }) => {
  if (routing.degraded) {
    return (
      <div className="flex items-start gap-2 rounded-lg bg-warning/10 border border-warning/25 px-3 py-2.5 text-2xs text-warning">
        <AlertTriangle size={13} className="flex-shrink-0 mt-px" />
        <p>
          {connected
            ? "None of the installed models fit this machine comfortably. Install a smaller one below and Frontier will start routing to it."
            : "Ollama is not running, so no local model can be selected."}
        </p>
      </div>
    );
  }

  return (
    <div className="lit lit-inner rounded-lg bg-surface overflow-hidden">
      <div className="px-3 pt-2.5 pb-2 flex items-center gap-2">
        <Wand2 size={13} className="text-accent" />
        <span className="text-xs text-ink-bright">How Frontier routes</span>
        <span className="text-2xs text-ink-faint">chosen from what fits, automatically</span>
      </div>
      <div className="divide-y divide-edge-chrome border-t border-edge-chrome">
        <LaneRow
          icon={<Zap size={12} className="text-accent" strokeWidth={2.2} />}
          lane="Frontier Flash"
          detail="Every everyday turn"
          model={routing.light}
        />
        <LaneRow
          icon={<Sparkles size={12} className="text-reason" />}
          lane="Frontier Auto — heavy lane"
          detail="Refactors, debugging, architecture"
          model={routing.heavy}
        />
        {routing.vision && (
          <LaneRow
            icon={<Eye size={12} className="text-ink-muted" />}
            lane="Vision"
            detail="Screenshots and design cloning"
            model={routing.vision}
          />
        )}
      </div>
    </div>
  );
};

const LaneRow: React.FC<{ icon: React.ReactNode; lane: string; detail: string; model: RoutingLane | null }> = ({
  icon, lane, detail, model,
}) => (
  <div className="px-3 py-2 flex items-center gap-3">
    <span className="flex-shrink-0">{icon}</span>
    <div className="min-w-0 w-44 flex-shrink-0">
      <div className="text-xs text-ink-prose truncate">{lane}</div>
      <div className="text-3xs text-ink-faint truncate">{detail}</div>
    </div>
    {model ? (
      <>
        <span className="font-mono text-2xs text-ink-high truncate flex-1 min-w-0">{model.tag}</span>
        <span className="font-mono text-3xs text-ink-faint flex-shrink-0">{formatBytes(model.bytes)}</span>
        {model.fit.tokensPerSecond !== null && (
          <span className="font-mono text-3xs text-ink-faint flex-shrink-0 w-20 text-right">
            ~{model.fit.tokensPerSecond} tok/s
          </span>
        )}
      </>
    ) : (
      <span className="text-2xs text-ink-disabled flex-1">nothing installed for this lane</span>
    )}
  </div>
);

/* ── Rows ─────────────────────────────────────────────────────────────────── */

const Section: React.FC<{ title: string; count: number; children: React.ReactNode }> = ({ title, count, children }) => (
  <div className="flex flex-col gap-1">
    <div className="flex items-center gap-2 px-0.5">
      <span className="text-2xs text-ink-faint uppercase tracking-wider">{title}</span>
      <span className="text-3xs text-ink-disabled font-mono">{count}</span>
    </div>
    <div className="rounded-lg border border-edge overflow-hidden divide-y divide-edge-chrome">{children}</div>
  </div>
);

const ModelRow: React.FC<{
  model: LibraryModel;
  routing?: LibraryResponse["routing"];
  pulling?: boolean;
  onPull?: () => void;
}> = ({ model, routing, pulling = false, onPull }) => {
  const fit = FIT_COPY[model.fit.level];
  const activeTag = model.installedTag ?? model.tag;
  const isFlash = routing?.light?.tag === activeTag;
  const isHeavy = routing?.heavy?.tag === activeTag;

  return (
    <div className="px-3 py-2 flex items-start gap-3 bg-surface hover:bg-surface-hover transition-colors duration-ds ease-ds">
      {/* Identity and meta stack vertically: the pane is narrow, and a row of
          fixed-width numeric columns collapses the name to nothing. */}
      <div className="min-w-0 flex-1 flex flex-col gap-0.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-ink-bright truncate max-w-[220px]">{model.name}</span>
          {isFlash && (
            <span className="flex-shrink-0 inline-flex items-center gap-1 text-3xs font-mono text-accent bg-accent/12 border border-accent/25 rounded px-1.5 py-0.5">
              <Zap size={9} strokeWidth={2.4} />
              Flash
            </span>
          )}
          {isHeavy && (
            <span className="flex-shrink-0 inline-flex items-center gap-1 text-3xs font-mono text-reason bg-reason/12 border border-reason/25 rounded px-1.5 py-0.5">
              <Sparkles size={9} />
              Auto heavy
            </span>
          )}
        </div>

        <div className="font-mono text-3xs text-ink-faint truncate" title={model.useCase}>{activeTag}</div>

        <div className="flex items-center gap-3 font-mono text-3xs text-ink-muted flex-wrap">
          <span>{formatParams(model.params)}</span>
          <span className="flex items-center gap-1">
            <HardDrive size={9} className="text-ink-disabled" />
            {formatBytes(model.bytes)}
          </span>
          <span className="flex items-center gap-1" title="Estimated from this machine's memory bandwidth">
            <Gauge size={9} className="text-ink-disabled" />
            ~{model.fit.tokensPerSecond ?? "?"} tok/s
            <span className="text-ink-disabled">{SPEED_COPY[model.fit.speed]}</span>
          </span>
          {model.custom && <span className="text-ink-disabled">custom</span>}
        </div>
      </div>

      {/* Verdict and action, right-aligned so the column scans vertically. */}
      <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
        <span
          title={model.fit.reason}
          className={`text-3xs rounded px-1.5 py-1 border whitespace-nowrap ${TONE_CLASS[fit.tone]}`}
        >
          {fit.label}
        </span>

        {model.installed ? (
          <span className="flex items-center gap-1 text-3xs text-success">
            <Check size={10} />
            Installed
          </span>
        ) : onPull ? (
          <button
            type="button"
            onClick={onPull}
            disabled={pulling}
            className="h-6 px-2 inline-flex items-center gap-1.5 rounded-md bg-accent text-frame-top text-3xs font-medium hover:bg-accent-hover disabled:opacity-50 transition-colors duration-ds ease-ds whitespace-nowrap"
          >
            {pulling ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
            {pulling ? "Pulling" : "Download"}
          </button>
        ) : (
          <span className="text-3xs text-ink-disabled whitespace-nowrap" title={model.fit.reason}>
            too large
          </span>
        )}
      </div>
    </div>
  );
};
