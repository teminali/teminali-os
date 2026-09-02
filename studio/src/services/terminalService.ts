import { GatewayClient } from "./gatewayClient";

export interface TerminalOutputChunk {
  type: "stdout" | "stderr";
  data: string;
}

export interface TerminalExitEvent {
  type: "exit";
  code: number | null;
  signal: string | null;
  truncated: boolean;
  reason: "timeout" | "output_limit" | "cancelled" | string | null;
  durationMs: number;
  bytes: number;
}

type TerminalEvent = TerminalOutputChunk | TerminalExitEvent;

export interface RunCommandOptions {
  cwd?: string;
  signal?: AbortSignal;
  onOutput?: (chunk: TerminalOutputChunk) => void;
}

export class TerminalService {
  /**
   * Executes one command in the workspace and streams stdout/stderr as it arrives.
   * Resolves with the real exit status; it never reports success for a command
   * that did not run.
   */
  static async run(command: string, options: RunCommandOptions = {}): Promise<TerminalExitEvent> {
    const response = await GatewayClient.request("/api/terminal/exec", {
      method: "POST",
      signal: options.signal,
      body: JSON.stringify({ command, ...(options.cwd ? { cwd: options.cwd } : {}) }),
    });
    await GatewayClient.expectOk(response);
    if (!response.body) throw new Error("The gateway returned no terminal stream.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let exit: TerminalExitEvent | null = null;

    const consume = (line: string) => {
      if (!line.trim()) return;
      let event: TerminalEvent;
      try {
        event = JSON.parse(line) as TerminalEvent;
      } catch {
        return;
      }
      if (event.type === "exit") exit = event;
      else options.onOutput?.(event);
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) consume(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);

    if (!exit) throw new Error("The command stream ended before an exit status was reported.");
    return exit;
  }
}
