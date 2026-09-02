import React from "react";

export const FileIconTsx: React.FC<{ className?: string }> = ({ className = "w-3.5 h-3.5" }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none">
    <rect width="16" height="16" fill="var(--accent-dim)" fillOpacity="0.2" />
    <path d="M4 4h8v8H4V4z" fill="var(--accent-dim)" fillOpacity="0.4" />
    <text x="8" y="11.5" textAnchor="middle" fill="var(--accent)" fontSize="7.5" fontWeight="900" fontFamily="monospace">TS</text>
  </svg>
);

export const FileIconJsx: React.FC<{ className?: string }> = ({ className = "w-3.5 h-3.5" }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none">
    <rect width="16" height="16" fill="#eab308" fillOpacity="0.2" />
    <text x="8" y="11.5" textAnchor="middle" fill="#facc15" fontSize="7.5" fontWeight="900" fontFamily="monospace">JS</text>
  </svg>
);

export const FileIconJson: React.FC<{ className?: string }> = ({ className = "w-3.5 h-3.5" }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none">
    <rect width="16" height="16" fill="#e11d48" fillOpacity="0.2" />
    <text x="8" y="11" textAnchor="middle" fill="#fb7185" fontSize="7" fontWeight="bold" fontFamily="monospace">{"{}"}</text>
  </svg>
);

export const FileIconHtml: React.FC<{ className?: string }> = ({ className = "w-3.5 h-3.5" }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none">
    <rect width="16" height="16" fill="#ea580c" fillOpacity="0.2" />
    <path d="M3 2l1 11 4 1.5 4-1.5 1-11H3z" fill="#f97316" fillOpacity="0.4" />
    <text x="8" y="10.5" textAnchor="middle" fill="#ffedd5" fontSize="6.5" fontWeight="bold" fontFamily="sans-serif">5</text>
  </svg>
);

export const FileIconMd: React.FC<{ className?: string }> = ({ className = "w-3.5 h-3.5" }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none">
    <rect width="16" height="16" fill="#d97706" fillOpacity="0.2" />
    <text x="8" y="11" textAnchor="middle" fill="#f59e0b" fontSize="6.5" fontWeight="900" fontFamily="monospace">MD</text>
  </svg>
);

export const FileIconCss: React.FC<{ className?: string }> = ({ className = "w-3.5 h-3.5" }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none">
    <rect width="16" height="16" fill="#2563eb" fillOpacity="0.2" />
    <text x="8" y="11" textAnchor="middle" fill="#60a5fa" fontSize="7" fontWeight="bold" fontFamily="monospace">#</text>
  </svg>
);

export const FolderIconDist: React.FC<{ className?: string }> = ({ className = "w-3.5 h-3.5" }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none">
    <path d="M1 3h5l2 2h7v9H1V3z" fill="#ca8a04" fillOpacity="0.3" stroke="#facc15" strokeWidth="1" />
    <rect x="5" y="7" width="6" height="4" fill="#facc15" fillOpacity="0.8" />
  </svg>
);

export const FolderIconSrc: React.FC<{ className?: string }> = ({ className = "w-3.5 h-3.5" }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none">
    <path d="M1 3h5l2 2h7v9H1V3z" fill="var(--accent-dim)" fillOpacity="0.3" stroke="var(--accent)" strokeWidth="1" />
    <path d="M6 7l2 2-2 2M10 11l-2-2 2-2" stroke="var(--accent)" strokeWidth="1" strokeLinecap="square" />
  </svg>
);

export const FolderIconModules: React.FC<{ className?: string }> = ({ className = "w-3.5 h-3.5" }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none">
    <path d="M1 3h5l2 2h7v9H1V3z" fill="#059669" fillOpacity="0.3" stroke="#10b981" strokeWidth="1" />
    <circle cx="8" cy="9" r="2" fill="#10b981" />
  </svg>
);

export const FolderIconElectron: React.FC<{ className?: string }> = ({ className = "w-3.5 h-3.5" }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none">
    <path d="M1 3h5l2 2h7v9H1V3z" fill="#4f46e5" fillOpacity="0.3" stroke="#818cf8" strokeWidth="1" />
    <ellipse cx="8" cy="9" rx="4" ry="2" stroke="#818cf8" strokeWidth="0.8" />
  </svg>
);
