import React from "react";
import {
  SettingGroup,
  SettingRow,
  SettingSelect,
  SettingSlider,
  SettingStepper,
  SettingToggle,
} from "../ui/Setting";
import { useStudioStore } from "../../store/studioStore";
import {
  CODE_FONTS,
  UI_FONTS,
  hostPlatform,
  resolveChromeStyle,
  type ChromeStyle,
  type ResolvedChromeStyle,
  type ToolCallDensity,
} from "../../services/appearance";

const CHROME_LABEL: Record<ResolvedChromeStyle, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

/**
 * A live sample of the accent. It is not decoration: the accent control also
 * derives `--accent-ink`, and this is the only place an operator can see that
 * the label on a brand-filled button stays readable at the hue they picked.
 */
const AccentSwatch: React.FC = () => (
  <div className="flex items-center gap-2">
    <span className="rounded-md bg-accent px-2.5 py-1 text-2xs font-semibold text-accent-ink">
      Accent
    </span>
    <span className="h-6 w-6 rounded-md bg-accent-hover" title="Hover" />
    <span className="h-6 w-6 rounded-md bg-accent-dim" title="Pressed" />
  </div>
);

/**
 * Appearance.
 *
 * Every row here changes something an operator can see immediately — the store
 * writes through `applyAppearance`, so there is no Save button and no preview
 * that lies. Rows that Cursor has and we do not are absent rather than inert:
 * notably **Theme**, because this build has exactly one theme. The token sheet
 * is a measured dark palette with no light or high-contrast counterpart, so a
 * theme picker would be four options and one outcome. It returns when a second
 * palette exists — see `DESIGN.md` §0.
 */
