import React, { useEffect, useState } from "react";
import { AlertTriangle, Check, ExternalLink } from "lucide-react";
import { Button } from "../ui/Button";
import { StatusDot } from "../ui/Primitives";
import { SettingGroup, SettingRow, SettingSelect, SettingToggle } from "../ui/Setting";
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
 *
 * **Shape.** This was the last screen in settings still writing its own rows:
 * five bare `<section>`s, three `SegmentedTabs`, two raw checkboxes and a
 * hand-built permission card, at a type scale a step larger than every pane
 * beside it. It is the `Setting` row family now. The three segmented controls
 * became `SettingSelect`s for the reason Run Mode did on the Agents screen —
 * each option needs a sentence of consequence, and a sentence that changes with
 * the control says more than three words fighting for the width of a row.
 */

/** What {@link Window.electronBridge} reports back from a reveal attempt. */
interface ScreenRecordingReveal {
  ok: boolean;
  bundlePath?: string;
  isDevelopmentBundle?: boolean;
  reason?: string;
}

/**
 * The bundle's own name, for telling the operator which icon to drag.
 * Falls back to a generic phrase rather than rendering an empty code span.
 */
function bundleName(bundlePath?: string): string {
  const leaf = bundlePath?.split("/").filter(Boolean).pop();
  return leaf || "the app";
}

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

/**
 * The tiers, worded from `gateway/frontier-runner.js` `MODEL_MODES` rather than
 * invented here — that table is what the routing actually consults.
 */
const FRONTIER_MODES: Array<{ id: AssistantFrontierMode; label: string; detail: string }> = [
  { id: "flash", label: "Flash", detail: "The lightweight local model for every question, however hard." },
  { id: "auto", label: "Auto", detail: "Routes between the lightweight and heavyweight local models by what the question needs." },
  { id: "max", label: "Max", detail: "The heavyweight local model for every question, however simple." },
];

