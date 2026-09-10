/* ═══════════════════════════════════════════════════════════════════
   Choosing what to record.

   Thumbnails come from `desktopCapturer` in the main process and are
   real frames of the real thing, which is the only way this list is
   usable: "Screen 1 / Screen 2" tells you nothing on a two-monitor
   desk, and a list of window titles tells you nothing at all when four
   of them are called "Untitled".

   Displays and windows are separated rather than mixed, because the two
   differ in a way that matters downstream: a display capture can locate
   the pointer inside the frame and a window capture cannot, so auto
   zoom is only available for one of them. The tab is where that is
   said, once, rather than as a surprise after the take.

   ── A strip, not a grid, and a field to sieve it ────────────────────
   This was a three-column grid that owned the whole left half. On a
   one-display machine that is one thumbnail and a great deal of black;
   on a working desk it is twenty-one windows to scroll and squint at,
   and past about six a thumbnail stops being how anybody finds a
   window — the title is. So the picker is now a single scrolling row
   under the stage, with a filter field that turns twenty-one into
   three by typing three letters, and the space it gave up went to
   showing the SELECTED source large enough to judge.

   Arrow keys walk the row, because a filtered list you then have to
   reach for the mouse to commit is only half a filter.
   ═══════════════════════════════════════════════════════════════════ */

import React from 'react';
import type { RecorderSource } from '../../../types/recorder';
import { Monitor, AppWindow, Loader2, RefreshCw, Check, Search, X } from '../ui/icons';

