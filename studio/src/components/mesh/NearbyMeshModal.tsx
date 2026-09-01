import React, { useState } from "react";
import { 
  Wifi, 
  Share2, 
  Cpu, 
  Laptop, 
  Smartphone, 
  ShieldCheck, 
  Check, 
  Copy, 
  X, 
  Zap, 
  Radio, 
  Users, 
  Globe,
  Key,
  Lock,
  ArrowRight,
  Sparkles,
  Link2
} from "lucide-react";

interface NearbyPeer {
  id: string;
  name: string;
  deviceType: "macbook" | "windows" | "ipad";
  connectionType: "local_wifi" | "remote_tunnel";
  location: string;
  ipAddress: string;
  connectedSince: string;
  tokensServed: number;
  latencyMs: number;
  status: "active" | "idle";
}

export const NearbyMeshModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<"nearby" | "remote">("nearby");
  const [isCopied, setIsCopied] = useState(false);
  const [remoteTunnelActive, setRemoteTunnelActive] = useState(true);

  const localIp = "192.168.1.145:3000";
  const meshCode = "FRONTIER-8842";
  const remoteRelayUrl = "https://mesh.frontier-studio.run/relay-8942-gpu";
  const remoteAuthToken = "fr_sec_live_9921894b8e7c10";

  const [connectedPeers, setConnectedPeers] = useState<NearbyPeer[]>([
    {
      id: "p1",
      name: "Sarah's MacBook Air (Intel)",
      deviceType: "macbook",
      connectionType: "local_wifi",
      location: "Same Wi-Fi (Office)",
      ipAddress: "192.168.1.182",
      connectedSince: "14m ago",
      tokensServed: 5420,
      latencyMs: 1.8,
      status: "active",
    },
    {
      id: "p2",
      name: "David (Remote Engineer)",
      deviceType: "windows",
      connectionType: "remote_tunnel",
      location: "San Francisco, US (P2P Tunnel)",
      ipAddress: "198.51.100.42",
      connectedSince: "38m ago",
      tokensServed: 12840,
      latencyMs: 24.2,
      status: "active",
    },
  ]);

  if (!isOpen) return null;

  const handleCopyLink = () => {
    const textToCopy = activeTab === "nearby"
      ? `http://${localIp}?meshCode=${meshCode}`
      : `${remoteRelayUrl}?token=${remoteAuthToken}`;
    navigator.clipboard.writeText(textToCopy);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 1500);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 select-none font-mono text-xs">
      <div className="w-full max-w-2xl bg-[#0c0d12] border border-[#00f0ff]/30 rounded-3xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        
        {/* Modal Header */}
        <div className="h-16 px-6 border-b border-[#1c1f26] bg-[#0e1015] flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-[#00f0ff]/15 border border-[#00f0ff]/30 flex items-center justify-center text-[#00f0ff]">
              {activeTab === "nearby" ? <Radio className="w-5 h-5 animate-pulse" /> : <Globe className="w-5 h-5 text-[#8b5cf6] animate-pulse" />}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-white text-sm font-sans">Frontier Mesh // GPU Capacity Relay</span>
                <span className="text-3xs font-mono font-bold text-[#10b981] bg-[#10b981]/15 px-2 py-0.5 rounded border border-[#10b981]/30">
                  {activeTab === "nearby" ? "LAN ACTIVE" : "GLOBAL TUNNEL ACTIVE"}
                </span>
              </div>
              <p className="text-3xs text-slate-400 font-sans mt-0.5">
                Share your Apple Silicon GPU locally via Wi-Fi or remotely over encrypted P2P tunnels.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white hover:bg-[#181c24] rounded-xl transition-all cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Switcher: Nearby Wi-Fi vs Remote Share */}
        <div className="h-11 px-6 bg-[#08090c] border-b border-[#1c1f26] flex items-center gap-3">
          <button
            onClick={() => setActiveTab("nearby")}
            className={`h-full flex items-center gap-2 text-2xs font-bold font-sans transition-all border-b-2 ${
              activeTab === "nearby"
                ? "border-[#00f0ff] text-[#00f0ff]"
                : "border-transparent text-slate-400 hover:text-white"
            }`}
          >
            <Radio className="w-3.5 h-3.5" />
            <span>Nearby Share (Local Wi-Fi)</span>
          </button>

          <button
            onClick={() => setActiveTab("remote")}
            className={`h-full flex items-center gap-2 text-2xs font-bold font-sans transition-all border-b-2 ${
              activeTab === "remote"
                ? "border-[#8b5cf6] text-[#8b5cf6]"
                : "border-transparent text-slate-400 hover:text-white"
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            <span>Remote Share (Global P2P Relay)</span>
            <span className="text-3xs bg-[#8b5cf6]/20 text-[#8b5cf6] px-1.5 py-0.2 rounded-full font-mono">NEW</span>
          </button>
        </div>

        {/* Modal Content Canvas */}
        <div className="p-6 space-y-6 bg-[#08090c] overflow-y-auto">
          
          {/* TAB 1: NEARBY SHARE */}
          {activeTab === "nearby" ? (
            <div className="p-5 rounded-2xl bg-[#0e1015] border border-[#00f0ff]/20 shadow-lg space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#10b981] animate-pulse" />
                  <span className="font-bold text-white text-xs font-sans">Local Wi-Fi GPU Broadcast</span>
                </div>
                <span className="text-3xs font-mono text-[#00f0ff] bg-[#00f0ff]/10 px-2.5 py-1 rounded-full border border-[#00f0ff]/25">
                  Sub-2ms LAN Streaming
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <div className="p-3 bg-[#08090c] rounded-xl border border-white/5 space-y-1">
                  <div className="text-3xs text-slate-500 uppercase font-sans">Local Wi-Fi Address</div>
                  <div className="text-sm font-bold text-[#00f0ff] font-mono truncate">http://{localIp}</div>
                </div>

                <div className="p-3 bg-[#08090c] rounded-xl border border-white/5 space-y-1">
                  <div className="text-3xs text-slate-500 uppercase font-sans">6-Digit Mesh PIN</div>
                  <div className="text-sm font-bold text-[#10b981] font-mono tracking-widest">{meshCode}</div>
                </div>
              </div>

              <button
                onClick={handleCopyLink}
                className="w-full py-2.5 rounded-xl bg-[#00f0ff] hover:bg-[#00d0dd] text-black font-bold text-xs font-sans transition-all flex items-center justify-center gap-2 cursor-pointer shadow-md shadow-[#00f0ff]/20"
              >
                {isCopied ? <Check className="w-4 h-4" /> : <Share2 className="w-4 h-4" />}
                <span>{isCopied ? "Nearby Link Copied!" : "Copy 1-Click Nearby Join Link"}</span>
              </button>
            </div>
          ) : (
            /* TAB 2: REMOTE GLOBAL SHARE */
            <div className="p-5 rounded-2xl bg-[#0e1015] border border-[#8b5cf6]/30 shadow-lg space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#8b5cf6] animate-pulse" />
                  <span className="font-bold text-white text-xs font-sans">Global Encrypted P2P GPU Tunnel</span>
                </div>
                <span className="text-3xs font-mono text-[#8b5cf6] bg-[#8b5cf6]/10 px-2.5 py-1 rounded-full border border-[#8b5cf6]/25">
                  End-to-End Encrypted
                </span>
              </div>

              <div className="p-3 bg-[#08090c] rounded-xl border border-white/5 space-y-1">
                <div className="text-3xs text-slate-500 uppercase font-sans">Secure Remote Access URL</div>
                <div className="text-xs font-bold text-[#8b5cf6] font-mono truncate">{remoteRelayUrl}</div>
              </div>

              <div className="p-3 bg-[#08090c] rounded-xl border border-white/5 space-y-1">
                <div className="flex items-center justify-between">
                  <div className="text-3xs text-slate-500 uppercase font-sans">Remote Auth Access Key</div>
                  <span className="text-3xs text-slate-500 font-mono">256-bit AES</span>
                </div>
                <div className="text-xs font-bold text-slate-300 font-mono tracking-wider">{remoteAuthToken}</div>
              </div>

              <button
                onClick={handleCopyLink}
                className="w-full py-2.5 rounded-xl bg-gradient-to-r from-[#8b5cf6] to-[#00f0ff] hover:opacity-95 text-white font-bold text-xs font-sans transition-all flex items-center justify-center gap-2 cursor-pointer shadow-md shadow-[#8b5cf6]/20"
              >
                {isCopied ? <Check className="w-4 h-4" /> : <Link2 className="w-4 h-4" />}
                <span>{isCopied ? "Remote Token Link Copied!" : "Copy Global Remote Invite Link"}</span>
              </button>
            </div>
          )}

          {/* Connected Peers List */}
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 text-white font-bold font-sans">
                <Users className="w-4 h-4 text-[#00f0ff]" />
                <span>Connected Peers ({connectedPeers.length})</span>
              </div>
              <span className="text-3xs text-slate-500 font-mono">Auto-Load Balanced</span>
            </div>

            <div className="space-y-2">
              {connectedPeers.map((peer) => (
                <div
                  key={peer.id}
                  className="p-3.5 rounded-xl bg-[#0e1015] border border-white/5 flex items-center justify-between hover:border-white/10 transition-all"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center text-slate-400">
                      {peer.deviceType === "macbook" ? <Laptop className="w-4 h-4" /> : <Smartphone className="w-4 h-4" />}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-white text-2xs font-sans">{peer.name}</span>
                        <span className={`text-3xs font-mono px-1.5 py-0.2 rounded \${
                          peer.connectionType === "local_wifi" ? "bg-[#00f0ff]/15 text-[#00f0ff]" : "bg-[#8b5cf6]/15 text-[#8b5cf6]"
                        }`}>
                          {peer.connectionType === "local_wifi" ? "Local Wi-Fi" : "Remote Tunnel"}
                        </span>
                      </div>
                      <div className="text-3xs text-slate-500 font-mono mt-0.5">{peer.location} · {peer.latencyMs}ms ping</div>
                    </div>
                  </div>

                  <div className="text-right font-mono">
                    <div className="text-2xs font-bold text-[#10b981]">{peer.tokensServed.toLocaleString()} tokens</div>
                    <div className="text-3xs text-slate-500">$0.00 (Shared GPU)</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>

        {/* Modal Footer Strip */}
        <div className="h-14 px-6 border-t border-[#1c1f26] bg-[#0e1015] flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2 text-3xs text-slate-400 font-sans">
            <ShieldCheck className="w-3.5 h-3.5 text-[#10b981]" />
            <span>Peer-to-Peer Encrypted · No Cloud Middleman · 100% Sovereign AI</span>
          </div>

          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-sans font-semibold transition-all cursor-pointer"
          >
            Done
          </button>
        </div>

      </div>
    </div>
  );
};
