import React from "react";

/**
 * The settings row family.
 *
 * Every row on every settings screen is one of these five shapes: a labelled
 * row with a control on the right, inside a card that owns the hairlines
 * between its rows. They exist because each row used to be bespoke Tailwind —
 * `VoiceSettingsPanel` carried a private `Row`, `Toggle` and `Select`, the
 * General screen wrote its own, and the two drifted in padding, type scale and
 * the colour of a disabled control.
 *
 * TDS governance applies: no literal colours here, only the token-backed
 * utility names from `tailwind.config.js`. A row that needs a colour the
 * sheet does not have needs a token, not a hex.
 */

export interface SettingGroupProps {
  /** Small tracking-wide label above the card. Omit for an unlabelled card. */
  label?: string;
  /** One line under the label, for a group that needs a sentence of context. */
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/**
 * A titled card of rows. The card owns the dividers, so a row never draws its
 * own bottom border and the last row never leaves a hairline hanging.
 */
export const SettingGroup: React.FC<SettingGroupProps> = ({
  label,
  description,
  children,
  className = "",
}) => (
  <section className={`space-y-2 ${className}`}>
    {label && (
      <h2 className="px-1 text-2xs font-semibold uppercase tracking-wider text-ink-muted">{label}</h2>
    )}
    {description && <p className="px-1 text-2xs leading-relaxed text-ink-faint">{description}</p>}
    <div className="lit lit-inner rounded-xl border border-edge bg-surface divide-y divide-edge-chrome overflow-hidden">
      {children}
    </div>
  </section>
);

export interface SettingRowProps {
  label: React.ReactNode;
  /** The sentence under the label. Say what the control does, not that it exists. */
  description?: React.ReactNode;
  /** The control. A row with no control is a statement, and that is allowed. */
  children?: React.ReactNode;
  className?: string;
}

/** Label and description on the left, control on the right. */
export const SettingRow: React.FC<SettingRowProps> = ({
  label,
  description,
  children,
  className = "",
}) => (
  <div className={`flex items-start justify-between gap-5 px-3.5 py-3 ${className}`}>
    <div className="min-w-0">
      <div className="text-xs text-ink-prose">{label}</div>
      {description && <div className="mt-0.5 text-2xs leading-relaxed text-ink-faint">{description}</div>}
    </div>
    {children && <div className="flex flex-shrink-0 items-center gap-2">{children}</div>}
  </div>
);

export interface SettingToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  /** Required when the row's label is not text a screen reader can reach. */
  label?: string;
}

/**
 * The pill switch: accent when on, an inert track when off.
 *
 * The off track is `--surface-track` and nothing else in the ramp will do. It
 * used to be `bg-surface-hover`, which is 1.04:1 against the card it sits on —
 * the slot was not there, and an off switch read as a white dot floating on the
 * card. See DESIGN.md §0.
 */
