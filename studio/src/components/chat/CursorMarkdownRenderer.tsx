import React, { useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { CodeSnippet } from "../ui/CodeSnippet";
import { tokenizeInline } from "../../services/markdown";

export interface CursorMarkdownRendererProps {
  content: string;
  isStreaming?: boolean;
  /** Denser type for user bubbles, roomier for assistant answers. */
  compact?: boolean;
}

type Block =
  | { kind: "code"; content: string; lang?: string }
  | { kind: "table"; headers: string[]; align: Array<"left" | "center" | "right">; rows: string[][] }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: Array<{ text: string; depth: number; checked?: boolean }> }
  | { kind: "quote"; lines: string[] }
  | { kind: "rule" }
  | { kind: "paragraph"; text: string };

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const TASK = /^\[( |x|X)\]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^\s*([-*_])\s*\1\s*\1[\s*\-_]*$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_DIVIDER = /^\s*\|?[\s:-]+\|[\s:|-]*$/;

function splitRow(line: string): string[] {
  return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());
}

function parseBlocks(raw: string): Block[] {
  const lines = raw.split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    const text = paragraph.join("\n").trim();
    if (text) blocks.push({ kind: "paragraph", text });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    // ── Fenced code ──
    if (line.trim().startsWith("```")) {
      flushParagraph();
      const lang = line.trim().slice(3).trim().split(/\s+/)[0] || undefined;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        body.push(lines[index]);
        index += 1;
      }
      blocks.push({ kind: "code", content: body.join("\n"), lang });
      continue;
    }

    // ── Table ──
    if (TABLE_ROW.test(line) && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1])) {
      flushParagraph();
      const headers = splitRow(line);
      const align = splitRow(lines[index + 1]).map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        return left && right ? "center" : right ? "right" : "left";
      }) as Array<"left" | "center" | "right">;
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && TABLE_ROW.test(lines[index])) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      index -= 1;
      blocks.push({ kind: "table", headers, align, rows });
      continue;
    }

    // ── Horizontal rule ──
    if (RULE.test(line)) {
      flushParagraph();
      blocks.push({ kind: "rule" });
      continue;
    }

    // ── Heading ──
    const heading = line.match(HEADING);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }

    // ── Blockquote (consecutive lines merge) ──
    if (QUOTE.test(line)) {
      flushParagraph();
      const quoted: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        quoted.push(lines[index].match(QUOTE)![1]);
        index += 1;
      }
      index -= 1;
      blocks.push({ kind: "quote", lines: quoted });
      continue;
    }

    // ── Lists (consecutive items of the same kind merge into one list) ──
    const bullet = line.match(BULLET);
    const ordered = line.match(ORDERED);
    if (bullet || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      const items: Array<{ text: string; depth: number; checked?: boolean }> = [];
      while (index < lines.length) {
        const current = lines[index];
        const asBullet = current.match(BULLET);
        const asOrdered = current.match(ORDERED);
        const entry = isOrdered ? asOrdered : asBullet;
        if (!entry) {
          // A wrapped continuation line belongs to the previous item.
          if (items.length > 0 && current.trim() && !asBullet && !asOrdered && /^\s{2,}\S/.test(current)) {
            items[items.length - 1].text += ` ${current.trim()}`;
            index += 1;
            continue;
          }
          break;
        }
        const depth = Math.min(4, Math.floor(entry[1].length / 2));
        let text = entry[3];
        let checked: boolean | undefined;
        const task = text.match(TASK);
        if (task) {
          checked = task[1].toLowerCase() === "x";
          text = task[2];
        }
        items.push({ text, depth, checked });
        index += 1;
      }
      index -= 1;
      blocks.push({ kind: "list", ordered: isOrdered, items });
      continue;
    }

    if (!line.trim()) flushParagraph();
    else paragraph.push(line);
  }

  flushParagraph();
  return blocks;
}

