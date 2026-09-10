import React, { useEffect, useState } from "react";
import { AlertCircle, Check, ExternalLink, Eye, EyeOff, KeyRound, Loader2, ShieldCheck, Sparkles, X } from "lucide-react";
import { ProviderService } from "../../services/modelService";
import { useStudioStore } from "../../store/studioStore";
import { MacCloseButton } from "../ui";

function validateGeminiKey(val: string): { ok: boolean; message?: string } {
  const value = val.trim();
  if (!value) return { ok: false, message: "A key is required." };
  if (value.length < 20) return { ok: false, message: "That key is too short to be valid." };
  if (/\s/.test(value)) return { ok: false, message: "A key cannot contain whitespace." };
  if (!value.startsWith("AI") && !value.startsWith("AQ")) {
    return { ok: false, message: "Google Gemini keys start with “AI” or “AQ”." };
  }
  return { ok: true };
}

/**
 * Dedicated prompt for configuring Google Gemini API Keys (Primary & Optional Backup).
 *
 * Frontier Max runs Gemini 3.8 Flash via Claude Code on the free BYOK tier.
 * Users can provide a Primary key and an optional Backup key for instant auto-failover
 * if Google's rate limits (429) or temporary capacity spikes occur.
 */
export const GeminiKeyModal: React.FC = () => {
  const { isGeminiKeyModalOpen, setGeminiKeyModalOpen, setProfile } = useStudioStore();
  const [key, setKey] = useState("");
  const [backupKey, setBackupKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [showBackupKey, setShowBackupKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fetchingExisting, setFetchingExisting] = useState(false);
  const [primaryHint, setPrimaryHint] = useState<string | null>(null);
  const [backupHint, setBackupHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isGeminiKeyModalOpen) return;
    setFetchingExisting(true);
    ProviderService.list()
      .then((res) => {
        const google = res.providers.find((p) => p.id === "google");
        if (google) {
          if (google.configured && google.hint) setPrimaryHint(google.hint);
          if (google.backupConfigured && google.backupHint) setBackupHint(google.backupHint);
        }
      })
      .catch(() => {})
      .finally(() => setFetchingExisting(false));
  }, [isGeminiKeyModalOpen]);

  if (!isGeminiKeyModalOpen) return null;

  const handleClose = () => {
    setError(null);
    setKey("");
    setBackupKey("");
    setGeminiKeyModalOpen(false);
  };

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmedPrimary = key.trim();
    const trimmedBackup = backupKey.trim();

    // If key is empty but we already have a configured key, we keep the existing primary
    if (!trimmedPrimary && !primaryHint) {
      setError("A Primary Google Gemini API key is required.");
      return;
    }

    if (trimmedPrimary) {
      const validation = validateGeminiKey(trimmedPrimary);
      if (!validation.ok) {
        setError(validation.message || "Invalid Primary Google Gemini API key.");
        return;
      }
    }

    if (trimmedBackup) {
      const backupValidation = validateGeminiKey(trimmedBackup);
      if (!backupValidation.ok) {
        setError(`Backup key error: ${backupValidation.message || "Invalid backup key."}`);
        return;
      }
    }

    setLoading(true);
    setError(null);
    try {
      // If primary input is left blank but had an existing key, pass undefined so gateway doesn't overwrite it
      await ProviderService.setKey(
        "google",
        trimmedPrimary || null,
        trimmedBackup !== "" ? trimmedBackup : undefined,
      );
      setProfile("max");
      handleClose();
    } catch (err) {
      setError((err as Error).message || "Failed to save API key. Please check your gateway connection.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4 animate-in fade-in duration-200 font-sans">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="gemini-key-title"
        className="lit lit-inner relative w-full max-w-lg bg-frame-mid border border-edge-chrome rounded-xl shadow-modal overflow-hidden text-ink-prose antialiased"
      >
        <div className="absolute top-3.5 right-3.5 z-10">
          <MacCloseButton onClose={handleClose} size={14} />
        </div>

        <div className="p-6 space-y-4">
          {/* Header */}
          <div className="flex items-start gap-3">
            <div className="lit lit-inner w-10 h-10 rounded-lg bg-purple-500/15 border border-purple-500/30 flex items-center justify-center flex-shrink-0 text-purple-400">
              <Sparkles size={20} />
            </div>
            <div>
              <h2 id="gemini-key-title" className="text-base font-semibold text-ink-bright tracking-tight">
                Connect Google Gemini API Keys
              </h2>
              <p className="text-xs text-ink-muted mt-0.5 leading-relaxed">
                Frontier Max runs Google's flagship <span className="text-purple-300 font-medium">Gemini 3.8 Flash</span> model via Claude Code. It is 100% free on Teminali OS.
              </p>
            </div>
          </div>

          {/* Free Tier Info Box */}
          <div className="lit lit-inner rounded-lg bg-surface -chrome p-3 space-y-1.5 border border-edge-chrome">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-ink-bright flex items-center gap-1.5">
                <KeyRound size={13} className="text-accent" />
                Google AI Studio Free Tier
              </span>
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noreferrer"
                className="text-2xs text-accent hover:underline flex items-center gap-1"
              >
                <span>Get Free Key</span>
                <ExternalLink size={10} />
              </a>
            </div>
            <p className="text-2xs text-ink-muted leading-relaxed">
              Google provides <strong>1,500 requests/day</strong> and <strong>1M tokens/min</strong> for free with no credit card required.
            </p>
          </div>

          {/* Key Input Form */}
          <form onSubmit={handleSave} className="space-y-3.5">
            {/* Primary Key Field */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="gemini-key-input" className="text-xs font-medium text-ink-bright">
                  Primary Gemini Key <span className="text-accent">*</span>
                </label>
                {primaryHint && (
                  <span className="text-3xs text-purple-300 font-mono bg-purple-950/40 px-1.5 py-0.5 rounded border border-purple-800/40">
                    Active: {primaryHint}
                  </span>
                )}
              </div>
              <div className="relative">
                <input
                  id="gemini-key-input"
                  type={showKey ? "text" : "password"}
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value);
                    if (error) setError(null);
                  }}
                  placeholder={primaryHint ? "Paste new key to replace..." : "AIzaSy... or AQ.Ab8..."}
                  autoFocus={!primaryHint}
                  className="lit lit-inner w-full pl-3 pr-10 py-1.5 bg-surface -chrome rounded-lg text-xs font-mono text-ink-bright placeholder:text-ink-placeholder focus:outline-none focus:ring-1 focus:ring-accent border border-edge-chrome transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-2.5 top-2 text-ink-muted hover:text-ink-bright transition-colors"
                  title={showKey ? "Hide key" : "Show key"}
                >
                  {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </div>

            {/* Backup Key Field (Auto-Failover) */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="gemini-backup-key-input" className="text-xs font-medium text-ink-bright flex items-center gap-1.5">
                  <span>Backup Gemini Key</span>
                  <span className="text-3xs text-emerald-400 bg-emerald-950/40 px-1.5 py-0.5 rounded border border-emerald-800/40 font-medium">
                    Auto-Failover
                  </span>
                </label>
                {backupHint && (
                  <span className="text-3xs text-emerald-300 font-mono bg-emerald-950/40 px-1.5 py-0.5 rounded border border-emerald-800/40">
                    Active: {backupHint}
                  </span>
                )}
              </div>
              <div className="relative">
                <input
                  id="gemini-backup-key-input"
                  type={showBackupKey ? "text" : "password"}
                  value={backupKey}
                  onChange={(e) => {
                    setBackupKey(e.target.value);
                    if (error) setError(null);
                  }}
                  placeholder={backupHint ? "Paste new key to replace backup..." : "Optional second key (auto-swaps on rate limit)"}
                  className="lit lit-inner w-full pl-3 pr-10 py-1.5 bg-surface -chrome rounded-lg text-xs font-mono text-ink-bright placeholder:text-ink-placeholder focus:outline-none focus:ring-1 focus:ring-emerald-400 border border-edge-chrome transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowBackupKey(!showBackupKey)}
                  className="absolute right-2.5 top-2 text-ink-muted hover:text-ink-bright transition-colors"
                  title={showBackupKey ? "Hide key" : "Show key"}
                >
                  {showBackupKey ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
              <p className="text-3xs text-ink-muted mt-1 leading-normal">
                If your primary key hits a rate limit (HTTP 429) or quota cap, Teminali OS will seamlessly switch to this backup key with zero interruption.
              </p>
            </div>

            {error && (
              <div className="flex items-center gap-1.5 text-2xs text-danger pt-1">
                <AlertCircle size={12} className="flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-edge-chrome">
              <button
                type="button"
                onClick={handleClose}
                disabled={loading}
                className="px-3.5 py-1.5 rounded-lg text-xs text-ink-muted hover:text-ink-bright hover:bg-surface-chip transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || (!key.trim() && !primaryHint)}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-accent hover:bg-accent-hover disabled:opacity-50 text-frame-top text-xs font-semibold shadow-sm transition-colors"
              >
                {loading ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} strokeWidth={2.2} />}
                <span>Save Keys &amp; Activate</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