export const SettingToggle: React.FC<SettingToggleProps> = ({
  checked,
  onChange,
  disabled = false,
  label,
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative h-5 w-9 rounded-full transition-colors duration-ds ease-ds disabled:opacity-35 ${
      checked ? "bg-accent" : "bg-surface-track"
    }`}
  >
    <span
      className="absolute top-0.5 h-4 w-4 rounded-full bg-ink-high transition-[left] duration-ds ease-ds"
      style={{ left: checked ? 18 : 2 }}
    />
  </button>
);

/** The dropdown. Native, because a native menu is the one that is keyboard-correct. */
export const SettingSelect: React.FC<React.SelectHTMLAttributes<HTMLSelectElement>> = ({
  className = "",
  ...props
}) => (
  <select
    className={`lit lit-inner h-7 max-w-[190px] rounded-md bg-surface-raised px-2 text-xs text-ink-body outline-none disabled:opacity-35 ${className}`}
    {...props}
  />
);

export interface SettingStepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Rendered after the number — "px", "×". Not a label. */
  unit?: string;
  disabled?: boolean;
  label?: string;
}

/**
 * The −/+ number. Clamps at the ends and disables the button that would leave
 * the range, so the control cannot be pressed into a state it will not take.
 */
export const SettingStepper: React.FC<SettingStepperProps> = ({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  unit,
  disabled = false,
  label,
}) => {
  const clamp = (next: number) => Math.min(max, Math.max(min, Number(next.toFixed(4))));
  const button =
    "flex h-6 w-6 items-center justify-center rounded-md bg-surface-raised text-ink-muted transition-colors duration-ds ease-ds hover:text-ink-high disabled:opacity-30 disabled:hover:text-ink-muted";
  return (
    <div className="lit lit-inner flex items-center gap-1 rounded-lg bg-surface-sunken p-0.5" aria-label={label}>
      <button
        type="button"
        className={button}
        disabled={disabled || value <= min}
        onClick={() => onChange(clamp(value - step))}
        aria-label="Decrease"
      >
        −
      </button>
      <span className="min-w-[2.5rem] text-center font-mono text-2xs text-ink-body">
        {value}
        {unit && <span className="text-ink-faint">{unit}</span>}
      </span>
      <button
        type="button"
        className={button}
        disabled={disabled || value >= max}
        onClick={() => onChange(clamp(value + step))}
        aria-label="Increase"
      >
        +
      </button>
    </div>
  );
};

export interface SettingSliderProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** How the number reads next to the track. Defaults to the raw value. */
  format?: (value: number) => string;
  disabled?: boolean;
  label?: string;
  className?: string;
}

/** The labelled track. The readout is part of the control: a slider with no number is a guess. */
export const SettingSlider: React.FC<SettingSliderProps> = ({
  value,
  onChange,
  min,
  max,
  step = 1,
  format,
  disabled = false,
  label,
  className = "",
}) => (
  <div className={`flex items-center gap-2 ${className}`}>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => onChange(Number(event.target.value))}
      className="w-24 accent-[var(--accent)] disabled:opacity-35"
    />
    <span className="w-10 text-right font-mono text-3xs text-ink-faint">
      {format ? format(value) : value}
    </span>
  </div>
);

export interface SettingListProps {
  /** The entries themselves. Order is the operator's, so it is preserved. */
  entries: readonly string[];
  onChange: (next: string[]) => void;
  /** What one entry is, in the add field: "npm", "temy". */
  placeholder: string;
  /** Shown in place of the chips when there are none. Say how one gets here. */
  emptyNote: React.ReactNode;
  /** Rejects an entry before it is added. Returns a reason, or null to accept. */
  validate?: (entry: string) => string | null;
  /** Accessible name for the add field, since the row label is not tied to it. */
  label: string;
  disabled?: boolean;
}

/**
 * A row that holds a list rather than a value: chips that can be removed, and
 * one field that adds.
 *
 * Full width instead of the label-left/control-right shape, because a list of
 * twenty executables does not fit in the right-hand column and truncating them
 * would hide exactly the part that distinguishes two entries. It draws no
 * heading of its own — the `SettingRow` above it says what the list is.
 *
 * Removal takes one click and no confirmation. Every entry here is a permission
 * the operator granted, so making it harder to take one back than it was to
 * give would be backwards.
 */
export const SettingList: React.FC<SettingListProps> = ({
  entries,
  onChange,
  placeholder,
  emptyNote,
  validate,
  label,
  disabled = false,
}) => {
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const add = () => {
    const value = draft.trim();
    if (!value) return;
    if (entries.includes(value)) {
      setError("Already on the list.");
      return;
    }
    const rejection = validate?.(value) ?? null;
    if (rejection) {
      setError(rejection);
      return;
    }
    onChange([...entries, value]);
    setDraft("");
    setError(null);
  };

  return (
    <div className="px-3.5 py-3">
      {entries.length === 0 ? (
        <p className="text-2xs leading-relaxed text-ink-faint">{emptyNote}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {entries.map((entry) => (
            <li key={entry}>
              <span className="flex items-center gap-1 rounded-md border border-edge bg-surface-raised py-1 pl-2 pr-1 text-2xs text-ink-body">
                <code className="font-mono">{entry}</code>
                <button
                  type="button"
                  onClick={() => onChange(entries.filter((item) => item !== entry))}
                  disabled={disabled}
                  aria-label={`Remove ${entry}`}
                  className="rounded px-1 text-ink-muted transition-colors duration-ds ease-ds hover:text-danger disabled:opacity-35"
                >
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2.5 flex items-center gap-2">
        <input
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
          aria-label={label}
          disabled={disabled}
          className="lit lit-inner h-7 min-w-0 flex-1 rounded-md bg-surface-raised px-2 font-mono text-xs text-ink-body outline-none disabled:opacity-35"
        />
        <button
          type="button"
          onClick={add}
          disabled={disabled || !draft.trim()}
          className="rounded-md border border-edge px-2.5 py-1.5 text-2xs font-semibold text-ink-body transition-colors duration-ds ease-ds hover:bg-surface-raised disabled:opacity-35"
        >
          Add
        </button>
      </div>
      {error && <p className="mt-1.5 text-2xs text-warning">{error}</p>}
    </div>
  );
};
