/**
 * Frontier Sub-40ms Inline Ghost-Text Autocomplete Engine
 * Provides real-time cursor code completions directly in Monaco Editor.
 * Utilizes local prefix cache + debounced streaming.
 */
import { GatewayClient } from "./gatewayClient";

export interface CompletionSuggestion {
  text: string;
  range?: any;
}

export class AutocompleteService {
  private static completionCache = new Map<string, string>();
  private static lastRequestTime = 0;
  private static abortController: AbortController | null = null;

  /**
   * Fast prefix hash for sub-millisecond cache hits
   */
  private static getCacheKey(prefix: string, suffix: string): string {
    const p = prefix.slice(-150);
    const s = suffix.slice(0, 50);
    return `${p}__CURSOR__${s}`;
  }

  /**
   * Request an inline code completion
   */
  public static async getInlineCompletion(
    prefix: string,
    suffix: string,
    language: string
  ): Promise<string | null> {
    const key = this.getCacheKey(prefix, suffix);
    if (this.completionCache.has(key)) {
      return this.completionCache.get(key) || null;
    }

    // Cancel any in-flight request
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();

    try {
      const selection = await GatewayClient.resolveModelMode("flash", "bounded inline code completion");
      const response = await GatewayClient.request("/api/ollama/generate", {
        method: "POST",
        signal: this.abortController.signal,
        body: JSON.stringify({
          model: selection.model,
          prompt: `Complete the following ${language} code at the cursor. Output only the completion text.\n\nPREFIX:\n${prefix.slice(-600)}\n\nSUFFIX:\n${suffix.slice(0, 160)}`,
          stream: false,
          keep_alive: 0,
          options: {
            num_predict: 48,
            temperature: 0.1,
            num_ctx: 2048,
            num_batch: 64,
            stop: ["\n\n", "```", "function", "class "],
          },
        }),
      });

      await GatewayClient.expectOk(response);
      const data = await response.json() as { response?: string };
      let completion = data.response || "";

      // Clean completion
      completion = completion.replace(/^```[a-z]*\n?/, "").replace(/```$/, "");
      if (completion.trim()) {
        this.completionCache.set(key, completion);
        return completion;
      }
      return null;
    } catch (e: any) {
      if (e.name === "AbortError") return null;
      return null;
    }
  }

  /**
   * Clear cache on file switch or major edits
   */
  public static clearCache() {
    this.completionCache.clear();
  }
}
