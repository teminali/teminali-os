export class AgentRuntimeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "AgentRuntimeError";
    this.code = code;
    this.details = details;
  }
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new AgentRuntimeError("CANCELLED", "The agent run was cancelled.");
}
