import React, { useEffect, useState } from "react";
import { AlertTriangle, Check, ExternalLink } from "lucide-react";
import { Button } from "../ui/Button";
import { SegmentedTabs } from "../ui/SegmentedTabs";
import { StatusDot } from "../ui/Primitives";
import type { AssistantAutonomy, AssistantEngine, AssistantFrontierMode, AssistantMode } from "../../services/assistant/types";
import type { UseAssistantResult } from "../../hooks/useAssistant";
import type { AssistantHotkeyStatus } from "../layout/WindowControls";

/**
 * Everything the assistant does, in one place.
 *
 * The menu bar item can change all of this too, and it must not be the only
 * place that can: a browser build has no tray at all, and an operator who
 * cannot find the switch that decides whether something clicks on their screen
 * has been given a setting they do not control.
 *
 * The two permission rows say which switch is missing and what is lost by it,
 * rather than a single "grant access" that would say neither. Neither can be
 * granted from here — they are System Settings toggles that only a person can
 * flip — so the honest offer is the system's own prompt and a link to the pane.
 */

const MODES: Array<{ id: AssistantMode; label: string; detail: string }> = [
  { id: "dictate", label: "Dictate", detail: "What you say goes into the composer, cleaned up and shown to you first." },
  { id: "talk", label: "Talk", detail: "It looks at your screen, answers out loud, and points at what it means." },
  { id: "agent", label: "Agent", detail: "It can also click, type and scroll for you, at the rung you choose below." },
];

const AUTONOMY: Array<{ id: AssistantAutonomy; label: string; detail: string }> = [
  { id: "guide", label: "Guide only", detail: "Draws every step and touches nothing — not even your pointer." },
  { id: "confirm", label: "Ask each time", detail: "Runs a step only after you say so. This is the default." },
  { id: "auto", label: "Run the plan", detail: "Carries out the whole plan without stopping." },
];

const ENGINES: Array<{ id: AssistantEngine; label: string; detail: string }> = [
  { id: "frontier", label: "Frontier", detail: "Runs locally against Ollama. Nothing leaves the machine." },
  { id: "claude", label: "Claude Code", detail: "Your own CLI, invoked read-only for the question." },
  { id: "codex", label: "Codex", detail: "Your own CLI, invoked read-only for the question." },
];

const FRONTIER_MODES: AssistantFrontierMode[] = ["flash", "auto", "max"];

