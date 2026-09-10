import React, { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Info, ScrollText } from "lucide-react";
import { SettingGroup, SettingRow } from "../ui/Setting";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { AboutService, type AboutInfo, type AboutLicence } from "../../services/aboutService";
import { openLink } from "../../services/linkOpen";

/**
 * About.
 *
 * This pane is a licence obligation before it is an interface. The installers
 * carry an FFmpeg we built ourselves under LGPL-2.1, and §6 of that licence is
 * met only when the shipped components are **named with their versions** and
 * the corresponding source is **offered** — `docs/MEDIA_LICENSING.md` calls
 * this surface the shipping blocker for exactly that reason. Everything under
 * "Open source components" is read from the manifest the build script wrote
 * beside the binaries, so it cannot describe a different ffmpeg from the one
 * the app spawns.
 *
 * A build made without that script ships no bundle and says so. That is not an
 * error state: every release up to and including v0.0.6 did it, the app falls
 * back to whatever ffmpeg the machine has, and claiming a licence over a binary
 * we did not build would be worse than saying nothing.
 */

/** The §6 offer, in words. The URL beside it is what makes it an offer rather than a claim. */
const SOURCE_OFFER_TEXT =
  "The FFmpeg libraries in this app are linked dynamically under the GNU Lesser General " +
  "Public License v2.1. You may obtain the complete corresponding source for those " +
  "components — the exact tarballs and the script that built them — for at least three " +
  "years from this release.";

const licenceKey = (licence: AboutLicence) => `${licence.bundle}/${licence.file}`;

/** `2026-09-10T21:41:30Z` is not a date a person reads. */
function formatBuiltAt(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export const AboutPane: React.FC = () => {
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [failed, setFailed] = useState(false);
  /* Three states, not two. "Still reading" and "could not be read" print the
     same thing if they share a placeholder, and a row that says `…` forever is
     the worse of the two lies — it claims the answer is still coming. */
  const placeholder = failed ? "unknown" : "…";
  const [openLicence, setOpenLicence] = useState<string | null>(null);
  const [licenceText, setLicenceText] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void AboutService.read(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result) setInfo(result);
      else setFailed(true);
    });
    return () => controller.abort();
  }, []);

  /* One text open at a time. These are 500-line documents and a pane holding
     three of them expanded is a pane nobody can navigate. */
  const showLicence = useCallback(
    async (licence: AboutLicence) => {
      const key = licenceKey(licence);
      if (openLicence === key) {
        setOpenLicence(null);
        setLicenceText(null);
        return;
      }
      setOpenLicence(key);
      setLicenceText(null);
      const text = await AboutService.licence(licence.bundle, licence.file);
      setLicenceText(text ?? "This build does not carry that licence text.");
    },
    [openLicence],
  );

  const stack = info?.mediaStack;
  const builtAt = formatBuiltAt(stack?.builtAt ?? null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-ink-bright">
          <Info size={16} className="text-accent" />
          About
        </h1>
        <p className="mt-1 max-w-xl text-xs leading-relaxed text-ink-muted">
          Which build this is, and the open source it carries. The components below are read from
          the app itself, not from a list somebody kept up to date by hand.
        </p>
      </div>

      <SettingGroup label={info?.app.name ?? "Teminali OS"}>
        <SettingRow label="Version" description="The build you are running.">
          <Badge variant="model" size="sm">
            {info?.app.version ?? placeholder}
          </Badge>
        </SettingRow>
        <SettingRow label="Platform" description="What this build was made for.">
          <Badge variant="neutral" size="sm">
            {info ? `${info.app.platform} ${info.app.arch}` : placeholder}
          </Badge>
        </SettingRow>
        <SettingRow
          label="Runtime"
          description="Worth quoting in a bug report: most rendering and media problems are one of these three."
        >
          <span className="font-mono text-3xs text-ink-faint">
            {info
              ? [
                  info.app.electron ? `Electron ${info.app.electron}` : null,
                  info.app.chrome ? `Chromium ${info.app.chrome}` : null,
                  `Node ${info.app.node}`,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : placeholder}
          </span>
        </SettingRow>
      </SettingGroup>

      <SettingGroup
        label="Open source components"
        description={
          stack?.bundled
            ? `Built for this release${builtAt ? ` on ${builtAt}` : ""} from pinned source, not taken from this machine.`
            : failed
              ? undefined
              : "What this build ships that somebody else wrote."
        }
      >
        {stack?.bundled ? (
          stack.components.map((component) => (
            <SettingRow
              key={`${component.name}@${component.version}`}
              label={
                <span>
                  {component.name}
                  {component.version && (
                    <span className="ml-1.5 font-mono text-3xs text-ink-faint">{component.version}</span>
                  )}
                </span>
              }
            >
              <Badge variant={component.licence?.startsWith("LGPL") ? "sky" : "neutral"} size="sm">
                {component.licence ?? "licence not recorded"}
              </Badge>
            </SettingRow>
          ))
        ) : failed ? (
          <SettingRow
            label="Could not be read"
            description="The local gateway could not be reached, so this build cannot say what it carries. That is a fault here, not an answer about the bundle."
          />
        ) : info ? (
          <SettingRow
            label="No media stack in this build"
            description="This build ships no FFmpeg of its own. Media work uses whichever ffmpeg is installed on this machine — one we did not build, and whose licence we cannot state on its behalf."
          />
        ) : (
          <SettingRow label="Reading…" />
        )}
      </SettingGroup>

      {stack?.bundled && (
        <SettingGroup label="Source code offer" description={SOURCE_OFFER_TEXT}>
          <SettingRow
            label="Corresponding source"
            description={
              stack.sourceOffer ??
              "This build records no source offer, which the LGPL requires. It must not be released."
            }
          >
            {stack.sourceOffer && (
              <Button
                variant="secondary"
                size="sm"
                icon={<ArrowUpRight size={12} />}
                onClick={() => openLink(stack.sourceOffer as string)}
              >
                Open
              </Button>
            )}
          </SettingRow>
          {stack.buildScript && (
            <SettingRow
              label="How it was built"
              description="The same script produced the binaries in this app and the source in that release."
            >
              <span className="font-mono text-3xs text-ink-faint">{stack.buildScript}</span>
            </SettingRow>
          )}
          {stack.licences.map((licence) => {
            const key = licenceKey(licence);
            const open = openLicence === key;
            return (
              <div key={key}>
                <SettingRow label={<span className="font-mono text-2xs">{licence.file}</span>}>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<ScrollText size={12} />}
                    active={open}
                    onClick={() => void showLicence(licence)}
                  >
                    {open ? "Hide" : "Read"}
                  </Button>
                </SettingRow>
                {open && (
                  <pre className="max-h-72 overflow-auto border-t border-edge-chrome bg-surface-chip px-3.5 py-3 font-mono text-3xs leading-relaxed text-ink-dim whitespace-pre-wrap">
                    {licenceText ?? "Reading…"}
                  </pre>
                )}
              </div>
            );
          })}
        </SettingGroup>
      )}
    </div>
  );
};

/** The row labels this pane carries, for the settings rail's search. */
export const ABOUT_ROWS = [
  "Version",
  "Platform",
  "Runtime",
  "Open source components",
  "Corresponding source",
  "How it was built",
];