export const AppearancePane: React.FC = () => {
  const appearance = useStudioStore((state) => state.appearance);
  const setAppearance = useStudioStore((state) => state.setAppearance);
  const resetAppearance = useStudioStore((state) => state.resetAppearance);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink-bright">Appearance</h1>
        <p className="mt-1 text-xs text-ink-muted">
          How the studio looks. Every control here is yours alone — none of it changes what a
          model sees or what an agent may do.
        </p>
      </div>

      <SettingGroup label="Interface">
        <SettingRow
          label="UI Font Size"
          description="Scales the whole type ramp — chrome, labels and body together."
        >
          <SettingStepper
            value={appearance.uiFontSize}
            onChange={(uiFontSize) => setAppearance({ uiFontSize })}
            min={11}
            max={17}
            unit="px"
            label="UI font size"
          />
        </SettingRow>
        <SettingRow
          label="UI Font Family"
          description="Each choice is a stack that falls back to the platform face if the font is not installed."
        >
          <SettingSelect
            value={appearance.uiFontFamily}
            onChange={(event) => setAppearance({ uiFontFamily: event.target.value })}
            aria-label="UI font family"
          >
            {Object.entries(UI_FONTS).map(([key, font]) => (
              <option key={key} value={key}>
                {font.label}
              </option>
            ))}
          </SettingSelect>
        </SettingRow>
        <SettingRow
          label="Reduce Transparency"
          description="Removes every backdrop blur in the interface. An accessibility control, not a preference."
        >
          <SettingToggle
            checked={appearance.reduceTransparency}
            onChange={(reduceTransparency) => setAppearance({ reduceTransparency })}
            label="Reduce transparency"
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup
        label="Accent"
        description="The brand green is hue 151 at full intensity. Moving off it is yours to make; the text colour on an accent fill follows automatically so it stays legible."
      >
        <SettingRow label="Hue" description="Where on the colour wheel the accent sits.">
          <SettingSlider
            value={appearance.accentHue}
            onChange={(accentHue) => setAppearance({ accentHue })}
            min={0}
            max={360}
            format={(value) => `${value}°`}
            label="Accent hue"
          />
        </SettingRow>
        <SettingRow label="Intensity" description="How saturated the accent is. 100 is the brand.">
          <SettingSlider
            value={appearance.accentIntensity}
            onChange={(accentIntensity) => setAppearance({ accentIntensity })}
            min={0}
            max={100}
            format={(value) => `${value}%`}
            label="Accent intensity"
          />
        </SettingRow>
        <SettingRow label="Preview" description="Fill, hover and pressed, with the derived label colour.">
          <AccentSwatch />
        </SettingRow>
      </SettingGroup>

      <SettingGroup label="Code & Diffs">
        <SettingRow
          label="Code Font Size"
          description="Snippets, the markdown code block and terminal output. Independent of the UI size."
        >
          <SettingStepper
            value={appearance.codeFontSize}
            onChange={(codeFontSize) => setAppearance({ codeFontSize })}
            min={10}
            max={18}
            unit="px"
            label="Code font size"
          />
        </SettingRow>
        <SettingRow label="Code Font Family">
          <SettingSelect
            value={appearance.codeFontFamily}
            onChange={(event) => setAppearance({ codeFontFamily: event.target.value })}
            aria-label="Code font family"
          >
            {Object.entries(CODE_FONTS).map(([key, font]) => (
              <option key={key} value={key}>
                {font.label}
              </option>
            ))}
          </SettingSelect>
        </SettingRow>
        <SettingRow
          label="Code Block Word Wrap"
          description="Fold long lines instead of scrolling them sideways."
        >
          <SettingToggle
            checked={appearance.codeWordWrap}
            onChange={(codeWordWrap) => setAppearance({ codeWordWrap })}
            label="Code block word wrap"
          />
        </SettingRow>
        <SettingRow
          label="Themed Diff Backgrounds"
          description="Tint added and removed lines. Off leaves the coloured text and the edge marker only."
        >
          <SettingToggle
            checked={appearance.themedDiffBackgrounds}
            onChange={(themedDiffBackgrounds) => setAppearance({ themedDiffBackgrounds })}
            label="Themed diff backgrounds"
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup label="Chat">
        <SettingRow
          label="Tool Call Density"
          description="Detailed keeps a finished turn's tool list open; compact collapses it to the summary strip."
        >
          <SettingSelect
            value={appearance.toolCallDensity}
            onChange={(event) =>
              setAppearance({ toolCallDensity: event.target.value as ToolCallDensity })
            }
            aria-label="Tool call density"
          >
            <option value="compact">Compact</option>
            <option value="detailed">Detailed</option>
          </SettingSelect>
        </SettingRow>
      </SettingGroup>

      <SettingGroup label="Window">
        <SettingRow
          label="Window Chrome"
          description={
            hostPlatform()
              ? `Which end of the title bar the minimise, maximise and close controls take, and what they look like. Follow system resolves to ${CHROME_LABEL[resolveChromeStyle("system")]} on this host.`
              : "Which end of the title bar the window controls take, and what they look like. There is no host to follow in a browser tab, so Follow system draws the macOS lights."
          }
        >
          <SettingSelect
            value={appearance.chromeStyle}
            onChange={(event) =>
              setAppearance({ chromeStyle: event.target.value as ChromeStyle })
            }
            aria-label="Window chrome"
          >
            <option value="system">Follow system</option>
            <option value="macos">macOS</option>
            <option value="windows">Windows</option>
            <option value="linux">Linux</option>
          </SettingSelect>
        </SettingRow>
      </SettingGroup>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={resetAppearance}
          className="rounded-md px-2.5 py-1.5 text-2xs text-ink-muted transition-colors duration-ds ease-ds hover:bg-surface-hover hover:text-ink-high"
        >
          Reset appearance to defaults
        </button>
      </div>
    </div>
  );
};

/** The row labels this pane carries, for the settings rail's search. */
export const APPEARANCE_ROWS = [
  "UI Font Size",
  "UI Font Family",
  "Reduce Transparency",
  "Hue",
  "Intensity",
  "Code Font Size",
  "Code Font Family",
  "Code Block Word Wrap",
  "Themed Diff Backgrounds",
  "Window Chrome",
  "Tool Call Density",
];