interface Props {
  sources: RecorderSource[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}

type Tab = 'screen' | 'window';

/** Past this many windows the title is how you find one, not the picture. */
const FILTER_THRESHOLD = 6;

export const SourceGrid: React.FC<Props> = ({ sources, loading, selectedId, onSelect, onRefresh }) => {
  const [tab, setTab] = React.useState<Tab>('screen');
  const [query, setQuery] = React.useState('');
  const stripRef = React.useRef<HTMLDivElement>(null);

  /* The one source `recorderStore` invents when there is no Electron
     bridge to ask. Its presence is what tells this picker it is in a browser. */
  const webOnly = sources.length === 1 && sources[0].id === 'web:screen';

  const screens = sources.filter((s) => s.kind === 'screen');
  const windows = sources.filter((s) => s.kind === 'window');
  const inTab = tab === 'screen' ? screens : windows;

  const needle = query.trim().toLowerCase();
  const shown = needle ? inTab.filter((s) => s.name.toLowerCase().includes(needle)) : inTab;

  /* Follow the selection into its own tab rather than showing an empty
     row with a highlighted item nobody can see. */
  React.useEffect(() => {
    const selected = sources.find((s) => s.id === selectedId);
    if (selected) setTab(selected.kind);
  }, [selectedId, sources]);

  /* A filter is only worth having if the pick it produced is visible.
     The row scrolls, so the selected card is scrolled to rather than
     left somewhere off the right edge. */
  React.useEffect(() => {
    const node = stripRef.current?.querySelector<HTMLElement>('[data-selected="true"]');
    node?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedId, tab, needle]);

  const step = (delta: number) => {
    if (shown.length === 0) return;
    const at = shown.findIndex((s) => s.id === selectedId);
    const next = at < 0 ? 0 : (at + delta + shown.length) % shown.length;
    onSelect(shown[next].id);
  };

  const canFilter = tab === 'window' && windows.length >= FILTER_THRESHOLD;

  return (
    <div className="flex-shrink-0 border-t border-line flex flex-col">
      <div className="flex items-center gap-2 px-3 h-9 flex-shrink-0">
        <div className="seg-group">
          {(['screen', 'window'] as Tab[]).map((value) => (
            <button
              key={value}
              onClick={() => { setTab(value); setQuery(''); }}
              className={`seg-item ${tab === value ? 'seg-item-active' : ''}`}
            >
              {value === 'screen' ? `Displays (${screens.length})` : `Windows (${windows.length})`}
            </button>
          ))}
        </div>

        {canFilter ? (
          <div className="pro-input relative flex items-center h-6 ml-1 w-44 flex-shrink-0">
            <Search className="w-3 h-3 text-spectrum-textFaint flex-shrink-0 ml-1.5" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.stopPropagation(); setQuery(''); }
                if (e.key === 'Enter' && shown.length > 0) onSelect(shown[0].id);
              }}
              placeholder="Find a window…"
              aria-label="Filter the windows by title"
              className="flex-1 min-w-0 bg-transparent px-1.5 text-ui-xs outline-none border-0"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                aria-label="Clear the filter"
                className="text-spectrum-textFaint hover:text-spectrum-text transition-colors mr-1"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        ) : (
          <span className="text-micro text-spectrum-textFaint truncate">
            {tab === 'screen'
              ? 'A whole display. Auto zoom works here.'
              : 'One window only. No auto zoom.'}
          </span>
        )}

        <button
          onClick={onRefresh}
          className="pro-btn w-6 h-6 ml-auto flex-shrink-0"
          aria-label="Refresh the list"
          title="Refresh the list"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div
        ref={stripRef}
        role="listbox"
        aria-label={tab === 'screen' ? 'Displays' : 'Windows'}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
          if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
        }}
        className="flex gap-2 overflow-x-auto overflow-y-hidden px-3 pb-3 pt-0.5 min-h-0 outline-none
                   focus-visible:ring-1 focus-visible:ring-spectrum-accent/40 rounded-squircle-xs"
      >
        {loading && sources.length === 0 ? (
          <div className="h-[86px] flex-1 flex items-center justify-center gap-2 text-ui-sm text-spectrum-textDim">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Looking at what is on screen…
          </div>
        ) : shown.length === 0 ? (
          <div className="h-[86px] flex-1 flex items-center justify-center text-center px-6">
            <p className="text-ui-sm text-spectrum-textDim leading-relaxed">
              {needle
                ? `No window is called “${query.trim()}”.`
                : tab === 'window'
                  /* The browser build cannot enumerate anything: it has one
                     synthetic source and the OS picker decides the rest. Saying
                     "no other windows are open" there is a lie that reads as a
                     broken recorder — which is exactly how it was reported. */
                  ? (webOnly
                      ? 'Running in a browser, so windows cannot be listed here. The browser\'s own '
                        + 'picker offers them when the take starts. The desktop app lists them.'
                      : 'No other windows are open.')
                  /* Not "you have not allowed it yet". The commonest reason
                     for zero displays on a machine that HAS allowed it is
                     that the grant went stale when Teminali OS updated, and
                     the footer offers the one button that fixes that. */
                  : 'No displays were offered. Either screen recording has not been allowed for '
                    + 'Teminali OS, or it was allowed for an earlier version and stopped matching when '
                    + 'Teminali OS updated. Click "Reset permissions" or "Open settings" below.'}
            </p>
          </div>
        ) : (
          shown.map((source) => {
            const isSelected = source.id === selectedId;
            return (
              <button
                key={source.id}
                data-recorder="source"
                data-selected={isSelected}
                role="option"
                aria-selected={isSelected}
                onClick={() => onSelect(source.id)}
                title={source.name}
                className={`w-[132px] flex-shrink-0 rounded-squircle-sm overflow-hidden border text-left
                            transition-colors group ${
                  isSelected
                    ? 'border-spectrum-accent bg-spectrum-accent/10'
                    : 'border-line bg-spectrum-sunken/50 hover:border-line-strong'
                }`}
              >
                <span className="block relative aspect-video bg-black/60 overflow-hidden">
                  {source.thumbnail ? (
                    <img src={source.thumbnail} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <span className="absolute inset-0 flex items-center justify-center">
                      {source.kind === 'screen'
                        ? <Monitor className="w-5 h-5 text-spectrum-textDisabled" />
                        : <AppWindow className="w-5 h-5 text-spectrum-textDisabled" />}
                    </span>
                  )}

                  {isSelected && (
                    <span className="absolute top-1 right-1 w-[16px] h-[16px] rounded-full bg-spectrum-accent
                                     flex items-center justify-center">
                      <Check className="w-2.5 h-2.5 text-white" weight="bold" />
                    </span>
                  )}
                </span>

                <span className="flex items-center gap-1.5 px-1.5 py-1 min-w-0">
                  {source.icon ? (
                    <img src={source.icon} alt="" className="w-3 h-3 flex-shrink-0 rounded-squircle-2xs" />
                  ) : source.kind === 'screen' ? (
                    <Monitor className="w-3 h-3 flex-shrink-0 text-spectrum-textFaint" />
                  ) : (
                    <AppWindow className="w-3 h-3 flex-shrink-0 text-spectrum-textFaint" />
                  )}
                  <span className="block min-w-0 text-micro text-spectrum-textMuted truncate
                                   group-hover:text-spectrum-text transition-colors">
                    {source.name}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};