const Inline: React.FC<{ text: string }> = ({ text }) => (
  <>
    {tokenizeInline(text).map((token, index) => {
      switch (token.type) {
        case "code":
          return (
            <code key={index} className="mx-px px-1.5 py-0.5 rounded-md bg-accent-codeBg text-accent-code font-mono text-[0.92em]">
              {token.value}
            </code>
          );
        case "bold":
          return <strong key={index} className="font-semibold text-ink-bright">{token.value}</strong>;
        case "italic":
          return <em key={index} className="italic text-ink-high">{token.value}</em>;
        case "boldItalic":
          return <strong key={index} className="font-semibold italic text-ink-bright">{token.value}</strong>;
        case "strike":
          return <span key={index} className="line-through text-ink-placeholder">{token.value}</span>;
        case "link":
          return (
            <a
              key={index}
              href={token.href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-reason underline decoration-reason/40 underline-offset-2 hover:decoration-reason transition-colors"
            >
              {token.value}
            </a>
          );
        default:
          return <span key={index}>{token.value}</span>;
      }
    })}
  </>
);

export const CursorMarkdownRenderer: React.FC<CursorMarkdownRendererProps> = ({
  content,
  isStreaming = false,
  compact = false,
}) => {
  const [expandedDiagram, setExpandedDiagram] = useState(false);
  const blocks = parseBlocks(content);
  const lastCodeIndex = blocks.reduce((last, block, index) => (block.kind === "code" ? index : last), -1);
  const body = compact ? "text-xs" : "text-[13px]";

  const headingClass = (level: number) =>
    level <= 1
      ? "text-[15px] font-bold text-ink-bright tracking-tight mt-5 mb-2 pb-1.5 border-b border-edge"
      : level === 2
      ? "text-[14px] font-semibold text-ink-bright tracking-tight mt-4 mb-1.5"
      : level === 3
      ? "text-[13px] font-semibold text-ink-bright mt-3.5 mb-1"
      : "text-xs font-semibold text-ink-prose uppercase tracking-wider mt-3 mb-1";

  return (
    <div className={`markdown-body font-sans ${body} text-ink-prose leading-[1.7] space-y-2.5`}>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "code": {
            const isDiagram =
              block.lang === "diagram" ||
              block.lang === "architecture" ||
              block.content.includes("├──") ||
              block.content.includes("┌──");

            if (isDiagram) {
              return (
                <div key={index} className="lit lit-inner my-3 rounded-xl bg-frame-mid shadow-xl overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-edge-chrome bg-surface-chip/40">
                    <span className="text-2xs font-medium tracking-wide text-ink-prose">Architecture Diagram</span>
                    <button
                      onClick={() => setExpandedDiagram((previous) => !previous)}
                      className="p-1 rounded text-ink-muted hover:text-ink-high hover:bg-surface-chip transition-colors"
                      aria-label={expandedDiagram ? "Collapse diagram" : "Expand diagram"}
                    >
                      {expandedDiagram ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                    </button>
                  </div>
                  <pre className={`px-4 py-3 font-mono text-2xs text-ink-prose whitespace-pre overflow-x-auto leading-relaxed ${expandedDiagram ? "" : "max-h-72"}`}>
                    {block.content}
                  </pre>
                </div>
              );
            }
            return <CodeSnippet key={index} content={block.content} lang={block.lang} isStreaming={isStreaming && index === lastCodeIndex} />;
          }

          case "table":
            return (
              /* Cursor's table has no header fill and no shadow: a #262626
                 hairline round the outside, the same hairline between rows, and
                 the header set in the body face at full strength rather than as
                 uppercase mono chrome. The container is transparent — a tinted
                 fill here is what made this read as a widget dropped into the
                 reply instead of as part of it. */
              <div key={index} className="lit my-3 rounded-xl overflow-x-auto">
                <table className="w-full text-left border-collapse text-md">
                  <thead>
                    <tr className="border-b border-edge">
                      {block.headers.map((header, headerIndex) => (
                        <th
                          key={headerIndex}
                          scope="col"
                          className="px-3.5 py-2.5 font-semibold text-ink-bright whitespace-nowrap"
                          style={{ textAlign: block.align[headerIndex] || "left" }}
                        >
                          <Inline text={header} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-edge">
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex} className="hover:bg-surface-hover/40 transition-colors duration-ds ease-ds">
                        {row.map((cell, cellIndex) => (
                          <td
                            key={cellIndex}
                            className="px-3.5 py-2.5 text-ink-prose align-top"
                            style={{ textAlign: block.align[cellIndex] || "left" }}
                          >
                            <Inline text={cell} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );

          case "heading":
            // React.createElement keeps the tag dynamic without a JSX namespace cast.
            return React.createElement(
              `h${Math.min(6, block.level)}`,
              { key: index, className: headingClass(block.level) },
              <Inline text={block.text} />,
            );

          case "quote":
            return (
              <blockquote
                key={index}
                className="my-2.5 pl-3.5 py-1 border-l-2 border-edge-strong text-ink-prose italic"
              >
                {block.lines.map((line, lineIndex) => (
                  <p key={lineIndex} className="my-0.5"><Inline text={line} /></p>
                ))}
              </blockquote>
            );

          case "rule":
            return <hr key={index} className="my-4 border-0 h-px bg-edge" />;

          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag key={index} className="my-2 space-y-1">
                {block.items.map((item, itemIndex) => (
                  <li
                    key={itemIndex}
                    className="flex gap-2 text-ink-prose"
                    style={{ marginLeft: `${item.depth * 16}px` }}
                  >
                    {item.checked === undefined ? (
                      <span aria-hidden="true" className={`flex-shrink-0 select-none ${block.ordered ? "text-ink-placeholder font-mono text-2xs mt-[3px]" : "text-accent mt-[1px]"}`}>
                        {block.ordered ? `${itemIndex + 1}.` : "•"}
                      </span>
                    ) : (
                      <span
                        role="img"
                        aria-label={item.checked ? "completed" : "not completed"}
                        className={`flex-shrink-0 mt-[2px] w-3.5 h-3.5 rounded border grid place-items-center text-[9px] font-bold ${
                          item.checked
                            ? "bg-success/20 border-success/50 text-success"
                            : "border-edge-strong text-transparent"
                        }`}
                      >
                        ✓
                      </span>
                    )}
                    <span className={item.checked ? "line-through text-ink-placeholder" : ""}>
                      <Inline text={item.text} />
                    </span>
                  </li>
                ))}
              </Tag>
            );
          }

          default:
            return (
              <p key={index} className="leading-[1.7] text-ink-prose">
                <Inline text={block.text} />
              </p>
            );
        }
      })}
    </div>
  );
};
