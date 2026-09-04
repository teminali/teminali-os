/**
 * Is there a newer version, and getting it installed.
 *
 * The whole flow, because it is short: check GitHub → download the one file
 * this machine can use → open it → the operator drags it into place → restart.
 *
 * That last step is not optional politeness. This build is ad-hoc signed, so
 * every release carries a different signature, and macOS keys Screen Recording,
 * Accessibility and Microphone grants to the signature. After an update the
 * system considers this a different application and the grants are gone —
 * meaning the screen assistant will be sitting there unable to see anything
 * until the app is restarted and the permissions re-granted. Saying so is the
 * difference between a known step and a mysteriously broken feature.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { PlatformService, type ReleaseList, type UpdateStatus } from "../services/platformService";

/** Quiet enough not to be noticed, often enough that a fix reaches people. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdatePhase = "idle" | "downloading" | "ready" | "opening" | "installed" | "failed";

export interface InstallProgressInfo {
  percent: number;
  statusText: string;
}

export interface UseUpdatesResult {
  status: UpdateStatus | null;
  phase: UpdatePhase;
  /** 0–1 while downloading, null when the size is unknown. */
  progress: number | null;
  receivedBytes: number;
  error: string | null;
  /** Where the downloaded installer landed. */
  installerPath: string | null;
  /** True once the installer has been handed to the operating system. */
  awaitingRestart: boolean;
  /** True while a check is in flight, so a control can say it is running. */
  checking: boolean;
  /**
   * The version being fetched, when it is not simply "the latest one" — a
   * rollback has to be able to say which build it is installing.
   */
  target: string | null;
  /** Progress during the installation phase (percent 0-100 and description) */
  installProgress: InstallProgressInfo | null;

  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  /**
   * Download one named release and install it, as a single action.
   *
   * The modal splits download from install because it is showing release notes
   * and a size, and the operator reads before committing. A rollback is already
   * committed by the time it is confirmed, so it does not ask twice.
   */
  apply: (asset: { url: string; name: string }, version?: string | null) => Promise<void>;
  /** Every release this machine could install. Fetched on demand, not polled. */
  releases: () => Promise<ReleaseList | null>;
  restart: () => Promise<void>;
  cancel: () => void;
  dismiss: () => void;
  dismissed: boolean;
}

