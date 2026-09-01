import React, { useState } from "react";
import { 
  Download, 
  Star, 
  CheckCircle2, 
  ShieldCheck, 
  ExternalLink, 
  Settings, 
  Trash2, 
  Power, 
  Sparkles,
  GitBranch,
  Layers,
  Code
} from "lucide-react";
import { ExtensionItem } from "../../types";
import { useStudioStore } from "../../store/studioStore";

export const ExtensionDetailView: React.FC<{ extension: ExtensionItem }> = ({ extension }) => {
  const [activeTab, setActiveTab] = useState<"readme" | "contributions" | "changelog">("readme");
  const [isInstalled, setIsInstalled] = useState(extension.installed);
  const [isEnabled, setIsEnabled] = useState(extension.enabled);

  return (
    <div className="flex-1 flex flex-col h-full bg-[#08090b] text-[#dcdfe4] overflow-y-auto font-mono select-text">
      {/* Extension Header Banner */}
      <div className="p-6 border-b border-[#1c1f26] bg-[#0c0d12] flex items-start gap-6">
        {/* Large Square Icon */}
        <div className={`w-20 h-20 flex items-center justify-center text-4xl \${extension.iconBg} border border-[#232833] shadow-lg flex-shrink-0`}>
          {extension.iconText}
        </div>

        {/* Info & Action Buttons */}
        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-white">{extension.displayName}</h1>
            <span className="text-2xs font-mono px-2 py-0.5 bg-[#14171f] border border-[#232833] text-[#828997]">
              v{extension.version}
            </span>
          </div>

          <div className="flex items-center gap-3 text-xs text-[#5c6370]">
            <span className="text-[#38bdf8] font-bold hover:underline cursor-pointer flex items-center gap-1">
              {extension.publisher} <CheckCircle2 className="w-3.5 h-3.5 text-[#38bdf8] inline fill-[#38bdf8]/20" />
            </span>
            <span>·</span>
            <span className="flex items-center gap-1 text-[#dcdfe4]">
              <Download className="w-3.5 h-3.5 text-[#5c6370]" /> {extension.downloads}
            </span>
            <span>·</span>
            <span className="flex items-center gap-1 text-amber-400 font-bold">
              <Star className="w-3.5 h-3.5 fill-amber-400" /> {extension.rating} ({extension.ratingCount})
            </span>
            <span>·</span>
            <span className="text-3xs px-2 py-0.5 bg-[#38bdf8]/10 text-[#38bdf8] border border-[#38bdf8]/30 font-bold">
              {extension.category}
            </span>
          </div>

          <p className="text-xs text-[#abb2bf] leading-relaxed max-w-3xl pt-1">
            {extension.description}
          </p>

          {/* Action Buttons */}
          <div className="flex items-center gap-2 pt-3 select-none">
            {isInstalled ? (
              <>
                <button
                  onClick={() => setIsEnabled(!isEnabled)}
                  className={`px-3 py-1 text-2xs font-bold transition-colors flex items-center gap-1.5 \${
                    isEnabled 
                      ? "bg-[#1f2430] hover:bg-[#282f3d] text-white border border-[#232833]" 
                      : "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                  }`}
                >
                  <Power className="w-3 h-3" />
                  {isEnabled ? "Disable" : "Enable"}
                </button>
                <button
                  onClick={() => setIsInstalled(false)}
                  className="px-3 py-1 text-2xs font-bold bg-[#f43f5e]/15 hover:bg-[#f43f5e]/25 text-[#fb7185] border border-[#f43f5e]/40 transition-colors flex items-center gap-1.5"
                >
                  <Trash2 className="w-3 h-3" />
                  Uninstall
                </button>
              </>
            ) : (
              <button
                onClick={() => {
                  setIsInstalled(true);
                  setIsEnabled(true);
                }}
                className="px-4 py-1.5 text-2xs font-bold bg-[#38bdf8] hover:bg-[#0ea5e9] text-black transition-colors flex items-center gap-1.5 shadow-sm"
              >
                <Download className="w-3.5 h-3.5" />
                Install Extension
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Tabs Navigation */}
      <div className="h-9 border-b border-[#1c1f26] bg-[#0c0d12] flex items-center px-6 gap-6 text-2xs font-bold uppercase tracking-wider select-none">
        <button
          onClick={() => setActiveTab("readme")}
          className={`h-full flex items-center border-b-2 transition-all \${
            activeTab === "readme" ? "text-[#38bdf8] border-b-[#38bdf8]" : "text-[#5c6370] border-b-transparent hover:text-white"
          }`}
        >
          Details
        </button>
        <button
          onClick={() => setActiveTab("contributions")}
          className={`h-full flex items-center border-b-2 transition-all \${
            activeTab === "contributions" ? "text-[#38bdf8] border-b-[#38bdf8]" : "text-[#5c6370] border-b-transparent hover:text-white"
          }`}
        >
          Feature Contributions
        </button>
        <button
          onClick={() => setActiveTab("changelog")}
          className={`h-full flex items-center border-b-2 transition-all \${
            activeTab === "changelog" ? "text-[#38bdf8] border-b-[#38bdf8]" : "text-[#5c6370] border-b-transparent hover:text-white"
          }`}
        >
          Changelog
        </button>
      </div>

      {/* Tab Content */}
      <div className="p-8 max-w-4xl space-y-6">
        {activeTab === "readme" && (
          <div className="space-y-4 text-xs leading-relaxed text-[#abb2bf]">
            <div className="p-4 bg-[#0e1015] border border-[#1c1f26] space-y-2">
              <h2 className="text-sm font-bold text-white">Overview & Quickstart</h2>
              <pre className="p-3 bg-[#08090b] text-[#38bdf8] border border-[#232833] font-mono text-2xs whitespace-pre-wrap">
                {extension.readme}
              </pre>
            </div>

            {extension.settings && (
              <div className="space-y-3 pt-4">
                <h3 className="text-sm font-bold text-white">Configuration Settings</h3>
                <div className="border border-[#1c1f26] divide-y divide-[#1c1f26]">
                  {Object.entries(extension.settings).map(([key, setting]) => (
                    <div key={key} className="p-3 bg-[#0e1015] flex flex-col gap-1">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-[#38bdf8]">{key}</span>
                        <span className="text-3xs text-[#5c6370] font-mono bg-[#14171f] px-1.5 py-0.5 border border-[#232833]">
                          {setting.type} (default: {String(setting.default)})
                        </span>
                      </div>
                      <p className="text-3xs text-[#828997]">{setting.description}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "contributions" && (
          <div className="p-4 bg-[#0e1015] border border-[#1c1f26] space-y-3 text-xs">
            <h3 className="font-bold text-white">Contributed Commands & Views</h3>
            <ul className="list-disc pl-5 text-2xs space-y-1 text-[#828997]">
              <li><span className="text-[#38bdf8] font-bold">{extension.name}.format</span> — Format Document</li>
              <li><span className="text-[#38bdf8] font-bold">{extension.name}.openSettings</span> — Open Extension Settings</li>
              <li><span className="text-[#38bdf8] font-bold">{extension.name}.checkStatus</span> — Verify Language Server Health</li>
            </ul>
          </div>
        )}

        {activeTab === "changelog" && (
          <div className="p-4 bg-[#0e1015] border border-[#1c1f26] space-y-3 text-xs">
            <h3 className="font-bold text-white">Release Notes for v{extension.version}</h3>
            <p className="text-2xs text-[#828997]">
              • Performance optimizations for Monaco Editor integration.<br/>
              • Enhanced type checking and instant AST formatting.<br/>
              • Native ARM64 macOS support.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
