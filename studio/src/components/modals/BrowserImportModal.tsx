import React, { useCallback, useEffect, useState } from "react";
import { BookMarked, Check, History, Import, Lock, TriangleAlert } from "lucide-react";
import { Button, Modal } from "../ui";
import { useBrowserStore } from "../../store/browserStore";
import {
  BrowserDataService,
  type ImportProfile,
  type ImportSource,
  type ImportSources,
} from "../../services/browserDataService";

/**
 * Bringing bookmarks and history over from the browser used before.
 *
 * Built on `Modal` and not on a div of its own, which matters more here than
 * anywhere else in the app: this opens from the browser panel, and
 * `services/browserView.ts` hides the native view on exactly the selector
 * `[role="dialog"], [role="menu"]`. A hand-rolled backdrop would have no
 * `role="dialog"`, so the page would keep painting straight over this.
 *
 * The dialog says what it will do before it does it and what it did after —
 * discovery is a separate, cheap request, so the operator picks from what is
 * really on the machine rather than from a list of browsers they might own.
 * A source that cannot be read (Safari) is shown greyed with its reason
 * attached, and autofill is stated as unsupported rather than being offered
 * and quietly doing nothing.
 */
export const BrowserImportModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const importFrom = useBrowserStore((state) => state.importFrom);

  const [sources, setSources] = useState<ImportSources | null>(null);
  const [loading, setLoading] = useState(false);
  const [chosen, setChosen] = useState<{ source: string; profile: string } | null>(null);
  const [wantBookmarks, setWantBookmarks] = useState(true);
  const [wantHistory, setWantHistory] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ bookmarks: number; skipped: number; history: number } | null>(null);

  // Discovery runs on open, not on mount: the answer is a directory listing of
  // what is installed today, and the operator may have installed something
  // since the app started.
  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setDone(null);
    BrowserDataService.importSources(controller.signal)
      .then((found) => {
        setSources(found);
        const first = found.sources.find((source) => source.available && source.profiles.length > 0);
        if (first) setChosen({ source: first.id, profile: first.profiles[0].id });
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Could not look for other browsers on this machine.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [isOpen]);

  const run = useCallback(async () => {
    if (!chosen || running) return;
    setRunning(true);
    setError(null);
    try {
      const result = await importFrom({ ...chosen, bookmarks: wantBookmarks, history: wantHistory });
      setDone({
        bookmarks: result.bookmarks.added,
        skipped: result.bookmarks.skipped,
        history: result.history.added,
      });
    } catch {
      setError("That browser's data could not be read.");
    } finally {
      setRunning(false);
    }
  }, [chosen, importFrom, running, wantBookmarks, wantHistory]);

  const selectedSource = sources?.sources.find((source) => source.id === chosen?.source) ?? null;
  const nothing = Boolean(sources) && (sources?.sources.filter((source) => source.available).length ?? 0) === 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      icon={<Import size={16} />}
      title="Import from another browser"
      subtitle="Bookmarks and history are read from a copy. Nothing is written to the other browser."
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-3xs text-ink-faint min-w-0 truncate">
            {sources && !sources.autofill.supported ? sources.autofill.reason : ""}
          </span>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {done ? "Done" : "Cancel"}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void run()}
              disabled={!chosen || running || (!wantBookmarks && !wantHistory)}
            >
              {running ? "Importing…" : done ? "Import again" : "Import"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {loading && <p className="text-xs text-ink-dim">Looking for browsers on this machine…</p>}

        {sources && !sources.available && (
          <p className="text-xs text-ink-dim">{sources.reason}</p>
        )}

        {nothing && sources?.available && (
          <p className="text-xs text-ink-dim">
            No other browser on this machine has bookmarks or history to import.
          </p>
        )}

        {sources?.sources.map((source) => (
          <SourceRow
            key={source.id}
            source={source}
            chosen={chosen}
            onChoose={(profile) => {
              setChosen({ source: source.id, profile });
              setDone(null);
            }}
          />
        ))}

        {selectedSource && (
          <div className="flex items-center gap-4 pt-1">
            <Tick
              label="Bookmarks"
              icon={<BookMarked size={12} />}
              checked={wantBookmarks}
              onChange={setWantBookmarks}
            />
            <Tick label="History" icon={<History size={12} />} checked={wantHistory} onChange={setWantHistory} />
          </div>
        )}

        {done && (
          <p className="flex items-start gap-2 text-xs text-ink-prose">
            <Check size={13} className="text-success mt-0.5 flex-shrink-0" />
            <span>
              {describe(done)}
            </span>
          </p>
        )}

        {error && (
          <p className="flex items-start gap-2 text-xs text-danger">
            <TriangleAlert size={13} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </p>
        )}
      </div>
    </Modal>
  );
};

