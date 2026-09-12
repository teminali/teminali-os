import React, { useEffect, useState } from "react";
import { AlertTriangle, Check, ChevronRight, ExternalLink, Eye, EyeOff, KeyRound, Loader2, Sparkles, Trash2, Zap } from "lucide-react";
import { ProviderService, type ProviderInfo, type ProvidersResponse } from "../../services/modelService";
import { useStudioStore } from "../../store/studioStore";
import { StatusDot } from "../ui";

/**
 * Hosted providers.
 *
 * The same two lanes as the local side — a cheap model for everyday turns, a
 * stronger one when the task warrants it — so switching between local and
 * hosted changes the bill and nothing about how the product behaves.
 *
 * The flagship of each provider is listed and deliberately never auto-selected.
 * A router that quietly reaches for Opus on an ambiguous prompt produces a bill
 * nobody can predict, so it stays a manual choice.
 *
 * The keys themselves collapse, because entering one is a thing you do once and
 * the cards are two thirds of this screen. The section opens itself while no key
 * is configured — collapsing the only route to the capability the screen exists
 * for would be a shut door with no handle — and closes once one is, until the
 * operator says otherwise. Their choice outranks the rule from then on.
 */

export const ApiProviders: React.FC = () => {
  const [data, setData] = useState<ProvidersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Null until the operator opens or closes it themselves; then it is theirs. */
  const [keysChoice, setKeysChoice] = useState<boolean | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    ProviderService.list(controller.signal)
      .then(setData)
      .catch((failure) => {
        if (!controller.signal.aborted) setError((failure as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-ink-muted">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  const providers = data?.providers ?? [];
  const connected = providers.filter((provider) => provider.configured);
  const keysOpen = keysChoice ?? connected.length === 0;

  return (
    <div className="flex flex-col gap-4">
      {data && !data.routing.degraded ? (
        <div className="lit lit-inner rounded-lg bg-surface overflow-hidden">
          <div className="px-3 pt-2.5 pb-2 flex items-center gap-2">
            <Sparkles size={13} className="text-accent" />
            <span className="text-xs text-ink-bright">How Frontier routes</span>
            <span className="text-2xs text-ink-faint">via {data.routing.providerLabel}</span>
          </div>
          <div className="divide-y divide-edge-chrome border-t border-edge-chrome">
            <HostedLane icon={<Zap size={12} className="text-accent" strokeWidth={2.2} />} lane="Frontier Flash" model={data.routing.light} />
            <HostedLane icon={<Sparkles size={12} className="text-reason" />} lane="Frontier Auto — heavy lane" model={data.routing.heavy} />
            {data.routing.flagshipExcluded && (
              <div className="px-3 py-2 flex items-center gap-3 text-2xs text-ink-faint">
                <span className="w-3 flex-shrink-0" />
                <span className="w-44 flex-shrink-0">Never chosen automatically</span>
                <span className="font-mono text-ink-disabled truncate">
                  {data.routing.flagshipExcluded.model}
                </span>
                <span className="flex-1" />
                <span className="text-ink-disabled">pin it manually if you want it</span>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="lit lit-inner flex items-start gap-2 rounded-lg bg-surface-sunken px-3 py-2.5 text-2xs text-ink-faint">
          <KeyRound size={13} className="flex-shrink-0 mt-px" />
          Add a key below and Frontier will route to that provider automatically.
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-lg bg-danger/10 border border-danger/25 px-3 py-2 text-2xs text-danger">
          <AlertTriangle size={13} className="flex-shrink-0 mt-px" />
          {error}
        </div>
      )}

      <section className="flex flex-col gap-1">
        {/* Collapsed, the header still answers the question the section exists
            to answer — which providers have a key — so folding it away hides
            the fields and none of the state. */}
        <button
          type="button"
          onClick={() => setKeysChoice(!keysOpen)}
          aria-expanded={keysOpen}
          className="group flex items-center gap-2 px-0.5 py-0.5 text-left"
        >
          <ChevronRight
            size={11}
            className={`flex-shrink-0 text-ink-faint transition-transform duration-ds ease-ds ${keysOpen ? "rotate-90" : ""}`}
          />
          <span className="text-2xs uppercase tracking-wider text-ink-faint group-hover:text-ink-high">API Keys</span>
          <span className="font-mono text-3xs text-ink-disabled">
            {connected.length}/{providers.length}
          </span>
          {!keysOpen && (
            <span className="truncate text-3xs text-ink-disabled">
              {connected.length > 0 ? connected.map((provider) => provider.label).join(" · ") : "none connected"}
            </span>
          )}
        </button>

        {keysOpen && (
          <div className="flex flex-col gap-2">
            {providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                onChange={setData}
                onError={setError}
              />
            ))}

            <p className="text-3xs text-ink-disabled leading-relaxed">
              Keys are written to disk on this machine with owner-only permissions and are never sent to the renderer or
              written to the audit log. An <span className="font-mono">API_KEY</span> already in your environment is
              picked up automatically.
            </p>
          </div>
        )}
      </section>
    </div>
  );
};

const HostedLane: React.FC<{ icon: React.ReactNode; lane: string; model: { model: string; label: string; note: string } | null }> = ({
  icon, lane, model,
}) => (
  <div className="px-3 py-2 flex items-center gap-3">
    <span className="flex-shrink-0">{icon}</span>
    <span className="w-44 flex-shrink-0 text-xs text-ink-prose truncate">{lane}</span>
    {model ? (
      <>
        <span className="font-mono text-2xs text-ink-high truncate">{model.model}</span>
        <span className="flex-1" />
        <span className="text-2xs text-ink-faint truncate max-w-[240px]">{model.note}</span>
      </>
    ) : (
      <span className="text-2xs text-ink-disabled">not configured</span>
    )}
  </div>
);

const ProviderCard: React.FC<{
  provider: ProviderInfo;
  onChange: (data: ProvidersResponse) => void;
  onError: (message: string | null) => void;
}> = ({ provider, onChange, onError }) => {
  const [draft, setDraft] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingLanes, setEditingLanes] = useState(false);
  const [light, setLight] = useState(provider.lanes.light.model);
  const [heavy, setHeavy] = useState(provider.lanes.heavy.model);
  const noteProviderKeySaved = useStudioStore((state) => state.noteProviderKeySaved);

  const save = async () => {
    if (!draft.trim()) return;
    setSaving(true);
    onError(null);
    try {
      onChange(await ProviderService.setKey(provider.id, draft.trim()));
      /* The other half of the same signal `GeminiKeyModal` raises: a key can
         be pasted here just as easily, and a lane that was dead for the want
         of one has to hear about it from whichever screen it arrived on.
         Raised for every provider rather than for Google alone, because this card
         does not know who is listening, and the one listener there is treats
         it as "try again", which costs a request and no more when the key
         that landed was not the one it wanted. */
      noteProviderKeySaved();
      setDraft("");
    } catch (failure) {
      onError((failure as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    try {
      onChange(await ProviderService.setKey(provider.id, null));
    } catch (failure) {
      onError((failure as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const saveLanes = async () => {
    setSaving(true);
    try {
      onChange(await ProviderService.setLanes(provider.id, { lightModel: light, heavyModel: heavy }));
      setEditingLanes(false);
    } catch (failure) {
      onError((failure as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="lit lit-inner rounded-lg bg-surface overflow-hidden">
      <div className="px-3 py-2.5 flex items-center gap-3">
        <StatusDot tone={provider.configured ? "success" : "muted"} />
        <span className="text-xs text-ink-bright w-24 flex-shrink-0">{provider.label}</span>

        {provider.configured ? (
          <>
            <span className="font-mono text-2xs text-ink-muted truncate">{provider.hint}</span>
            {provider.backupConfigured && (
              <span
                className="text-3xs text-emerald-400 bg-emerald-950/40 px-1.5 py-0.5 rounded border border-emerald-800/40 font-mono flex-shrink-0"
                title={`Auto-failover backup key: ${provider.backupHint}`}
              >
                backup: {provider.backupHint}
              </span>
            )}
            <span className="text-3xs text-ink-disabled flex-shrink-0">
              {provider.source === "environment" ? `from ${provider.envVar}` : "stored on this machine"}
            </span>
            <span className="flex-1" />
            <span className="flex items-center gap-1 text-2xs text-success flex-shrink-0">
              <Check size={11} />
              Connected
            </span>
            {provider.source === "stored" && (
              <button
                type="button"
                onClick={clear}
                disabled={saving}
                title="Remove key"
                className="w-6 h-6 flex items-center justify-center rounded-md text-ink-muted hover:bg-danger/15 hover:text-danger transition-colors duration-ds ease-ds"
              >
                <Trash2 size={12} />
              </button>
            )}
          </>
        ) : (
          <>
            <div className="relative flex-1 min-w-0">
              <input
                type={reveal ? "text" : "password"}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void save();
                }}
                placeholder={`${provider.envVar} …`}
                autoComplete="off"
                spellCheck={false}
                className="lit lit-inner w-full h-7 pl-2.5 pr-8 bg-surface-sunken rounded-md font-mono text-2xs text-ink-high placeholder:text-ink-placeholder outline-none"
              />
              <button
                type="button"
                onClick={() => setReveal((previous) => !previous)}
                aria-label={reveal ? "Hide" : "Show"}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink-dim"
              >
                {reveal ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
            </div>
            <button
              type="button"
              onClick={save}
              disabled={!draft.trim() || saving}
              className="h-7 px-3 rounded-md bg-accent text-frame-top text-2xs font-medium hover:bg-accent-hover disabled:opacity-40 transition-colors duration-ds ease-ds flex-shrink-0"
            >
              {saving ? <Loader2 size={11} className="animate-spin" /> : "Connect"}
            </button>
            <a
              href={provider.docsUrl}
              target="_blank"
              rel="noreferrer"
              title="Get a key"
              className="text-ink-faint hover:text-ink-dim flex-shrink-0"
            >
              <ExternalLink size={12} />
            </a>
          </>
        )}
      </div>

      {/* Lane assignment. Editable because model ids drift and a rename should
          not require a release. */}
      <div className="border-t border-edge-chrome px-3 py-2 flex items-center gap-3 text-2xs">
        {editingLanes ? (
          <>
            <LaneInput label="Everyday" value={light} onChange={setLight} />
            <LaneInput label="Hard tasks" value={heavy} onChange={setHeavy} />
            <button
              type="button"
              onClick={saveLanes}
              disabled={saving}
              className="h-6 px-2.5 rounded-md bg-accent text-frame-top text-3xs font-medium hover:bg-accent-hover disabled:opacity-40 flex-shrink-0"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditingLanes(false)}
              className="text-3xs text-ink-muted hover:text-ink-high flex-shrink-0"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <span className="text-ink-faint w-24 flex-shrink-0">Models</span>
            <span className="flex items-center gap-1.5 min-w-0">
              <Zap size={9} className="text-accent flex-shrink-0" strokeWidth={2.4} />
              <span className="font-mono text-ink-muted truncate">{provider.lanes.light.model}</span>
            </span>
            <span className="flex items-center gap-1.5 min-w-0">
              <Sparkles size={9} className="text-reason flex-shrink-0" />
              <span className="font-mono text-ink-muted truncate">{provider.lanes.heavy.model}</span>
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => setEditingLanes(true)}
              className="text-3xs text-ink-faint hover:text-ink-dim flex-shrink-0"
            >
              Change
            </button>
          </>
        )}
      </div>
    </div>
  );
};

const LaneInput: React.FC<{ label: string; value: string; onChange: (value: string) => void }> = ({
  label, value, onChange,
}) => (
  <label className="flex items-center gap-1.5 min-w-0 flex-1">
    <span className="text-3xs text-ink-faint flex-shrink-0">{label}</span>
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      spellCheck={false}
      className="flex-1 min-w-0 h-6 px-2 bg-surface-sunken border border-edge rounded font-mono text-3xs text-ink-high outline-none"
    />
  </label>
);
