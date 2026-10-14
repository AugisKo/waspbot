// The knowledge layer's model client: one provider (Claude, Gemini or OpenAI, whichever is configured), a hard daily
// budget, and JSON answers. Used for news digests and web search; never for trading decisions (jev.ts does those).
import { log } from "../log.js";
import { redactString, safeError } from "../redact.js";
import { callLlm, chargedUsd, LlmHttpError, requestBody, worstCaseUsd, type LlmPrices, type LlmProvider, type LlmRequest } from "./adapters.js";
import type { DailyBudget } from "./budget.js";

export interface KnowledgeLlmOpts {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  timeoutMs: number;
  prices: LlmPrices;
  budget: DailyBudget;
  fetchFn?: typeof fetch;
}

export type LlmJsonResult<T> = { ok: true; value: T; costUsd: number } | { ok: false; reason: "budget" | "error" | "bad_json"; costUsd: number };

export class KnowledgeLlm {
  constructor(private o: KnowledgeLlmOpts) {}

  get provider(): LlmProvider {
    return this.o.provider;
  }

  get spentTodayUsd(): number {
    return this.o.budget.spentTodayUsd;
  }

  /** One JSON call under the daily budget. Never throws. */
  async json<T>(req: Omit<LlmRequest, "prompt"> & { prompt: string; maxSearches?: number }, validate: (v: unknown) => T | null): Promise<LlmJsonResult<T>> {
    const { maxSearches = 0, ...r } = req;
    const full: LlmRequest = { ...r, prompt: redactString(r.prompt) };
    const body = requestBody(this.o.provider, this.o.model, full);
    const worst = worstCaseUsd(body, full.maxOutputTokens, this.o.prices, full.webSearch ? maxSearches : 0);
    if (!this.o.budget.reserve(worst)) return { ok: false, reason: "budget", costUsd: 0 };
    let charged = worst;
    try {
      const { res } = await callLlm({ provider: this.o.provider, apiKey: this.o.apiKey, model: this.o.model, timeoutMs: this.o.timeoutMs, fetchFn: this.o.fetchFn }, full);
      charged = chargedUsd(res, body, full.maxOutputTokens, this.o.prices, full.webSearch ? maxSearches : 0);
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.text.trim());
      } catch {
        return { ok: false, reason: "bad_json", costUsd: charged };
      }
      const v = validate(parsed);
      return v === null ? { ok: false, reason: "bad_json", costUsd: charged } : { ok: true, value: v, costUsd: charged };
    } catch (err) {
      if (err instanceof LlmHttpError) log.warn("knowledge model call failed", { provider: this.o.provider, status: err.status });
      else log.warn("knowledge model call failed", { provider: this.o.provider, err: safeError(err) });
      return { ok: false, reason: "error", costUsd: charged };
    } finally {
      this.o.budget.settle(worst, charged);
    }
  }
}
