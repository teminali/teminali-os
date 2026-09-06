import React, { useEffect, useState } from "react";
import { Check, Loader2, Lock, ShieldAlert, Sparkles, Zap } from "lucide-react";
import { BrandGlyph } from "../ui";
import { ModelService, formatBytes, type RoutingPlan } from "../../services/modelService";
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
 * Below the Frontier lanes sit the two agent CLIs, when they are installed.
 * Picking one of those does not swap a model behind the same engine — it sends
 * the conversation to Claude Code or Codex as a process, with that CLI's own
 * tools and permissions. The list keeps the same discipline as the lanes above:
 * an alias is shown with what it actually resolves to, and the interface says
 * whether that resolution was observed on this machine or is only our shipped
 * best knowledge. See server/agent-models.js for why that distinction exists.
 */

export interface ModelPickerProps {
  open: boolean;
  onClose: () => void;
}

/** Shared with AgentPane — the same rung must read the same in both places. */
const PERMISSION_LABELS: Record<string, string> = {
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
 * One glyph per profile, and the only place they are chosen.
 *
 * The composer's own trigger reads from this map rather than drawing its own,
 * because it drew a hardcoded `Lock` — Max's glyph — beside whichever profile
 * was actually selected, so Flash and Auto both wore a padlock and read as
 * unavailable. Max's lock is real (it stays locked until safety
 * qualification); the other two never were.
 */
export const PROFILE_ICONS: Record<ModelProfileId, React.ReactNode> = {
  flash: <Zap size={13} className="text-accent" strokeWidth={2.2} />,
  auto: <Sparkles size={13} className="text-reason" />,
  max: <Lock size={13} className="text-ink-muted" />,
};

const ICONS = PROFILE_ICONS;

