import React, { useEffect, useRef, useState } from "react";
import { AIService } from "../../../services/aiService";
import { useStudioStore, PROFILES_LIST } from "../../../store/studioStore";
import { usePanelStore, type PanelTab } from "../../../store/panelStore";
import { useAttachments } from "../../../hooks/useAttachments";
import { useVoice } from "../../../hooks/useVoice";
import { composePrompt } from "../../../services/fileService";
import { MessageBlock } from "../../chat/MessageBlock";
import { Composer } from "../../chat/Composer";
import { EmptyState } from "../../ui";
import type { ChatMessage } from "../../../types";

/**
 * A side chat — a scratch conversation that does not touch the main thread.
 *
 * It renders with the *same* components as the main conversation: the same
 * message block, the same composer, the same checklist, the same attachment
 * intake. The only differences are density and width, passed as props. That is
 * deliberate — two chat implementations would drift, and every improvement to
 * the main thread would have to be made twice and would eventually be made
 * once.
 *
 * Its history stays in the panel's own state and is not persisted: the point of
 * a side chat is to ask something without it becoming part of the record.
 */

export const SideChatPane: React.FC<{ panel: PanelTab }> = ({ panel }) => {
  const currentProfile = useStudioStore((state) => state.currentProfile);
  const openPanel = usePanelStore((state) => state.open);
  const focusOrOpen = usePanelStore((state) => state.focusOrOpen);
  const openFileAtSnippet = useStudioStore((state) => state.openFileAtSnippet);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const attachments = useAttachments();

  const profile = PROFILES_LIST.find((entry) => entry.id === currentProfile) ?? PROFILES_LIST[1];

  // A side chat has no hands-free mode of its own — one microphone, one
  // conversation. Dictation into the field still works.
  const voice = useVoice({
    submit: (text) => void send(text),
    lastAssistantText: () => messages.filter((m) => m.role === "assistant").at(-1)?.content ?? "",
    isBusy: () => streaming,
  });

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const patchLast = (patch: Partial<ChatMessage>) =>
    setMessages((previous) =>
      previous.map((message, index) => (index === previous.length - 1 ? { ...message, ...patch } : message)),
    );

  const send = async (override?: string) => {
    const typed = (override ?? input).trim();
    const ready = attachments.attachments.filter((entry) => entry.status === "ready");
    if ((!typed && ready.length === 0) || streaming || attachments.busy) return;

    const { prompt, images } = composePrompt(typed, attachments.attachments);
    const history = [...messages];
    const stamp = new Date().toISOString();

    setMessages([
      ...history,
      { id: `side-${Date.now()}`, role: "user", content: typed || ready.map((r) => r.name).join(", "), timestamp: stamp, images },
      { id: `side-${Date.now()}-reply`, role: "assistant", content: "", timestamp: stamp, isStreaming: true },
    ]);
    setInput("");
    attachments.clear();
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;
    let accumulated = "";

    await AIService.streamMessage(
      "frontier",
      prompt,
      history,
      {
        onToken: (token) => {
          accumulated += token;
          patchLast({ content: accumulated, isStreaming: true });
        },
        onToolCall: (call) => {
          setMessages((previous) =>
            previous.map((message, index) => {
              if (index !== previous.length - 1) return message;
              const existing = message.toolCalls ?? [];
              const at = existing.findIndex((entry) => entry.id === call.id);
              return {
                ...message,
                toolCalls: at >= 0 ? existing.map((e, i) => (i === at ? call : e)) : [...existing, call],
              };
            }),
          );
        },
        onComplete: (data) => {
          patchLast({ content: data.fullText, isStreaming: false, tokensCount: data.tokensCount, costLabel: data.costLabel });
          setStreaming(false);
        },
        onError: (failure) => {
          patchLast({ content: `Error: ${failure.message}`, isStreaming: false });
          setStreaming(false);
        },
      },
      images,
      { mode: currentProfile, signal: controller.signal },
    );
  };

  const stop = () => {
    abortRef.current?.abort();
    setStreaming(false);
    patchLast({ isStreaming: false });
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto flex flex-col px-4 py-4">
        {messages.length === 0 ? (
          <EmptyState title={panel.label} detail="A scratch conversation. Nothing here reaches the main thread." />
        ) : (
          <div className="flex flex-col flex-shrink-0">
            {messages.map((message, index) => (
              <MessageBlock
                key={message.id}
                message={message}
                previousRole={index > 0 ? messages[index - 1].role : null}
                density="compact"
                onStop={stop}
                onRetry={
                  message.role === "assistant" && index > 0
                    ? () => void send(messages[index - 1].content)
                    : undefined
                }
                onJumpToFile={(filePath, code) => {
                  void openFileAtSnippet(filePath, code);
                  focusOrOpen({ kind: "file", path: filePath, label: filePath.split("/").pop() });
                }}
                onRun={() => openPanel({ kind: "terminal" })}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex-shrink-0 px-3 pb-4">
        <Composer
          value={input}
          onChange={setInput}
          onSubmit={() => void send()}
          onStop={stop}
          streaming={streaming}
          placeholder="Ask in side chat"
          modelName={profile.name}
          voice={voice}
          attachments={attachments}
          width="fill"
        />
      </div>
    </div>
  );
};
