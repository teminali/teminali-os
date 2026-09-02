import React, { useEffect, useState } from "react";
import { Cloud, Layers, MonitorCog } from "lucide-react";
import { ModelLibrary } from "./ModelLibrary";
import { ApiProviders } from "./ApiProviders";

/**
 * Where the operator decides what actually runs their turns.
 *
 * Two runtimes, one switch. Local keeps everything on the machine at no cost
 * per token; hosted trades that for capability. Both sides expose the same two
 * lanes and the same automatic routing, so the choice is about cost and privacy
 * rather than about learning a different product.
 */

export type RuntimeMode = "local" | "api";

const STORAGE_KEY = "teminali_runtime_mode";

export const ModelsPane: React.FC = () => {
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
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-md font-semibold text-ink-bright tracking-tight flex items-center gap-2">
          <Layers size={16} className="text-accent" />
          Models
        </h1>
        <p className="text-2xs text-ink-faint mt-1 max-w-xl leading-relaxed">
          Run everything locally at no cost per token, or connect a hosted provider. Either way Frontier picks a light
          model for everyday turns and a stronger one when a task needs it.
        </p>
      </div>

      {/* Runtime switch */}
      <div className="lit lit-inner inline-flex items-center gap-1 p-0.5 rounded-lg bg-surface-sunken self-start">
        <Option
          active={mode === "local"}
          onClick={() => setMode("local")}
          icon={<MonitorCog size={12} />}
          label="Local models"
          detail="$0 per token"
        />
        <Option
          active={mode === "api"}
          onClick={() => setMode("api")}
          icon={<Cloud size={12} />}
          label="API keys"
          detail="Anthropic · OpenAI · Google"
        />
      </div>

      {mode === "local" ? <ModelLibrary /> : <ApiProviders />}
    </div>
  );
};

const Option: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  detail: string;
}> = ({ active, onClick, icon, label, detail }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`h-8 px-3 rounded-md flex items-center gap-2 transition-colors duration-ds ease-ds ${
      active ? "bg-surface-tab text-ink-strong" : "text-ink-muted hover:text-ink-high"
    }`}
  >
    <span className={active ? "text-accent" : ""}>{icon}</span>
    <span className="text-xs">{label}</span>
    <span className="text-3xs text-ink-faint">{detail}</span>
  </button>
);
