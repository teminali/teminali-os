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
      <div className={`flex items-center gap-4 border-b border-edge-chrome px-2 ${className}`}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChange(tab.id)}
              className={`relative py-2 text-xs font-medium transition-colors flex items-center gap-1.5 ${
                isActive ? "text-accent font-semibold" : "text-ink-muted hover:text-ink-high"
              }`}
            >
              {tab.icon && <span className="flex-shrink-0">{tab.icon}</span>}
              <span>{tab.label}</span>
              {tab.badge !== undefined && (
                <span className="text-4xs px-1.5 py-0.2 rounded-full bg-surface-chip text-ink-muted font-mono">
                  {tab.badge}
                </span>
              )}
              {isActive && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent rounded-t" />
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
    <div className={`lit lit-inner flex items-center gap-1 p-0.5 bg-frame-mid rounded-lg shadow-inner ${className}`}>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={`lit lit-inner flex items-center gap-1.5 rounded-md font-medium transition-all select-none cursor-pointer ${sizeStyles} ${ isActive ? "bg-surface-hover text-ink-high shadow-sm font-semibold " : "text-ink-muted hover:text-ink-high hover:bg-surface-chip border border-transparent" }`}
          >
            {tab.icon && <span className="flex-shrink-0">{tab.icon}</span>}
            <span>{tab.label}</span>
            {tab.badge !== undefined && (
              <span className="text-4xs px-1.5 py-0.2 rounded-full bg-surface-hover text-ink-dim font-mono">
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
