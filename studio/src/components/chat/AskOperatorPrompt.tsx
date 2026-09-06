import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CornerDownLeft, HelpCircle, PenLine } from "lucide-react";
import type { AskAnswer, AskQuestion } from "../../services/askToolCalls";

interface AskOperatorPromptProps {
  questions: AskQuestion[] | null;
  onAnswer: (answers: AskAnswer[]) => void;
  onDismiss: () => void;
}

/**
 * The picker the local lane puts a question through.
 *
 * The sibling of CommandApprovalPrompt and built to the same three-band shape,
 * because it sits in the same slot above the composer and a second visual
 * language there would read as a second product. Where that one asks for a
 * verdict on something the model wants to do, this one asks for a decision
 * only the operator can make — so the bands carry a step indicator instead of
 * a warning, and the answers are the operator's options rather than
 * allow/deny.
 *
 * The operator asked for "a tree of options and stepped tabs". The tabs are
 * the questions and they only appear when there is more than one, because a
 * single tab is a label pretending to be navigation. A single-select answer
 * advances to the next unanswered tab on click, and the last one submits — a
 * one-question ask is therefore exactly one click, which is the whole reason
 * to prefer this over the model asking in prose.
 *
 * "Other" is always available, for the same reason AskUserQuestion offers it:
 * the model wrote these options from a guess about the problem, and the
 * operator is the one who knows it was the wrong guess. An answer typed here
 * reaches the model verbatim.
 */
