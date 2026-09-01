import React from "react";

export interface TabItem<T extends string = string> {
  id: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  badge?: string | number;
}

export interface SegmentedTabsProps<T extends string = string> {
  tabs: TabItem<T>[];
  activeTab: T;
  onChange: (tabId: T) => void;
  variant?: "pill" | "underline" | "dock";
  size?: "sm" | "md";
  className?: string;
}

export function SegmentedTabs<T extends string = string>({
  tabs,
  activeTab,
  onChange,
  variant = "pill",
  size = "sm",
  className = "",
}: SegmentedTabsProps<T>) {
  if (variant === "underline") {
    return (
      <div className={`flex items-center gap-4 border-b border-white/5 px-2 ${className}`}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChange(tab.id)}
              className={`relative py-2 text-xs font-medium transition-colors flex items-center gap-1.5 ${
                isActive ? "text-[#38bdf8] font-semibold" : "text-gray-400 hover:text-white"
              }`}
            >
              {tab.icon && <span className="flex-shrink-0">{tab.icon}</span>}
              <span>{tab.label}</span>
              {tab.badge !== undefined && (
                <span className="text-4xs px-1.5 py-0.2 rounded-full bg-white/5 text-gray-400 font-mono">
                  {tab.badge}
                </span>
              )}
              {isActive && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#38bdf8] rounded-t" />
              )}
            </button>
          );
        })}
      </div>
    );
  }

  // Pill variant (Standard Cursor Tab Pill Bar)
  const sizeStyles = size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-1.5 text-xs";

  return (
    <div className={`flex items-center gap-1 p-0.5 bg-[#0f0f13] border border-white/10 rounded-lg shadow-inner ${className}`}>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={`flex items-center gap-1.5 rounded-md font-medium transition-all select-none cursor-pointer ${sizeStyles} ${
              isActive
                ? "bg-[#23232a] text-white shadow-sm font-semibold border border-white/10"
                : "text-gray-400 hover:text-white hover:bg-white/5 border border-transparent"
            }`}
          >
            {tab.icon && <span className="flex-shrink-0">{tab.icon}</span>}
            <span>{tab.label}</span>
            {tab.badge !== undefined && (
              <span className="text-4xs px-1.5 py-0.2 rounded-full bg-white/10 text-gray-300 font-mono">
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
