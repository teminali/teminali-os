import React, { useEffect, useState } from "react";
import { Brain, Check, ChevronRight, Gauge, KeyRound, Loader2, ShieldAlert, Sparkles, Zap } from "lucide-react";
import { BrandGlyph } from "../ui";
import { ModelService, ProviderService, formatBytes, type RoutingPlan } from "../../services/modelService";
import {
  AgentCliService,
  type AgentDescriptor,
  type AgentEngine,
  type AgentModelSet,
} from "../../services/agentCliService";
import { PROFILES_LIST, useStudioStore } from "../../store/studioStore";
import { useMenuKeyboard } from "../../hooks/useMenuKeyboard";
import type { ModelProfileId } from "../../types";

/**
 * The model picker in the composer.
 *
 * Its whole job is to remove the guesswork from "which model am I actually
 * talking to". Auto and Flash are not abstract labels here — each one names the
 * concrete local model it will run, resolved from what is installed and what
 * this machine can carry. If Auto would escalate to a heavier model on a hard
 * prompt, that model is named too.
 *
 * **One assistant open at a time.** The menu is a tree: the assistants are the
 * branches — Frontier, Claude Code, Codex — and their models are the leaves.
 * Flat, it ran to nineteen rows and off the bottom of a laptop screen, which is
 * a list you scroll rather than a menu you read. Collapsed, it is three rows
 * plus the models of the one assistant you are actually looking at, and each
 * collapsed branch still says on its right which of its models is selected, so
 * folding a branch away hides no answer.
 *
 * Picking an agent does not swap a model behind the same engine — it sends the
 * conversation to Claude Code or Codex as a process, with that CLI's own tools
 * and permissions, which is why that agent's permission rung lives inside its
 * branch. The list keeps the same discipline throughout: an alias is shown with
 * what it actually resolves to, and the interface says whether that resolution
 * was observed on this machine or is only our shipped best knowledge. See
 * server/agent-models.js for why that distinction exists.
 */

export interface ModelPickerProps {
  open: boolean;
  onClose: () => void;
}

/**
 * The rungs, named once. The voice stage's composer shows the one in force on
 * its approvals chip, so the chip and this menu can never disagree about what
 * the engine is currently allowed to do.
 */
export const PERMISSION_LABELS: Record<string, string> = {
  manual: "Ask first",
  acceptEdits: "Accept edits",
  bypassPermissions: "Full access",
  "read-only": "Read only",
  "workspace-write": "Workspace write",
  "danger-full-access": "Full access",
};

const PERMISSION_DETAIL: Record<string, string> = {
  manual: "Every tool call needs approval; in headless mode an unanswered prompt is refused",
  acceptEdits: "File edits run; shell commands still need approval",
  bypassPermissions: "Runs anything in this workspace without asking",
  "read-only": "May read the workspace. No edits, no commands",
  "workspace-write": "May edit files and run commands inside the workspace",
  "danger-full-access": "No sandbox at all",
};

/**
 * The other two rungs each CLI already has, named once for the same reason the
 * permissions are.
 *
 * Both vocabularies are the CLIs' own — `claude --effort` and Codex's
 * `model_reasoning_effort` — and they do not agree: Codex starts at `minimal`,
 * Claude Code tops out at `max`. One table covers both because the union is
 * still six words, and the picker only ever renders the levels the gateway says
 * the installed binary accepts.
 */
const EFFORT_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

const EFFORT_DETAIL: Record<string, string> = {
  minimal: "Answers almost without reasoning. Fastest and cheapest",
  low: "A little reasoning before answering",
  medium: "The usual balance of thought and speed",
  high: "Thinks longer. Slower turns, better on hard problems",
  xhigh: "Thinks a great deal longer. For work that is worth waiting for",
  max: "Everything the model has. The slowest and most expensive setting",
};

/**
 * How much of the reasoning comes back on the stream — Codex's
 * `model_reasoning_summary`. Claude Code has no equivalent knob: its effort
 * level *is* its thinking budget, so its branch shows no Thinking group at all
 * rather than a control that would do nothing.
 */
