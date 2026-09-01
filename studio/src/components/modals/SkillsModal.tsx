import React from "react";
import { X, Boxes, Check, Layout, Film, ShieldCheck, Camera, ScanEye } from "lucide-react";
import { useStudioStore, SKILLS_LIST } from "../../store/studioStore";

export const SkillsModal: React.FC = () => {
  const { isSkillsModalOpen, setSkillsModalOpen, activeSkill, setSkill } = useStudioStore();

  if (!isSkillsModalOpen) return null;

  const getIcon = (id: string) => {
    switch (id) {
      case "website-builder":
        return <Layout className="w-4 h-4 text-sky-400" />;
      case "teminali-cut-copilot":
      case "frontiercut-copilot":
        return <Film className="w-4 h-4 text-purple-400" />;
      case "qa-verifier":
        return <ShieldCheck className="w-4 h-4 text-emerald-400" />;
      case "screenshot-to-code":
      case "pixel-precision-cloner":
        return <Camera className="w-4 h-4 text-cyan-400" />;
      case "visual-verification-tester":
        return <ScanEye className="w-4 h-4 text-amber-400" />;
      default:
        return <Boxes className="w-4 h-4 text-brand" />;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-100 font-mono">
      <div className="w-full max-w-2xl bg-[#0e1015] border border-[#232833] p-6 shadow-2xl flex flex-col gap-4">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-[#232833] pb-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-[#8b5cf6]/15 text-[#c4b5fd] flex items-center justify-center border border-[#8b5cf6]/40">
              <Boxes className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white tracking-wide uppercase">Specialist Skill Packs</h2>
              <p className="text-2xs text-[#5c6370]">Inject domain-specific rules and tool behaviors into Teminali</p>
            </div>
          </div>

          <button
            onClick={() => setSkillsModalOpen(false)}
            className="w-7 h-7 flex items-center justify-center hover:bg-[#1f2430] text-[#5c6370] hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Skill Card Grid */}
        <div className="grid grid-cols-1 gap-2 max-h-[60vh] overflow-y-auto pr-1">
          {SKILLS_LIST.map((skill) => {
            const isActive = activeSkill?.id === skill.id;
            return (
              <div
                key={skill.id}
                onClick={() => {
                  setSkill(skill);
                  setSkillsModalOpen(false);
                }}
                className={`p-3.5 border transition-all cursor-pointer flex flex-col gap-2 \${
                  isActive
                    ? "bg-[#8b5cf6]/10 border-[#8b5cf6] shadow-inner"
                    : "bg-[#14171f] border-[#232833] hover:border-[#3e4451] hover:bg-[#181b22]"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-[#090a0d] border border-[#232833]">
                      {getIcon(skill.id)}
                    </div>
                    <div>
                      <span className="font-bold text-xs text-white">{skill.name}</span>
                      <p className="text-3xs text-[#828997]">{skill.tagline}</p>
                    </div>
                  </div>

                  {isActive ? (
                    <span className="flex items-center gap-1 text-3xs font-bold px-2 py-0.5 bg-[#8b5cf6]/20 text-[#c4b5fd] border border-[#8b5cf6]/50">
                      <Check className="w-3 h-3" /> ACTIVE
                    </span>
                  ) : (
                    <button className="text-3xs font-bold px-2 py-1 bg-[#090a0d] border border-[#232833] text-[#5c6370] hover:text-white">
                      MOUNT SKILL
                    </button>
                  )}
                </div>

                <p className="text-2xs text-[#abb2bf] leading-relaxed">{skill.description}</p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