/**
 * What actually happened, in a sentence with numbers in it.
 *
 * "Imported" on its own is the least useful word available: an import that
 * added nothing because everything was already kept has to read differently
 * from one that found nothing to read.
 */
function describe(done: { bookmarks: number; skipped: number; history: number }): string {
  const parts: string[] = [];
  if (done.bookmarks > 0) parts.push(`${done.bookmarks} bookmark${done.bookmarks === 1 ? "" : "s"}`);
  if (done.history > 0) parts.push(`${done.history} page${done.history === 1 ? "" : "s"} of history`);
  if (parts.length === 0) {
    return done.skipped > 0
      ? `Nothing new — all ${done.skipped} bookmarks were already kept here.`
      : "Nothing new to import.";
  }
  const skipped = done.skipped > 0 ? ` ${done.skipped} bookmark${done.skipped === 1 ? " was" : "s were"} already kept.` : "";
  return `Imported ${parts.join(" and ")}.${skipped}`;
}

/** One browser, with its profiles as choices — or greyed out, saying why. */
const SourceRow: React.FC<{
  source: ImportSource;
  chosen: { source: string; profile: string } | null;
  onChoose: (profile: string) => void;
}> = ({ source, chosen, onChoose }) => {
  if (!source.available) {
    return (
      <div className="flex items-start gap-2 px-2.5 py-2 rounded-lg border border-edge-chrome bg-surface-chip/40">
        <Lock size={12} className="text-ink-faint mt-0.5 flex-shrink-0" />
        <div className="min-w-0">
          <div className="text-xs text-ink-dim">{source.label}</div>
          {source.reason && <div className="text-3xs text-ink-faint mt-0.5">{source.reason}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-2xs text-ink-faint uppercase tracking-wide">{source.label}</div>
      <div className="flex flex-wrap gap-1.5">
        {source.profiles.map((profile) => (
          <ProfileChip
            key={profile.id}
            profile={profile}
            active={chosen?.source === source.id && chosen.profile === profile.id}
            onClick={() => onChoose(profile.id)}
          />
        ))}
      </div>
    </div>
  );
};

/**
 * A profile to import from.
 *
 * The label is the name the operator gave it in that browser — "Work" rather
 * than "Profile 1" — read from its `Local State`; the two letters after it say
 * which lists that profile actually has, so a profile with no bookmarks does
 * not look like a failed import afterwards.
 */
const ProfileChip: React.FC<{ profile: ImportProfile; active: boolean; onClick: () => void }> = ({
  profile,
  active,
  onClick,
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs transition-colors duration-ds ease-ds ${
      active
        ? "bg-accent/15 text-accent border-accent/40 font-semibold"
        : "bg-surface-chip text-ink-muted border-edge-chrome hover:text-ink-high hover:bg-surface-hover"
    }`}
  >
    <span className="truncate max-w-[10rem]">{profile.label}</span>
    <span className="flex items-center gap-1 text-ink-faint">
      {profile.bookmarks && <BookMarked size={11} />}
      {profile.history && <History size={11} />}
    </span>
  </button>
);

/** A checkbox that reads as one, without pulling in a control the app does not have. */
const Tick: React.FC<{
  label: string;
  icon: React.ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
}> = ({ label, icon, checked, onChange }) => (
  <label className="flex items-center gap-2 text-xs text-ink-prose cursor-pointer select-none">
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
      className="accent-accent w-3.5 h-3.5"
    />
    <span className="text-ink-faint">{icon}</span>
    {label}
  </label>
);