export const AssistantSettingsPanel: React.FC<{ assistant: UseAssistantResult }> = ({ assistant }) => {
  const { settings, capabilities, update } = assistant;
  const [hotkey, setHotkey] = useState<AssistantHotkeyStatus | null>(null);
  /* Absent in a browser build, which is why every use of it is guarded. */
  const bridge = window.teminali?.assistant;

  useEffect(() => {
    if (!bridge) return;
    bridge.hotkeyStatus().then(setHotkey).catch(() => setHotkey(null));
  }, [settings.hotkey, bridge]);

  useEffect(() => {
    void assistant.refreshCapabilities();
  }, [assistant]);

  /**
   * What the last "Show me both" did. Kept so the panel can name the bundle it
   * revealed: "drag me in" is only actionable once the operator knows which
   * icon is me, and in a development run that icon says Electron.
   */
  const [reveal, setReveal] = useState<ScreenRecordingReveal | null>(null);

  async function showScreenRecordingList() {
    if (!bridge?.revealForScreenRecording) return;
    try {
      setReveal(await bridge.revealForScreenRecording());
    } catch {
      // The bridge is there and it still failed, so the pane may not have
      // opened either. Say so rather than leaving the button looking inert.
      setReveal({ ok: false, reason: "I could not open the Screen Recording list." });
    }
  }

  const permissionRows = capabilities?.supported && capabilities.helperBuilt
    ? [
        {
          id: "screen" as const,
          granted: capabilities.screenRecordingGranted,
          label: "Screen Recording",
          lost: "Without it the assistant cannot see your screen at all.",
          pane: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        },
        {
          id: "accessibility" as const,
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
      <SettingGroup
        label="Screen access"
        description="Neither switch can be flipped by an application. Both live in System Settings › Privacy & Security, and macOS requires a person to grant them."
      >
        {!capabilities ? (
          <p className="px-3.5 py-3 text-2xs text-ink-faint">Checking…</p>
        ) : !capabilities.supported ? (
          <p className="px-3.5 py-3 text-2xs text-ink-faint">
            {capabilities.detail ?? "Screen control is macOS-only."}
          </p>
        ) : !capabilities.helperBuilt ? (
          <div className="space-y-1.5 bg-warning/5 px-3.5 py-3">
            <p className="flex items-center gap-2 text-xs text-warning">
              <AlertTriangle size={13} strokeWidth={1.8} />
              The pointer helper has not been built
            </p>
            <p className="text-2xs leading-relaxed text-ink-muted">
              It is a small Swift program in <code className="text-ink-dim">native/macos/pointer</code>, compiled on
              demand rather than shipped as a binary. Build it with{" "}
              <code className="text-ink-dim">npm run build:pointer</code>, then reopen this panel.
            </p>
          </div>
        ) : (
          permissionRows.map((row) => (
            <React.Fragment key={row.id}>
              <SettingRow
                label={
                  <span className="flex items-center gap-2">
                    {row.granted ? <Check size={13} className="text-success" /> : <StatusDot tone="warning" />}
                    {row.label} — {row.granted ? "granted" : "not granted"}
                  </span>
                }
                description={row.granted ? undefined : row.lost}
                className={row.granted ? undefined : "bg-warning/5"}
              >
                {!row.granted && (
                  <>
                    {row.id === "accessibility" && (
                      <Button variant="secondary" size="xs" onClick={() => void assistant.requestPermissions()}>
                        Ask macOS
                      </Button>
                    )}
                    {/* Screen Recording has no prompt to ask with, so the offer
                        is the list and the thing to drag into it. The browser
                        build has no bridge and falls back to the link, which is
                        all it can honestly do. */}
                    {row.id === "screen" && bridge?.revealForScreenRecording ? (
                      <Button variant="secondary" size="xs" onClick={() => void showScreenRecordingList()}>
                        Show me both
                      </Button>
                    ) : (
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
                    )}
                  </>
                )}
              </SettingRow>

              {/* The drag-me-in explainer is its own full-width cell rather than
                  a paragraph inside the row above: it is four sentences and a
                  status line, and the right-hand column is for a control. */}
              {row.id === "screen" && !row.granted && bridge?.revealForScreenRecording && (
                <div className="space-y-1.5 px-3.5 py-3">
                  <p className="text-2xs leading-relaxed text-ink-muted">
                    macOS will not let me add myself to this list — no application can. Open it and drag me in.
                  </p>
                  <p className="text-2xs leading-relaxed text-ink-faint">
                    If you have installed me before, there is already an older me in that list under a code identity
                    this build no longer has. Dropping me on top of it replaces that row. Flipping its switch does not,
                    which is why the permission can read as granted while the screen stays black.
                  </p>
                  {reveal && (
                    <p className="pt-0.5 text-2xs leading-relaxed" role="status">
                      {reveal.ok ? (
                        <span className="text-ink-muted">
                          Opened the list, and revealed{" "}
                          <code className="text-ink-dim">{bundleName(reveal.bundlePath)}</code> in Finder. Drag it in,
                          then recheck.
                          {reveal.isDevelopmentBundle && (
                            <>
                              {" "}
                              This is a development run, so the bundle is the Electron shell rather than Teminali OS —
                              that is the one macOS is being asked to trust here.
                            </>
                          )}
                        </span>
                      ) : (
                        <span className="text-warning">{reveal.reason}</span>
                      )}
                    </p>
                  )}
                  <div className="flex items-center gap-1.5 pt-0.5">
                    <Button variant="ghost" size="xs" onClick={() => void assistant.refreshCapabilities()}>
                      Recheck
                    </Button>
                  </div>
                </div>
              )}
            </React.Fragment>
          ))
        )}
      </SettingGroup>

      {/* ── What it does ────────────────────────────────────────────────── */}
      <SettingGroup label="What it does">
        <SettingRow
          label="What the microphone does"
          description={MODES.find((mode) => mode.id === settings.mode)?.detail}
        >
          <SettingSelect
            value={settings.mode}
            aria-label="What the microphone does"
            onChange={(event) => update({ mode: event.target.value as AssistantMode })}
          >
            {MODES.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.label}
              </option>
            ))}
          </SettingSelect>
        </SettingRow>

        <SettingRow
          label="When it acts"
          description={
            <>
              {AUTONOMY.find((rung) => rung.id === settings.autonomy)?.detail}
              {settings.mode !== "agent" && " This only applies in Agent mode."}
            </>
          }
        >
          <SettingSelect
            value={settings.autonomy}
            aria-label="When it acts"
            onChange={(event) => update({ autonomy: event.target.value as AssistantAutonomy })}
          >
            {AUTONOMY.map((rung) => (
              <option key={rung.id} value={rung.id}>
                {rung.label}
              </option>
            ))}
          </SettingSelect>
        </SettingRow>

        <SettingRow
          label="Which engine answers"
          description={
            <>
              {ENGINES.find((engine) => engine.id === settings.engine)?.detail} All three are asked the same question
              and held to the same rules about what they may name, so changing this changes who answers and nothing
              else.
            </>
          }
        >
          <SettingSelect
            value={settings.engine}
            aria-label="Which engine answers"
            onChange={(event) => update({ engine: event.target.value as AssistantEngine })}
          >
            {ENGINES.map((engine) => (
              <option key={engine.id} value={engine.id}>
                {engine.label}
              </option>
            ))}
          </SettingSelect>
        </SettingRow>

        {settings.engine === "frontier" && (
          <SettingRow
            label="Frontier tier"
            description={FRONTIER_MODES.find((mode) => mode.id === settings.frontierMode)?.detail}
          >
            <SettingSelect
              value={settings.frontierMode}
              aria-label="Frontier tier"
              onChange={(event) => update({ frontierMode: event.target.value as AssistantFrontierMode })}
            >
              {FRONTIER_MODES.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.label}
                </option>
              ))}
            </SettingSelect>
          </SettingRow>
        )}
      </SettingGroup>

      {/* ── Output ──────────────────────────────────────────────────────── */}
      <SettingGroup label="How it answers">
        <SettingRow label="Read answers aloud" description="Uses the same voice tier as dictation.">
          <SettingToggle
            checked={settings.speak}
            onChange={(speak) => update({ speak })}
            label="Read answers aloud"
          />
        </SettingRow>
        <SettingRow
          label="Draw on the screen"
          description="A ring around the control it means, over whatever application it belongs to. Desktop only."
        >
          <SettingToggle
            checked={settings.overlay}
            onChange={(overlay) => update({ overlay })}
            label="Draw on the screen"
          />
        </SettingRow>
      </SettingGroup>

      {/* ── Shortcut ────────────────────────────────────────────────────── */}
      {bridge && (
        <SettingGroup label="Shortcut">
          <SettingRow
            label="Open the assistant with"
            description={
              <>
                An Electron accelerator, for example{" "}
                <code className="text-ink-dim">CommandOrControl+Shift+Space</code>. If another application already owns
                the combination it cannot be registered, and the line beside it says so rather than leaving you with a
                key that quietly does nothing.
              </>
            }
          >
            <input
              value={settings.hotkey}
              onChange={(event) => update({ hotkey: event.target.value })}
              aria-label="Assistant shortcut"
              spellCheck={false}
              className="lit lit-inner h-7 w-[190px] rounded-md bg-surface-raised px-2 font-mono text-xs text-ink-body outline-none"
            />
            {hotkey && (
              <span className={`text-2xs ${hotkey.registered ? "text-ink-faint" : "text-warning"}`}>
                {hotkey.registered ? "Registered" : (hotkey.reason ?? "Not registered")}
              </span>
            )}
          </SettingRow>
        </SettingGroup>
      )}
    </div>
  );
};

/** The row labels this pane carries, for the settings rail's search. */
export const ASSISTANT_ROWS = [
  "Screen Recording",
  "Accessibility",
  "What the microphone does",
  "When it acts",
  "Which engine answers",
  "Frontier tier",
  "Read answers aloud",
  "Draw on the screen",
  "Open the assistant with",
];
