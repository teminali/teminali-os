import React, { useEffect, useState } from "react";
import { SettingGroup, SettingRow, SettingSelect, SettingToggle } from "../ui/Setting";
import { PROFILES_LIST, useStudioStore } from "../../store/studioStore";
import { PROFILE_PICKER_COPY } from "../chat/ModelPicker";
import { ModelLibrary } from "./ModelLibrary";
import { ApiProviders } from "./ApiProviders";

/**
 * Where the operator decides what actually runs their turns.
 *
 * Two runtimes, one switch. Local keeps everything on the machine at no cost
 * per token; hosted trades that for capability. Both sides expose the same two
 * lanes and the same automatic routing, so the choice is about cost and privacy
 * rather than about learning a different product.
 *
 * The switch used to be a private segmented control carrying its own Tailwind,
 * one of the three screens still writing bespoke rows after the rest of
 * settings became a page. It is a `SettingSelect` now — the same shape Run Mode
 * takes on the Agents screen, for the same reason: a choice whose options each
 * need a sentence of consequence reads better as a label, a control, and a
 * sentence that changes with the control than as three words in a segment.
 *
 * The second group is the composer's menu, edited from here rather than from
 * inside itself: a menu that can hide its own rows has no row left to unhide
 * them from. It is a row family and not a catalogue because each entry is a
 * switch over a fixed, named thing — which is exactly what the rows on every
 * other settings screen are.
 *
 * What sits below both groups is deliberately not a row family. `ModelLibrary`
 * and `ApiProviders` are catalogues — a searchable list of weights, a card per
 * provider — and a catalogue in a divided card would be a list pretending to be
 * a set of settings.
 */

export type RuntimeMode = "local" | "api";

const STORAGE_KEY = "teminali_runtime_mode";

/** The consequence of each runtime, which is the whole content of the choice. */
const RUNTIME_COPY: Record<RuntimeMode, string> = {
  local:
    "Turns run on this machine through Ollama. Nothing leaves it and nothing is billed per token; what you can run is bounded by the memory you have.",
  api:
    "Turns go to a hosted provider — Anthropic, OpenAI or Google — using a key you supply, billed by that provider. Stronger models than this machine can hold, at the cost of the conversation leaving it.",
};

export const ModelsPane: React.FC = () => {
  const currentProfile = useStudioStore((state) => state.currentProfile);
  const preferences = useStudioStore((state) => state.preferences);
  const setPreferences = useStudioStore((state) => state.setPreferences);
  const [mode, setMode] = useState<RuntimeMode>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "api" ? "api" : "local";
    } catch {
      return "local";
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* Preference simply does not persist. */
    }
  }, [mode]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink-bright">Local Models &amp; Weights</h1>
        <p className="mt-1 max-w-xl text-xs leading-relaxed text-ink-muted">
          Run everything locally at no cost per token, or connect a hosted provider. Either way Frontier picks a light
          model for everyday turns and a stronger one when a task needs it.
        </p>
      </div>

      {/* One rhythm for the whole pane. `ModelLibrary` and `ApiProviders` stack
          their own cards at `gap-4`, so letting the runtime card sit in the
          outer `space-y-6` put a 24px gap above a 16px one and made the switch
          read as a separate screen rather than the first card of this one. The
          heading keeps its 24px, which is what every other pane does. */}
      <div className="flex flex-col gap-4">
        <SettingGroup label="Where turns run">
          <SettingRow label="Runtime" description={RUNTIME_COPY[mode]}>
            <SettingSelect
              value={mode}
              aria-label="Runtime"
              onChange={(event) => setMode(event.target.value as RuntimeMode)}
            >
              <option value="local">Local models</option>
              <option value="api">API keys</option>
            </SettingSelect>
          </SettingRow>
        </SettingGroup>

        {/* The one profile that cannot be hidden is the one in use, which is
            also what keeps the menu from emptying: `currentProfile` always
            names one of these four, whether or not an agent currently holds the
            selection instead. */}
        <SettingGroup
          label="In the model picker"
          description="Which of these the composer's picker offers. The one you are using stays on the menu."
        >
          {PROFILES_LIST.map((profile) => {
            const inUse = profile.id === currentProfile;
            const hidden = preferences.hiddenModelProfiles.includes(profile.id);
            return (
              <SettingRow key={profile.id} label={profile.name} description={PROFILE_PICKER_COPY[profile.id]}>
                {inUse && <span className="text-2xs text-ink-faint">In use</span>}
                <SettingToggle
                  checked={!hidden}
                  disabled={inUse}
                  label={`Show ${profile.name} in the model picker`}
                  onChange={(shown) =>
                    setPreferences({
                      hiddenModelProfiles: shown
                        ? preferences.hiddenModelProfiles.filter((id) => id !== profile.id)
                        : [...preferences.hiddenModelProfiles, profile.id],
                    })
                  }
                />
              </SettingRow>
            );
          })}
        </SettingGroup>

        {mode === "local" ? <ModelLibrary /> : <ApiProviders />}
      </div>
    </div>
  );
};

/**
 * The row labels this pane carries, for the settings rail's search.
 *
 * Derived from the profile list rather than typed out, so a profile added to
 * the picker becomes searchable in settings without anyone remembering to.
 */
export const MODELS_ROWS = ["Runtime", ...PROFILES_LIST.map((profile) => profile.name)];
