import React, { useState } from "react";
import { 
  Search, 
  Filter, 
  Download, 
  Star, 
  Check, 
  Settings, 
  ChevronDown, 
  ChevronRight,
  Sparkles,
  CheckCircle2
} from "lucide-react";
import { EXTENSIONS_CATALOG } from "../../store/extensionsData";
import { ExtensionItem } from "../../types";
import { useStudioStore } from "../../store/studioStore";

export const ExtensionMarketplace: React.FC = () => {
  const [searchQuery, setSearchQuery] = useState("");
  const [filterCategory, setFilterCategory] = useState<string>("All");
  const [isInstalledOpen, setInstalledOpen] = useState(true);
  const [isPopularOpen, setPopularOpen] = useState(true);
  const { openFile } = useStudioStore();

  const filteredExtensions = EXTENSIONS_CATALOG.filter((ext) => {
    const matchesSearch = ext.displayName.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          ext.publisher.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          ext.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = filterCategory === "All" || ext.category === filterCategory;
    return matchesSearch && matchesCategory;
  });

  const installedList = filteredExtensions.filter((e) => e.installed);
  const recommendedList = filteredExtensions.filter((e) => !e.installed);

  const handleOpenDetail = (ext: ExtensionItem) => {
    openFile({
      name: ext.displayName,
      path: "extension:" + ext.id,
      language: "markdown",
      content: ext.readme,
    });
  };

  return (
    <aside className="w-72 bg-[#08090b] border-r border-[#1c1f26] flex flex-col select-none h-full text-[#abb2bf] font-mono flex-shrink-0">
      {/* Header Strip */}
      <div className="h-8 px-3 border-b border-[#1c1f26] flex items-center justify-between bg-[#0e1015] flex-shrink-0">
        <span className="text-3xs font-bold uppercase tracking-wider text-[#828997]">Extensions</span>
        <span className="text-3xs font-bold text-[#38bdf8] bg-[#38bdf8]/15 px-1.5 py-0.2 border border-[#38bdf8]/30">
          Open-VSX
        </span>
      </div>

      {/* Search & Category Filter Bar */}
      <div className="p-2.5 border-b border-[#1c1f26] bg-[#0c0d12] space-y-2 flex-shrink-0">
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search Extensions in Marketplace..."
            className="w-full bg-[#08090b] border border-[#232833] focus:border-[#38bdf8] text-2xs text-white pl-7 pr-2 py-1.5 focus:outline-none"
          />
          <Search className="w-3 h-3 text-[#5c6370] absolute left-2 top-2.5" />
        </div>

        {/* Category Pills */}
        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar text-3xs">
          {["All", "Formatters", "Linters", "Languages", "AI & MCP", "Themes"].map((cat) => (
            <button
              key={cat}
              onClick={() => setFilterCategory(cat)}
              className={`px-2 py-0.5 border whitespace-nowrap transition-colors ${
                filterCategory === cat
                  ? "bg-[#38bdf8]/15 text-[#38bdf8] border-[#38bdf8]/40 font-bold"
                  : "bg-[#08090b] text-[#5c6370] border-[#1c1f26] hover:text-white"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Extension Lists Accordion */}
      <div className="flex-1 overflow-y-auto p-1 space-y-1">
        {/* Installed Section */}
        <div>
          <button
            onClick={() => setInstalledOpen(!isInstalledOpen)}
            className="w-full h-6 px-2 flex items-center justify-between text-3xs font-bold uppercase text-[#828997] hover:text-white hover:bg-[#0e1015]"
          >
            <div className="flex items-center gap-1">
              {isInstalledOpen ? <ChevronDown className="w-3 h-3 text-[#38bdf8]" /> : <ChevronRight className="w-3 h-3 text-[#5c6370]" />}
              <span>Installed</span>
            </div>
            <span className="px-1.5 py-0.2 bg-[#1c1f26] text-[#abb2bf] font-mono">{installedList.length}</span>
          </button>

          {isInstalledOpen && (
            <div className="space-y-1 mt-1">
              {installedList.map((ext) => (
                <div
                  key={ext.id}
                  onClick={() => handleOpenDetail(ext)}
                  className="p-2 bg-[#0e1015] border border-[#1c1f26] hover:border-[#38bdf8]/50 transition-all cursor-pointer group flex items-start gap-2"
                >
                  <div className={`w-8 h-8 flex items-center justify-center text-base ${ext.iconBg} border border-[#232833] flex-shrink-0`}>
                    {ext.iconText}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-xs text-white group-hover:text-[#38bdf8] truncate transition-colors">
                        {ext.displayName}
                      </span>
                      <span className="text-3xs text-[#10b981] font-bold bg-[#10b981]/15 px-1 rounded">
                        ✓
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-3xs text-[#5c6370]">
                      <span className="text-[#828997] truncate">{ext.publisher}</span>
                      <span>·</span>
                      <span>★ {ext.rating}</span>
                    </div>
                    <p className="text-3xs text-[#5c6370] line-clamp-1 mt-0.5">
                      {ext.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recommended / Marketplace Section */}
        <div className="pt-2 border-t border-[#1c1f26]">
          <button
            onClick={() => setPopularOpen(!isPopularOpen)}
            className="w-full h-6 px-2 flex items-center justify-between text-3xs font-bold uppercase text-[#828997] hover:text-white hover:bg-[#0e1015]"
          >
            <div className="flex items-center gap-1">
              {isPopularOpen ? <ChevronDown className="w-3 h-3 text-[#38bdf8]" /> : <ChevronRight className="w-3 h-3 text-[#5c6370]" />}
              <span>Marketplace / Popular</span>
            </div>
            <span className="px-1.5 py-0.2 bg-[#1c1f26] text-[#abb2bf] font-mono">{recommendedList.length}</span>
          </button>

          {isPopularOpen && (
            <div className="space-y-1 mt-1">
              {recommendedList.map((ext) => (
                <div
                  key={ext.id}
                  onClick={() => handleOpenDetail(ext)}
                  className="p-2 bg-[#0e1015] border border-[#1c1f26] hover:border-[#38bdf8]/50 transition-all cursor-pointer group flex items-start gap-2"
                >
                  <div className={`w-8 h-8 flex items-center justify-center text-base ${ext.iconBg} border border-[#232833] flex-shrink-0`}>
                    {ext.iconText}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-xs text-white group-hover:text-[#38bdf8] truncate transition-colors">
                        {ext.displayName}
                      </span>
                      <button
                        onClick={(e) => e.stopPropagation()}
                        disabled
                        title="Extension installation is not connected in this browser build"
                        className="text-3xs font-bold px-2 py-0.5 bg-[#27313a] text-[#71808d] cursor-not-allowed rounded-sm"
                      >
                        Unavailable
                      </button>
                    </div>
                    <div className="flex items-center gap-1.5 text-3xs text-[#5c6370]">
                      <span className="text-[#828997] truncate">{ext.publisher}</span>
                      <span>·</span>
                      <span>↓ {ext.downloads}</span>
                    </div>
                    <p className="text-3xs text-[#5c6370] line-clamp-1 mt-0.5">
                      {ext.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};
