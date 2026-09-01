import type { InferenceTelemetry } from "../types";

const TELEMETRY_EVENT = "frontier:inference-telemetry";

export class RuntimeTelemetryService {
  private static latest: InferenceTelemetry | null = null;

  public static record(telemetry: InferenceTelemetry): void {
    this.latest = telemetry;
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent<InferenceTelemetry>(TELEMETRY_EVENT, { detail: telemetry }));
    }
  }

  public static getLatest(): InferenceTelemetry | null {
    return this.latest;
  }

  public static subscribe(listener: (telemetry: InferenceTelemetry) => void): () => void {
    if (typeof window === "undefined") return () => undefined;
    const handler = (event: Event) => listener((event as CustomEvent<InferenceTelemetry>).detail);
    window.addEventListener(TELEMETRY_EVENT, handler);
    return () => window.removeEventListener(TELEMETRY_EVENT, handler);
  }
}