export const AssistantSettingsPanel: React.FC<{ assistant: UseAssistantResult }> = ({ assistant }) => {
  const { settings, capabilities, update } = assistant;
  const [hotkey, setHotkey] = useState<AssistantHotkeyStatus | null>(null);

  useEffect(() => {
    const bridge = window.teminali?.assistant;
    if (!bridge) return;
    bridge.hotkeyStatus().then(setHotkey).catch(() => setHotkey(null));
  }, [settings.hotkey]);

  useEffect(() => {
    void assistant.refreshCapabilities();
  }, [assistant]);

  const permissionRows = capabilities?.supported && capabilities.helperBuilt
    ? [
        {
          granted: capabilities.screenRecordingGranted,
          label: "Screen Recording",
          lost: "Without it the assistant cannot see your screen at all.",
          pane: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        },
        {
          granted: capabilities.accessibilityTrusted,
          label: "Accessibility",
          lost: "Without it the assistant can describe your screen but cannot point at or touch anything on it.",
          pane: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        },
      ]
    : [];

  return (
    <div className="space-y-6">
      {/* ── Permissions ─────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <h2 className="text-sm text-ink-bright">Screen access</h2>

        {!capabilities ? (
          <p className="text-2xs text-ink-faint">Checking…</p>
        ) : !capabilities.supported ? (
          <p className="text-2xs text-ink-faint">{capabilities.detail ?? "Screen control is macOS-only."}</p>
        ) : !capabilities.helperBuilt ? (
          <div className="rounded-xl border border-edge bg-surface-sunken p-3 space-y-1.5">
            <p className="flex items-center gap-2 text-sm text-warning">
              <AlertTriangle size={13} strokeWidth={1.8} />
              The pointer helper has not been built
            </p>
            <p className="text-2xs text-ink-muted leading-relaxed">
              It is a small Swift program in <code className="text-ink-dim">native/macos/pointer</code>, compiled on
              demand rather than shipped as a binary. Build it with{" "}
              <code className="text-ink-dim">npm run build:pointer</code>, then reopen this panel.
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-edge divide-y divide-edge overflow-hidden">
            {permissionRows.map((row) => (
              <div key={row.label} className="flex items-start gap-3 p-3">
                <span className="mt-0.5">
                  {row.granted ? <Check size={14} className="text-success" /> : <StatusDot tone="warning" />}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-ink-high">
                    {row.label} — {row.granted ? "granted" : "not granted"}
                  </p>
                  {!row.granted && <p className="text-2xs text-ink-faint mt-0.5 leading-relaxed">{row.lost}</p>}
                </div>
                {!row.granted && (
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {row.label === "Accessibility" && (
                      <Button variant="secondary" size="xs" onClick={() => void assistant.requestPermissions()}>
                        Ask macOS
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="xs"
                      icon={<ExternalLink size={11} />}
                      // Not "_self": that would navigate the studio itself to
                      // an x-apple.systempreferences: URL and leave a blank
                      // window. A plain window.open goes through the shell's
                      // open handler, which hands it to the operating system.
                      onClick={() => window.open(row.pane)}
                    >
                      Settings
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="text-2xs text-ink-faint leading-relaxed">
          Neither switch can be flipped by an application. Both live in System Settings › Privacy &amp; Security, and
          macOS requires a person to grant them.
        </p>
      </section>

      {/* ── Mode ────────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <h2 className="text-sm text-ink-bright">What the microphone does</h2>
        <SegmentedTabs
          tabs={MODES.map((mode) => ({ id: mode.id, label: mode.label }))}
          activeTab={settings.mode}
          onChange={(mode) => update({ mode })}
        />
        <p className="text-2xs text-ink-faint leading-relaxed">
          {MODES.find((mode) => mode.id === settings.mode)?.detail}
        </p>
      </section>

      {/* ── Autonomy ────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <h2 className="text-sm text-ink-bright">When it acts</h2>
        <SegmentedTabs
          tabs={AUTONOMY.map((rung) => ({ id: rung.id, label: rung.label }))}
          activeTab={settings.autonomy}
          onChange={(autonomy) => update({ autonomy })}
        />
        <p className="text-2xs text-ink-faint leading-relaxed">
          {AUTONOMY.find((rung) => rung.id === settings.autonomy)?.detail}
          {settings.mode !== "agent" && " This only applies in Agent mode."}
        </p>
      </section>

      {/* ── Engine ──────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <h2 className="text-sm text-ink-bright">Which engine answers</h2>
        <SegmentedTabs
          tabs={ENGINES.map((engine) => ({ id: engine.id, label: engine.label }))}
          activeTab={settings.engine}
          onChange={(engine) => update({ engine })}
        />
        <p className="text-2xs text-ink-faint leading-relaxed">
          {ENGINES.find((engine) => engine.id === settings.engine)?.detail} All three are asked the same question and
          held to the same rules about what they may name, so changing this changes who answers and nothing else.
        </p>
        {settings.engine === "frontier" && (
          <div className="pt-1">
            <SegmentedTabs
              tabs={FRONTIER_MODES.map((mode) => ({ id: mode, label: mode[0].toUpperCase() + mode.slice(1) }))}
              activeTab={settings.frontierMode}
              onChange={(frontierMode) => update({ frontierMode })}
            />
          </div>
        )}
      </section>

      {/* ── Output ──────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <h2 className="text-sm text-ink-bright">How it answers</h2>
        <label className="flex items-start gap-2.5 text-sm text-ink-muted cursor-pointer">
          <input
            type="checkbox"
            checked={settings.speak}
            onChange={(event) => update({ speak: event.target.checked })}
            className="mt-0.5"
          />
          <span>
            Read answers aloud
            <span className="block text-2xs text-ink-faint">Uses the same voice tier as dictation.</span>
          </span>
        </label>
        <label className="flex items-start gap-2.5 text-sm text-ink-muted cursor-pointer">
          <input
            type="checkbox"
            checked={settings.overlay}
            onChange={(event) => update({ overlay: event.target.checked })}
            className="mt-0.5"
          />
          <span>
            Draw on the screen
            <span className="block text-2xs text-ink-faint">
              A ring around the control it means, over whatever application it belongs to. Desktop only.
            </span>
          </span>
        </label>
      </section>

      {/* ── Shortcut ────────────────────────────────────────────────────── */}
      {window.teminali?.assistant && (
        <section className="space-y-2">
          <h2 className="text-sm text-ink-bright">Shortcut</h2>
          <div className="flex items-center gap-2">
            <input
              value={settings.hotkey}
              onChange={(event) => update({ hotkey: event.target.value })}
              spellCheck={false}
              className="lit lit-inner flex-1 min-w-0 px-2.5 py-1.5 bg-surface rounded-lg text-xs font-mono text-ink-bright focus:outline-none"
            />
            {hotkey && (
              <span className={`text-2xs flex-shrink-0 ${hotkey.registered ? "text-ink-faint" : "text-warning"}`}>
                {hotkey.registered ? "Registered" : (hotkey.reason ?? "Not registered")}
              </span>
            )}
          </div>
          <p className="text-2xs text-ink-faint leading-relaxed">
            An Electron accelerator, for example <code className="text-ink-dim">CommandOrControl+Shift+Space</code>. If
            another application already owns the combination it cannot be registered, and the line above says so rather
            than leaving you with a key that quietly does nothing.
          </p>
        </section>
      )}
    </div>
  );
};