export const AskOperatorPrompt: React.FC<AskOperatorPromptProps> = ({ questions, onAnswer, onDismiss }) => {
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [otherOpen, setOtherOpen] = useState<Record<number, boolean>>({});
  const firstRef = useRef<HTMLButtonElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);

  // A new set of questions is a new decision: nothing from the last one
  // carries over, including which tab was open.
  useEffect(() => {
    setActive(0);
    setPicked({});
    setOther({});
    setOtherOpen({});
  }, [questions]);

  useEffect(() => {
    if (questions) firstRef.current?.focus();
  }, [questions, active]);

  const answeredAt = useCallback(
    (index: number) => (picked[index]?.length ?? 0) > 0 || Boolean(other[index]?.trim()),
    [picked, other],
  );

  const complete = useMemo(
    () => Boolean(questions) && questions!.every((_, index) => answeredAt(index)),
    [questions, answeredAt],
  );

  const submit = useCallback(
    (overrides?: Record<number, string[]>) => {
      if (!questions) return;
      const chosen = overrides ?? picked;
      const answers: AskAnswer[] = questions.map((question, index) => ({
        header: question.header,
        question: question.question,
        labels: chosen[index] ?? [],
        ...(other[index]?.trim() ? { other: other[index].trim() } : {}),
      }));
      // Every question must have something in it: a half-answered set read
      // back to the model as "no answer" for tab two is worse than no ask.
      if (answers.some((answer) => answer.labels.length === 0 && !answer.other)) return;
      onAnswer(answers);
    },
    [questions, picked, other, onAnswer],
  );

  const choose = useCallback(
    (index: number, label: string) => {
      if (!questions) return;
      const question = questions[index];
      const current = picked[index] ?? [];
      if (question.multiSelect) {
        const next = current.includes(label) ? current.filter((item) => item !== label) : [...current, label];
        setPicked({ ...picked, [index]: next });
        return;
      }
      const next = { ...picked, [index]: [label] };
      setPicked(next);
      // Single-select is a decision, so it moves: the next tab that still
      // needs an answer, or the end of the ask.
      const unanswered = questions.findIndex(
        (_, other_) => other_ !== index && (next[other_]?.length ?? 0) === 0 && !other[other_]?.trim(),
      );
      if (unanswered >= 0) setActive(unanswered);
      else submit(next);
    },
    [questions, picked, other, submit],
  );

  useEffect(() => {
    if (!questions) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
        return;
      }
      // While the operator is typing their own answer the number keys are
      // characters, not shortcuts.
      if (document.activeElement === otherRef.current) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (complete) submit();
        return;
      }
      const digit = Number(event.key);
      const options = questions[active]?.options ?? [];
      if (Number.isInteger(digit) && digit >= 1 && digit <= options.length) {
        event.preventDefault();
        choose(active, options[digit - 1].label);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [questions, active, complete, choose, submit, onDismiss]);

  if (!questions || questions.length === 0) return null;

  const question = questions[active];
  const selected = picked[active] ?? [];

  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label={question.question}
      className="mx-3 mb-1.5 rounded-lg bg-surface-chip border border-accent/25 overflow-hidden"
    >
      <div className="flex items-center gap-2 px-2.5 h-7 text-2xs border-b border-edge-popover">
        <HelpCircle size={11} className="text-accent flex-shrink-0" />
        <span className="text-ink-high truncate">Waiting on you to choose</span>
        <span className="flex-1" />
        {questions.length > 1 && (
          <span className="text-ink-muted flex-shrink-0">
            {active + 1} of {questions.length}
          </span>
        )}
      </div>

      {/* The stepped tabs. One tab is not navigation, so they appear only when
          the model actually asked more than one thing. */}
      {questions.length > 1 && (
        <div className="flex items-center gap-1 px-2.5 pt-2" role="tablist">
          {questions.map((item, index) => (
            <button
              key={`${item.header}-${index}`}
              type="button"
              role="tab"
              aria-selected={index === active}
              onClick={() => setActive(index)}
              title={item.question}
              className={`min-w-0 flex items-center gap-1 px-2 h-5 rounded text-2xs font-semibold transition-colors ${
                index === active
                  ? "bg-accent/15 text-accent"
                  : "text-ink-muted hover:bg-surface-hover hover:text-ink-high"
              }`}
            >
              {answeredAt(index) && <Check size={9} className="flex-shrink-0 opacity-70" />}
              <span className="truncate">{item.header}</span>
            </button>
          ))}
        </div>
      )}

      <div className="px-2.5 pt-2 pb-1">
        <div className="text-2xs text-ink-high">{question.question}</div>
        {question.multiSelect && <div className="mt-0.5 text-2xs text-ink-muted">Pick as many as apply.</div>}
      </div>

      <div className="flex flex-col gap-1 px-2.5 pb-2">
        {question.options.map((option, index) => {
          const on = selected.includes(option.label);
          return (
            <button
              key={option.label}
              ref={index === 0 ? firstRef : undefined}
              type="button"
              onClick={() => choose(active, option.label)}
              aria-pressed={on}
              className={`w-full text-left flex items-start gap-2 px-2 py-1.5 rounded-md border transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${
                on ? "bg-accent/10 border-accent/40" : "bg-transparent border-edge-popover hover:bg-surface-hover"
              }`}
            >
              <span
                className={`mt-[1px] w-3.5 h-3.5 rounded flex items-center justify-center text-2xs font-mono flex-shrink-0 ${
                  on ? "bg-accent/25 text-accent" : "bg-surface-hover text-ink-disabled"
                }`}
              >
                {on ? <Check size={9} /> : index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-2xs text-ink-high font-semibold">{option.label}</span>
                {option.description && (
                  <span className="block text-2xs text-ink-muted line-clamp-2">{option.description}</span>
                )}
              </span>
            </button>
          );
        })}

        {/* The escape hatch. The options came from the model's guess at the
            problem; this is where the operator says it guessed wrong. */}
        {otherOpen[active] ? (
          <input
            ref={otherRef}
            autoFocus
            value={other[active] ?? ""}
            onChange={(event) => setOther({ ...other, [active]: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (complete) submit();
              }
            }}
            placeholder="Your own answer…"
            className="w-full px-2 py-1.5 rounded-md bg-surface-hover border border-edge-popover text-2xs text-ink-high placeholder:text-ink-disabled focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
          />
        ) : (
          <button
            type="button"
            onClick={() => setOtherOpen({ ...otherOpen, [active]: true })}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-2xs text-ink-muted hover:bg-surface-hover hover:text-ink-high transition-colors"
          >
            <PenLine size={9} className="opacity-70" />
            Other…
          </button>
        )}
      </div>

      <div className="flex items-center gap-1.5 px-2.5 pb-2">
        <button
          type="button"
          disabled={!complete}
          onClick={() => submit()}
          className="flex items-center gap-1 px-2.5 h-6 rounded-md text-2xs bg-accent/15 text-accent font-semibold hover:bg-accent/25 disabled:opacity-40 disabled:hover:bg-accent/15 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent transition-colors flex-shrink-0"
        >
          Send <CornerDownLeft size={9} className="opacity-60" />
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onDismiss}
          title="Let the assistant decide for itself"
          className="px-2.5 h-6 rounded-md text-2xs text-ink-muted font-semibold hover:bg-surface-hover hover:text-ink-high focus-visible:outline focus-visible:outline-1 focus-visible:outline-edge-popover transition-colors flex-shrink-0"
        >
          You decide
        </button>
      </div>
    </div>
  );
};