export const ModelPicker: React.FC<ModelPickerProps> = ({ open, onClose }) => {
  const { currentProfile, setProfile, agentSelection, setAgentSelection, agentPermission, setAgentPermission } =
    useStudioStore();
  const ref = React.useRef<HTMLDivElement>(null);
  /*
    How tall this menu may be, in pixels, and why it is measured.

    The menu is `bottom-11` off the composer, so it grows UPWARDS from a
    fixed edge. A `vh` cap cannot know where that edge is: on the empty
    chat the composer is vertically centred, which left `62vh` of list
    running off the TOP of the window with its first rows unreachable —
    scrolling does not help when the scroll container itself has gone off
    screen. The bottom edge does not move when the height changes, so
    reading it once after layout is stable, and `resize` is the only
    thing that can invalidate it.
  */
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  const [routing, setRouting] = useState<RoutingPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [agents, setAgents] = useState<Record<AgentEngine, AgentDescriptor> | null>(null);
  const [agentModels, setAgentModels] = useState<Record<AgentEngine, AgentModelSet> | null>(null);

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
  }, [open]);

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

  /**
   * Every selectable row, in visual order.
   *
   * The menu is three groups — Frontier lanes, an agent's permissions, each
   * agent's models — but the keyboard has to walk it as one list, so the flat
   * index is derived here and each group renders against it. Building it in
   * render order is what keeps the arrows matching what the eye sees.
   */
  const rows: { key: string; run: () => void; disabled?: boolean }[] = [];
  for (const profile of PROFILES_LIST) {
    rows.push({
      key: `profile:${profile.id}`,
      disabled: profile.id === "max" && !routing?.heavy,
      run: () => {
        setProfile(profile.id);
        onClose();
      },
    });
  }
  if (agentSelection && agents?.[agentSelection.engine]) {
    for (const value of agents[agentSelection.engine].permissions ?? []) {
      rows.push({ key: `perm:${value}`, run: () => setAgentPermission(value) });
    }
  }
  for (const engine of ["claude", "codex"] as AgentEngine[]) {
    const descriptor = agents?.[engine];
    const set = agentModels?.[engine];
    if (!descriptor?.installed || !set) continue;
    for (const model of set.models) {
      rows.push({
        key: `${engine}:${model.id ?? "default"}`,
        run: () => {
          setAgentSelection({ engine, model: model.id, label: `${descriptor.label} · ${model.label}` });
          onClose();
        },
      });
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
    if (!routing) return null;
    if (id === "flash") return routing.light;
    if (id === "max") return routing.heavy;
    return routing.light;
  };

  /* ── One row, for every model in the menu ───────────────────────────────
     Every entry here is the same object: a 28px line with a glyph, a name, and
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
      className={`w-full h-6 px-2 rounded-md flex items-center gap-2 text-sm transition-colors duration-ds ease-ds disabled:opacity-40 ${
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
      {meta && <span className="text-2xs text-ink-soft truncate max-w-[128px]">{meta}</span>}
      {active && <Check size={12} className="text-ink-muted flex-shrink-0" />}
    </button>
    );
  };

  const Group: React.FC<{ children: React.ReactNode; trailing?: string }> = ({ children, trailing }) => (
    <div className="flex items-center justify-between h-5 px-2 mt-0.5 first:mt-0">
      <span className="text-2xs text-ink-faint">{children}</span>
      {trailing && <span className="text-2xs text-ink-disabled truncate max-w-[120px]">{trailing}</span>}
    </div>
  );

  return (
    <div
      ref={ref}
      role="menu"
      className="lit lit-strong absolute bottom-11 left-0 z-30 w-[284px] overflow-y-auto rounded-xl bg-surface-popover shadow-popover p-1 animate-in"
      style={{ maxHeight }}
    >
      <Group>Frontier</Group>
      {PROFILES_LIST.map((profile) => {
        const model = runs(profile.id);
        const locked = profile.id === "max" && !routing?.heavy;
        const active = currentProfile === profile.id && !agentSelection;
        const description =
          profile.id === "auto"
            ? "Light model for everyday turns, heavier one when a task is hard"
            : profile.id === "flash"
              ? "The lightest installed model, every turn"
              : "The heaviest model that fits, every turn";

        return (
          <Row
            key={profile.id}
            rowKey={`profile:${profile.id}`}
            icon={ICONS[profile.id]}
            label={profile.name}
            active={active}
            disabled={locked}
            title={[
              description,
              model ? `runs ${model.tag} (${formatBytes(model.bytes)})` : null,
              // Auto's escalation target used to have a line of its own. It is
              // still named — a lane that can silently switch models must say
              // what it switches to — but as a footnote rather than a row.
              profile.id === "auto" && routing?.heavy && routing.heavy.tag !== routing.light?.tag
                ? `escalates to ${routing.heavy.tag}`
                : null,
            ].filter(Boolean).join(" · ")}
            meta={
              loading ? (
                <Loader2 size={9} className="animate-spin inline" />
              ) : model ? (
                <span className="font-mono">{model.tag}</span>
              ) : (
                <span className="text-warning">no model fits</span>
              )
            }
            onSelect={() => {
              setProfile(profile.id);
              onClose();
            }}
          />
        );
      })}

      {/* An agent selected in the composer used to run at the CLI default with
          no way to change it — the permission selector existed only in the
          agent tabs. It belongs wherever the agent is chosen. */}
      {agentSelection && agents?.[agentSelection.engine] && (
        <div className="mt-1 pt-1 border-t border-edge">
          <Group>Permissions</Group>
          {(agents[agentSelection.engine].permissions ?? []).map((value) => {
            const active = (agentPermission ?? agents[agentSelection.engine].defaultPermission) === value;
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
        </div>
      )}

      {(["claude", "codex"] as AgentEngine[]).map((engine) => {
        const descriptor = agents?.[engine];
        // An agent that is not installed is left out rather than shown greyed:
        // the pane already explains the install when you open its tab, and a
        // dead row in a picker is just noise.
        if (!descriptor?.installed) return null;
        const set = agentModels?.[engine];
        if (!set) return null;

        return (
          <div key={engine}>
            <Group trailing={descriptor.version ?? undefined}>{descriptor.label}</Group>
            {set.models.map((model) => {
              const active = agentSelection?.engine === engine && agentSelection.model === model.id;
              // Provenance still matters, but it is a footnote, not a headline.
              // It lives in the tooltip beside the detail it qualifies.
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
                  active={active}
                  title={[model.detail, model.resolves, provenance].filter(Boolean).join(" · ")}
                  meta={model.resolves ? <span className="font-mono">{model.resolves}</span> : undefined}
                  onSelect={() => {
                    setAgentSelection({ engine, model: model.id, label: `${descriptor.label} · ${model.label}` });
                    onClose();
                  }}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
};