const THINKING_LABELS: Record<string, string> = {
  none: "Hidden",
  concise: "Brief",
  detailed: "Full",
  auto: "Automatic",
};

const THINKING_DETAIL: Record<string, string> = {
  none: "Reasoning is not summarised; only the answer arrives",
  concise: "A short summary of the reasoning, as it happens",
  detailed: "The full reasoning summary in the transcript",
  auto: "Let Codex choose how much reasoning to show",
};

/** The row meaning "pass no flag; leave the operator's own CLI config alone". */
const CLI_DEFAULT_LABEL = "CLI default";

export const PROFILE_ICONS: Record<ModelProfileId, React.ReactNode> = {
  flash: <Zap size={13} className="text-accent" strokeWidth={2.2} />,
  auto: <Sparkles size={13} className="text-reason" strokeWidth={2} />,
  max: <BrandGlyph brand="teminali" size={14} blend={false} />,
  gemini: <BrandGlyph brand="gemini" size={14} />,
};

const ICONS = PROFILE_ICONS;

/** A branch of the tree. `frontier` is always present; the agents come and go. */
type BranchId = "frontier" | AgentEngine;

const AGENT_ORDER: AgentEngine[] = ["claude", "codex"];

export const ModelPicker: React.FC<ModelPickerProps> = ({ open, onClose }) => {
  const {
    currentProfile,
    setProfile,
    agentSelection,
    setAgentSelection,
    agentPermission,
    setAgentPermission,
    agentEffort,
    setAgentEffort,
    agentThinking,
    setAgentThinking,
    setGeminiKeyModalOpen,
  } = useStudioStore();
  const ref = React.useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  const [routing, setRouting] = useState<RoutingPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [googleConfigured, setGoogleConfigured] = useState<boolean>(false);
  const [agents, setAgents] = useState<Record<AgentEngine, AgentDescriptor> | null>(null);
  const [agentModels, setAgentModels] = useState<Record<AgentEngine, AgentModelSet> | null>(null);
  const [expanded, setExpanded] = useState<BranchId | null>(null);

  /** The branch holding the current selection. Opening on anything else would
   *  hide the one row the operator came to check. */
  const selectedBranch: BranchId = agentSelection ? agentSelection.engine : "frontier";

  // Re-opening the menu re-opens that branch: a menu that remembers a fold from
  // three selections ago opens onto the wrong assistant.
  useEffect(() => {
    if (open) setExpanded(selectedBranch);
  }, [open, selectedBranch]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    ModelService.library(controller.signal)
      .then((library) => setRouting(library.routing))
      .catch(() => setRouting(null))
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    ProviderService.list(controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        const google = res.providers.find((p) => p.id === "google");
        setGoogleConfigured(Boolean(google?.configured));
      })
      .catch(() => setGoogleConfigured(false));
    return () => controller.abort();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void Promise.all([
      AgentCliService.available(controller.signal),
      AgentCliService.models(controller.signal),
    ]).then(([available, models]) => {
      if (controller.signal.aborted) return;
      setAgents(available);
      setAgentModels(models);
    });
    return () => controller.abort();
  }, [open]);

  React.useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const node = ref.current;
      if (!node) return;
      // 16px of air, so the menu never sits flush against the window edge.
      setMaxHeight(Math.max(160, node.getBoundingClientRect().bottom - 16));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, expanded]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // Pointerdown rather than click, so the menu is gone before the control
    // underneath reacts to the same gesture.
    const onPointerDown = (event: PointerEvent) => {
      const node = ref.current;
      if (node && !node.contains(event.target as Node) && !node.parentElement?.contains(event.target as Node)) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, onClose]);

  /** One branch at a time: opening one closes whichever was open. */
  const toggle = (id: BranchId) => setExpanded((current) => (current === id ? null : id));

  const installedAgents = AGENT_ORDER.filter((engine) => agents?.[engine]?.installed && agentModels?.[engine]);

  /**
   * Every focusable row, in visual order.
   *
   * The keyboard walks the tree as one list, so the flat index is derived here
   * from exactly what is on screen — branch headers always, their contents only
   * while open. Building it in render order is what keeps the arrows matching
   * what the eye sees; a collapsed branch's models must not be reachable by an
   * arrow key when they are not reachable by a mouse.
   */
  const rows: { key: string; run: () => void; disabled?: boolean }[] = [];
  rows.push({ key: "branch:frontier", run: () => toggle("frontier") });
  if (expanded === "frontier") {
    for (const profile of PROFILES_LIST) {
      rows.push({
        key: `profile:${profile.id}`,
        run: () => {
          if (profile.id === "gemini" && !googleConfigured) {
            setGeminiKeyModalOpen(true);
            onClose();
            return;
          }
          setProfile(profile.id);
          onClose();
        },
      });
    }
  }
  for (const engine of installedAgents) {
    rows.push({ key: `branch:${engine}`, run: () => toggle(engine) });
    if (expanded !== engine) continue;
    const descriptor = agents![engine];
    for (const model of agentModels![engine].models) {
      rows.push({
        key: `${engine}:${model.id ?? "default"}`,
        run: () => {
          setAgentSelection({ engine, model: model.id, label: `${descriptor.label} · ${model.label}` });
          onClose();
        },
      });
    }
    if (agentSelection?.engine === engine) {
      for (const value of descriptor.permissions ?? []) {
        rows.push({ key: `perm:${value}`, run: () => setAgentPermission(value) });
      }
      // The "leave it alone" row leads each group and is reachable by the
      // keyboard like any other: a level you cannot un-pick is a trap.
      if ((descriptor.efforts ?? []).length > 0) {
        rows.push({ key: "effort:default", run: () => setAgentEffort(null) });
        for (const value of descriptor.efforts ?? []) {
          rows.push({ key: `effort:${value}`, run: () => setAgentEffort(value) });
        }
      }
      if ((descriptor.thinking ?? []).length > 0) {
        rows.push({ key: "thinking:default", run: () => setAgentThinking(null) });
        for (const value of descriptor.thinking ?? []) {
          rows.push({ key: `thinking:${value}`, run: () => setAgentThinking(value) });
        }
      }
    }
  }

  const { activeIndex, setActiveIndex } = useMenuKeyboard({
    open,
    count: rows.length,
    onSelect: (index) => rows[index]?.run(),
    onClose,
    isDisabled: (index) => Boolean(rows[index]?.disabled),
  });
  const indexOf = (key: string) => rows.findIndex((row) => row.key === key);

  if (!open) return null;

  /** What each lane will actually run, so the label is never a promise. */
  const runs = (id: ModelProfileId) => {
    if (id === "max" || id === "gemini") return { tag: "gemini-3.8-flash", bytes: 0 };
    if (!routing) return null;
    if (id === "flash") return routing.light;
    return routing.light;
  };

  /* ── One row, for every model in the menu ───────────────────────────────
     Every entry here is the same object: a 24px line with a glyph, a name, and
     the concrete thing it will run on the right. Detail that used to sit under
     each label — the lane description, where a resolution came from — moved
     into the tooltip. Fourteen models each explaining themselves in three lines
     is a wall of text you have to read; fourteen single lines is a list you can
     scan, which is what a picker is for. */
  const Row: React.FC<{
    icon: React.ReactNode;
    label: string;
    meta?: React.ReactNode;
    title?: string;
    active: boolean;
    disabled?: boolean;
    onSelect: () => void;
    /** Position in the flat keyboard order. */
    rowKey: string;
  }> = ({ icon, label, meta, title, active, disabled = false, onSelect, rowKey }) => {
    const index = indexOf(rowKey);
    const highlighted = index >= 0 && index === activeIndex;
    return (
      <button
        type="button"
        role="menuitemradio"
        aria-checked={active}
        disabled={disabled}
        title={title}
        onMouseEnter={() => index >= 0 && setActiveIndex(index)}
        onClick={onSelect}
        className={`w-full h-6 pl-7 pr-2 rounded-md flex items-center gap-2 text-sm transition-colors duration-ds ease-ds disabled:opacity-40 ${
          active
            ? "bg-surface-active text-ink-strong"
            : highlighted
              ? "bg-surface-hover text-ink-body"
              : "text-ink-body hover:bg-surface-hover"
        }`}
      >
        <span className="flex-shrink-0 flex items-center">{icon}</span>
        <span className="truncate">{label}</span>
        <span className="flex-1" />
        {meta && <span className="text-2xs text-ink-soft truncate max-w-[112px]">{meta}</span>}
        {active && <Check size={12} className="text-ink-muted flex-shrink-0" />}
      </button>
    );
  };

  /* ── A branch header ────────────────────────────────────────────────────
     Reads as one row whether it is open or shut. When shut it carries the name
     of whichever of its models is selected, so collapsing never costs the
     answer to "what am I running"; when open, that name is visible below it
     anyway and the summary would be a duplicate, so it goes. */
  const Branch: React.FC<{
    id: BranchId;
    icon: React.ReactNode;
    label: string;
    trailing?: string;
    summary?: string;
    holdsSelection: boolean;
  }> = ({ id, icon, label, trailing, summary, holdsSelection }) => {
    const isOpen = expanded === id;
    const index = indexOf(`branch:${id}`);
    const highlighted = index >= 0 && index === activeIndex;
    return (
      <button
        type="button"
        role="menuitem"
        aria-expanded={isOpen}
        onMouseEnter={() => index >= 0 && setActiveIndex(index)}
        onClick={() => toggle(id)}
        title={trailing ? `${label} ${trailing}` : label}
        className={`w-full h-7 px-2 rounded-md flex items-center gap-1.5 text-sm transition-colors duration-ds ease-ds ${
          highlighted ? "bg-surface-hover text-ink-strong" : "text-ink-strong hover:bg-surface-hover"
        }`}
      >
        <ChevronRight
          size={12}
          className={`flex-shrink-0 text-ink-muted transition-transform duration-ds ease-ds ${
            isOpen ? "rotate-90" : ""
          }`}
        />
        <span className="flex-shrink-0 flex items-center">{icon}</span>
        <span className="truncate font-medium">{label}</span>
        <span className="flex-1" />
        {!isOpen && summary && (
          <span className="text-2xs text-ink-soft truncate max-w-[112px]">{summary}</span>
        )}
        {!isOpen && holdsSelection && <Check size={12} className="text-ink-muted flex-shrink-0" />}
      </button>
    );
  };

  const SubGroup: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="h-5 pl-7 pr-2 flex items-center">
      <span className="text-2xs text-ink-faint">{children}</span>
    </div>
  );

  const frontierHoldsSelection = !agentSelection;
  const frontierSummary = PROFILES_LIST.find((profile) => profile.id === currentProfile)?.name;

  return (
    <div
      ref={ref}
      role="menu"
      className="lit lit-strong absolute bottom-11 right-0 z-[100] w-[284px] overflow-y-auto rounded-xl bg-surface-popover shadow-popover p-1 animate-in"
      style={{ maxHeight }}
    >
      <Branch
        id="frontier"
        icon={<BrandGlyph brand="teminali" size={14} blend={false} />}
        label="Frontier"
        summary={frontierHoldsSelection ? frontierSummary?.replace(/^Frontier\s+/i, "") : undefined}
        holdsSelection={frontierHoldsSelection}
      />

      {expanded === "frontier" &&
        PROFILES_LIST.map((profile) => {
          const model = runs(profile.id);
          const active = currentProfile === profile.id && !agentSelection;
          const description =
            profile.id === "auto"
              ? "Light model for everyday turns, heavier one when a task is hard"
              : profile.id === "flash"
                ? "The lightest installed model, every turn"
                : profile.id === "max"
                  ? "Frontier Max online model with built-in key"
                  : "Google Gemini 3.8 Flash (Free BYOK)";

          let metaNode: React.ReactNode;
          if (profile.id === "max") {
            metaNode = <span className="font-mono text-purple-300">gemini-3.8-flash</span>;
          } else if (profile.id === "gemini") {
            metaNode = googleConfigured ? (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  setGeminiKeyModalOpen(true);
                  onClose();
                }}
                className="font-mono text-emerald-300 hover:text-emerald-100 cursor-pointer inline-flex items-center gap-1 group/key"
                title="Click to configure or change your Google Gemini API key"
              >
                <span>gemini-3.8-flash</span>
                <KeyRound size={10} className="text-emerald-400 group-hover/key:text-emerald-200 transition-colors" />
              </span>
            ) : (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  setGeminiKeyModalOpen(true);
                  onClose();
                }}
                className="text-emerald-400 hover:underline cursor-pointer font-medium"
              >
                Free (BYOK)
              </span>
            );
          } else if (loading) {
            metaNode = <Loader2 size={9} className="animate-spin inline" />;
          } else if (model) {
            metaNode = <span className="font-mono">{model.tag}</span>;
          } else {
            metaNode = <span className="text-warning">no model fits</span>;
          }

          return (
            <Row
              key={profile.id}
              rowKey={`profile:${profile.id}`}
              icon={ICONS[profile.id]}
              label={profile.name.replace(/^Frontier\s+/i, "")}
              active={active}
              disabled={false}
              title={[
                description,
                profile.id === "max"
                  ? "runs gemini-3.8-flash (Built-in Key)"
                  : profile.id === "gemini"
                    ? googleConfigured
                      ? "runs gemini-3.8-flash with your Google key"
                      : "Requires Google Gemini API key (click to add your free key)"
                    : model
                      ? `runs ${model.tag} (${formatBytes(model.bytes)})`
                      : null,
                profile.id === "auto" && routing?.heavy && routing.heavy.tag !== routing.light?.tag
                  ? `escalates to ${routing.heavy.tag}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              meta={metaNode}
              onSelect={() => {
                if (profile.id === "gemini" && !googleConfigured) {
                  setGeminiKeyModalOpen(true);
                  onClose();
                  return;
                }
                setProfile(profile.id);
                onClose();
              }}
            />
          );
        })}

      {installedAgents.map((engine) => {
        // An agent that is not installed is left out rather than shown greyed:
        // the pane already explains the install when you open its tab, and a
        // dead row in a picker is just noise.
        const descriptor = agents![engine];
        const set = agentModels![engine];
        const holdsSelection = agentSelection?.engine === engine;
        const selectedModel = holdsSelection
          ? set.models.find((model) => model.id === agentSelection?.model)
          : undefined;

        return (
          <div key={engine}>
            <Branch
              id={engine}
              icon={<BrandGlyph brand={engine} size={14} />}
              label={descriptor.label}
              trailing={descriptor.version ?? undefined}
              summary={selectedModel?.label}
              holdsSelection={holdsSelection}
            />

            {expanded === engine && (
              <>
                {set.models.map((model) => {
                  const active = holdsSelection && agentSelection?.model === model.id;
                  // Provenance still matters, but it is a footnote, not a
                  // headline. It lives in the tooltip beside the detail it
                  // qualifies.
                  const provenance =
                    model.source === "observed"
                      ? "confirmed by the CLI"
                      : model.source === "config"
                        ? "from your config"
                        : model.resolves
                          ? "not yet confirmed"
                          : null;
                  return (
                    <Row
                      key={`${engine}:${model.id ?? "default"}`}
                      rowKey={`${engine}:${model.id ?? "default"}`}
                      icon={<BrandGlyph brand={engine} size={14} />}
                      label={model.label}
                      active={Boolean(active)}
                      title={[model.detail, model.resolves, provenance].filter(Boolean).join(" · ")}
                      meta={model.resolves ? <span className="font-mono">{model.resolves}</span> : undefined}
                      onSelect={() => {
                        setAgentSelection({
                          engine,
                          model: model.id,
                          label: `${descriptor.label} · ${model.label}`,
                        });
                        onClose();
                      }}
                    />
                  );
                })}

                {/* An agent selected in the composer used to run at the CLI
                    default with no way to change it — the permission selector
                    existed only in the agent tabs. It belongs wherever the
                    agent is chosen, which is inside that agent's branch. */}
                {holdsSelection && (
                  <>
                    {(descriptor.permissions ?? []).length > 0 && (
                      <>
                        <SubGroup>Permissions</SubGroup>
                        {(descriptor.permissions ?? []).map((value) => {
                          const active = (agentPermission ?? descriptor.defaultPermission) === value;
                          const danger = value === "bypassPermissions" || value === "danger-full-access";
                          return (
                            <Row
                              key={value}
                              rowKey={`perm:${value}`}
                              icon={<ShieldAlert size={13} className={danger ? "text-warning" : "text-ink-muted"} />}
                              label={PERMISSION_LABELS[value] ?? value}
                              active={active}
                              title={PERMISSION_DETAIL[value] ?? value}
                              onSelect={() => setAgentPermission(value)}
                            />
                          );
                        })}
                      </>
                    )}

                    {/* ── The other two rungs the CLI already has ─────────────
                        A turn from this composer ran at whatever `~/.claude` or
                        `~/.codex/config.toml` said, with the app offering no way
                        to say otherwise: the operator had to leave, edit a
                        config file, and come back. Both knobs now sit where the
                        agent is chosen, beside its permissions, and both are
                        rendered from what the gateway reports the installed
                        binary accepts — so the menu can never offer a level the
                        CLI would reject and fail the turn on.

                        Each group leads with "CLI default", which passes no flag
                        at all, and that is the shipped state on purpose: a
                        picker that silently overrides a config file the operator
                        wrote is worse than one that starts out offering
                        nothing. */}
                    {(descriptor.efforts ?? []).length > 0 && (
                      <>
                        <SubGroup>Effort</SubGroup>
                        <Row
                          rowKey="effort:default"
                          icon={<Gauge size={13} className="text-ink-muted" />}
                          label={CLI_DEFAULT_LABEL}
                          active={!agentEffort}
                          title={`Pass no effort flag; ${descriptor.label}'s own setting stands`}
                          onSelect={() => setAgentEffort(null)}
                        />
                        {(descriptor.efforts ?? []).map((value) => (
                          <Row
                            key={`effort:${value}`}
                            rowKey={`effort:${value}`}
                            icon={<Gauge size={13} className="text-ink-muted" />}
                            label={EFFORT_LABELS[value] ?? value}
                            active={agentEffort === value}
                            title={EFFORT_DETAIL[value] ?? value}
                            onSelect={() => setAgentEffort(value)}
                          />
                        ))}
                      </>
                    )}

                    {(descriptor.thinking ?? []).length > 0 && (
                      <>
                        <SubGroup>Thinking</SubGroup>
                        <Row
                          rowKey="thinking:default"
                          icon={<Brain size={13} className="text-ink-muted" />}
                          label={CLI_DEFAULT_LABEL}
                          active={!agentThinking}
                          title={`Pass no reasoning flag; ${descriptor.label}'s own setting stands`}
                          onSelect={() => setAgentThinking(null)}
                        />
                        {(descriptor.thinking ?? []).map((value) => (
                          <Row
                            key={`thinking:${value}`}
                            rowKey={`thinking:${value}`}
                            icon={<Brain size={13} className="text-ink-muted" />}
                            label={THINKING_LABELS[value] ?? value}
                            active={agentThinking === value}
                            title={THINKING_DETAIL[value] ?? value}
                            onSelect={() => setAgentThinking(value)}
                          />
                        ))}
                      </>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
};
