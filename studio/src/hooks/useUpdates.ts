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
import { PlatformService, type UpdateStatus } from "../services/platformService";

/** Quiet enough not to be noticed, often enough that a fix reaches people. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdatePhase = "idle" | "downloading" | "ready" | "opening" | "installed" | "failed";

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

  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
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

  const abortRef = useRef<AbortController | null>(null);

  const check = useCallback(async () => {
    const next = await PlatformService.checkForUpdate();
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

  const download = useCallback(async () => {
    const asset = status?.asset;
    if (!asset) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPhase("downloading");
    setProgress(null);
    setReceived(0);
    setError(null);

    try {
      await PlatformService.downloadUpdate(
        { url: asset.url, name: asset.name },
        (event) => {
          if (event.type === "progress") {
            setReceived(event.received);
            setProgress(event.total ? event.received / event.total : null);
          } else if (event.type === "done") {
            setInstallerPath(event.path);
            setPhase("ready");
          } else if (event.type === "error") {
            setError(event.message);
            setPhase("failed");
          }
        },
        controller.signal,
      );
    } catch (caught) {
      if (controller.signal.aborted) {
        setPhase("idle");
        return;
      }
      setError(caught instanceof Error ? caught.message : "The update could not be downloaded.");
      setPhase("failed");
    }
  }, [status]);

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

  const restart = useCallback(async () => {
    await window.teminali?.updates?.restart();
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setPhase("idle");
    setProgress(null);
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
    check,
    download,
    install,
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
