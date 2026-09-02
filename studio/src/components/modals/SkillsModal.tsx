import React from "react";
import { Boxes, Camera, Check, Film, Layout, ScanEye, ShieldCheck } from "lucide-react";
import { Modal } from "../ui";
import { SKILLS_LIST, useStudioStore } from "../../store/studioStore";

/**
 * Skill packs, as a list you pick from.
 *
 * This used to draw its own dialog — its own backdrop, its own header, its own
 * close button (two of them, in fact) — in uppercase mono on square-cornered
 * boxes. It now goes through the `Modal` primitive like every other dialog in
 * the studio, which is what DESIGN.md §2 asks for and what keeps a change to
 * dialog chrome from having to be made twice.
 *
 * The rows are deliberately the same object as a sidebar row: muted label,
 * muted glyph, hover fill, and a selected state that is a fill rather than a
 * coloured border. Cursor has one vocabulary for "a list of things you choose
 * between" and this is a list of things you choose between.
 */

const GLYPHS: Record<string, React.ElementType> = {
  "website-builder": Layout,
  "teminali-cut-copilot": Film,
  "frontiercut-copilot": Film,
  "qa-verifier": ShieldCheck,
  "screenshot-to-code": Camera,
  "pixel-precision-cloner": Camera,
  "visual-verification-tester": ScanEye,
};

export const SkillsModal: React.FC = () => {
  const { isSkillsModalOpen, setSkillsModalOpen, activeSkill, setSkill } = useStudioStore();

  return (
    <Modal
      isOpen={isSkillsModalOpen}
      onClose={() => setSkillsModalOpen(false)}
      title="Skills"
      subtitle="Domain rules and tool behaviour, mounted into the next turn"
      size="md"
    >
      <div className="flex flex-col gap-0.5">
        {SKILLS_LIST.map((skill) => {
          const isActive = activeSkill?.id === skill.id;
          const Glyph = GLYPHS[skill.id] ?? Boxes;
          return (
            <button
              key={skill.id}
              type="button"
              aria-pressed={isActive}
              onClick={() => {
                // Clicking the mounted one unmounts it: in a list with no other
                // way out, "mount" that cannot be undone is a trap.
                setSkill(isActive ? null : skill);
                if (!isActive) setSkillsModalOpen(false);
              }}
              className={`w-full text-left rounded-lg px-3 py-2.5 flex items-start gap-3 transition-colors duration-ds ease-ds ${
                isActive ? "bg-surface-active" : "hover:bg-surface-hover"
              }`}
            >
              <Glyph
                size={16}
                strokeWidth={1.7}
                className={`mt-0.5 flex-shrink-0 ${isActive ? "text-ink-high" : "text-ink-muted"}`}
              />

              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-2">
                  <span className={`text-sm truncate ${isActive ? "text-ink-strong" : "text-ink-body"}`}>
                    {skill.name}
                  </span>
                  <span className="text-2xs text-ink-soft truncate">{skill.tagline}</span>
                </span>
                <span className="block text-2xs text-ink-muted leading-relaxed mt-1">
                  {skill.description}
                </span>
              </span>

              {isActive && (
                <span className="flex items-center gap-1 text-2xs text-ink-muted flex-shrink-0 mt-0.5">
                  <Check size={12} />
                  Mounted
                </span>
              )}
            </button>
          );
        })}
      </div>
    </Modal>
  );
};