export function useUpdates(): UseUpdatesResult {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [progress, setProgress] = useState<number | null>(null);
  const [receivedBytes, setReceived] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [installerPath, setInstallerPath] = useState<string | null>(null);
  const [awaitingRestart, setAwaitingRestart] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<InstallProgressInfo | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (phase !== "opening") {
      setInstallProgress(null);
      if (phase === "installed") {
        void window.teminali?.window?.setProgressBar?.(-1);
      }
      return;
    }

    setInstallProgress({ percent: 12, statusText: "Preparing update package…" });
    void window.teminali?.window?.setProgressBar?.(0.12);

    const cleanupListener = window.teminali?.updates?.onInstallProgress?.((info) => {
      setInstallProgress({ percent: info.percent, statusText: info.status });
      void window.teminali?.window?.setProgressBar?.(Math.min(1, Math.max(0, info.percent / 100)));
    });

    let current = 12;
    const interval = setInterval(() => {
      current = Math.min(94, current + (current < 40 ? 5 : current < 75 ? 3 : 1));
      const statusText =
        current < 35
          ? "Expanding update package…"
          : current < 65
          ? "Preparing application bundle…"
          : current < 85
          ? "Writing updated application files…"
          : "Refreshing security signatures…";
      setInstallProgress((prev) => {
        if (prev && prev.percent > current) return prev;
        return { percent: current, statusText };
      });
      void window.teminali?.window?.setProgressBar?.(current / 100);
    }, 400);

    return () => {
      cleanupListener?.();
      clearInterval(interval);
    };
  }, [phase]);

  const check = useCallback(async () => {
    setChecking(true);
    const next = await PlatformService.checkForUpdate();
    setChecking(false);
    setStatus(next);
    // A version the operator dismissed should not keep reappearing, but a
    // *newer* one than the one they dismissed must.
    if (next?.latest?.tag) {
      setDismissed((previous) => (previous && localStorage.getItem(DISMISSED_KEY) === next.latest?.tag ? previous : false));
    }
  }, []);

  useEffect(() => {
    void check();
    const timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [check]);

  /**
   * The download half on its own.
   *
   * Shared by the modal's read-then-commit flow and by the one-step rollback,
   * so there is a single place that knows how progress, cancellation and a
   * half-finished transfer are handled.
   */
  const fetchAsset = useCallback(async (asset: { url: string; name: string }): Promise<string | null> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPhase("downloading");
    setProgress(null);
    setReceived(0);
    setError(null);

    // Held in an object because the assignment happens inside a callback, and
    // the compiler cannot see through one to narrow a plain local.
    const landed: { path: string | null } = { path: null };
    try {
      await PlatformService.downloadUpdate(
        { url: asset.url, name: asset.name },
        (event) => {
          if (event.type === "progress") {
            setReceived(event.received);
            setProgress(event.total ? event.received / event.total : null);
          } else if (event.type === "done") {
            landed.path = event.path;
          } else if (event.type === "error") {
            setError(event.message);
          }
        },
        controller.signal,
      );
    } catch (caught) {
      if (controller.signal.aborted) {
        setPhase("idle");
        return null;
      }
      setError(caught instanceof Error ? caught.message : "The update could not be downloaded.");
      setPhase("failed");
      return null;
    }

    if (!landed.path) {
      // The stream ended without a file. It has usually said why already.
      setError((previous) => previous ?? "The update could not be downloaded.");
      setPhase("failed");
      return null;
    }

    setInstallerPath(landed.path);
    return landed.path;
  }, []);

  const download = useCallback(async () => {
    const asset = status?.asset;
    if (!asset) return;
    setTarget(status?.latest?.tag?.replace(/^v/, "") ?? null);
    const path = await fetchAsset(asset);
    if (path) setPhase("ready");
  }, [status, fetchAsset]);

  const install = useCallback(async () => {
    const bridge = window.teminali?.updates;
    if (!installerPath || !bridge) return;
    setPhase("opening");
    const result = await bridge.install(installerPath);
    if (!result.ok) {
      setError(result.reason ?? "The installer could not be opened.");
      setPhase("failed");
      return;
    }
    setPhase("installed");
    setAwaitingRestart(true);
  }, [installerPath]);

  const apply = useCallback(
    async (asset: { url: string; name: string }, version: string | null = null) => {
      setTarget(version);
      const path = await fetchAsset(asset);
      if (!path) return;

      const bridge = window.teminali?.updates;
      if (!bridge) {
        // In a browser there is nothing to install into. The file is on disk
        // and the phase says so rather than claiming a version was installed.
        setPhase("ready");
        return;
      }

      setPhase("opening");
      const result = await bridge.install(path);
      if (!result.ok) {
        setError(result.reason ?? "The installer could not be opened.");
        setPhase("failed");
        return;
      }
      setPhase("installed");
      setAwaitingRestart(true);
    },
    [fetchAsset],
  );

  const releases = useCallback(() => PlatformService.listReleases(), []);

  const restart = useCallback(async () => {
    await window.teminali?.updates?.restart();
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setPhase("idle");
    setProgress(null);
    setTarget(null);
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      if (status?.latest?.tag) localStorage.setItem(DISMISSED_KEY, status.latest.tag);
    } catch {
      /* Then it reappears next launch, which is the safer failure. */
    }
  }, [status]);

  return {
    status,
    phase,
    progress,
    receivedBytes,
    error,
    installerPath,
    awaitingRestart,
    checking,
    target,
    installProgress,
    check,
    download,
    install,
    apply,
    releases,
    restart,
    cancel,
    dismiss,
    dismissed,
  };
}

const DISMISSED_KEY = "teminali_update_dismissed_tag";

/** Read at mount so a dismissed version stays dismissed across a restart. */
export function dismissedTag(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}
