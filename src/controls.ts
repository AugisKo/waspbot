// Runtime controls the owner can switch from the dashboard without a restart: the decision engine (rules or a model,
// and which model), the regime filter, each news source and each part of the knowledge layer. Saved to
// data/controls.json (owner-only file). Defaults come from the environment; the file wins once saved.
// GET /controls is public (no secrets: which providers have a key is shown as true/false only).
// POST /controls and POST /controls/resume need the owner password.
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { z } from "zod";
import { readJson, send, type PasswordGate } from "./gate.js";
import { log } from "./log.js";
import { writePrivateJson } from "./settings.js";

export const PROVIDERS = ["gemini", "claude", "openai", "jev"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const ControlsSchema = z.object({
  engine: z.enum(["rules", "llm"]),
  /** null = the model picked at start (LLM_PROVIDER). */
  provider: z.enum(PROVIDERS).nullable(),
  regimeFilter: z.boolean(),
  news: z.object({ rss: z.boolean(), cryptopanic: z.boolean(), websearch: z.boolean(), okx: z.boolean() }),
  knowledge: z.object({ digest: z.boolean(), calendar: z.boolean(), memory: z.boolean(), notes: z.boolean() }),
});
export type Controls = z.infer<typeof ControlsSchema>;

/** A partial update from the dashboard. */
export const ControlsPatch = z
  .object({
    engine: ControlsSchema.shape.engine.optional(),
    provider: ControlsSchema.shape.provider.optional(),
    regimeFilter: z.boolean().optional(),
    news: ControlsSchema.shape.news.partial().optional(),
    knowledge: ControlsSchema.shape.knowledge.partial().optional(),
  })
  .strict();
export type ControlsPatchT = z.infer<typeof ControlsPatch>;

export const controlsPath = (settingsPath: string) => join(dirname(settingsPath), "controls.json");

export function mergeControls(c: Controls, p: ControlsPatchT): Controls {
  return {
    engine: p.engine ?? c.engine,
    provider: p.provider === undefined ? c.provider : p.provider,
    regimeFilter: p.regimeFilter ?? c.regimeFilter,
    news: { ...c.news, ...(p.news ?? {}) },
    knowledge: { ...c.knowledge, ...(p.knowledge ?? {}) },
  };
}

export class ControlsStore {
  private c: Controls;
  private listeners: Array<(c: Controls, prev: Controls) => void> = [];

  constructor(
    private path: string | null,
    defaults: Controls,
  ) {
    this.c = defaults;
    if (path && existsSync(path)) {
      try {
        // Fields added in later versions take their defaults; anything invalid falls back to the defaults whole.
        const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Controls>;
        const merged = ControlsSchema.safeParse(mergeControls(defaults, raw as ControlsPatchT));
        if (merged.success) this.c = merged.data;
        else log.warn("controls.json is not valid, using the defaults");
      } catch {
        log.warn("controls.json is not readable, using the defaults");
      }
    }
  }

  get(): Controls {
    return this.c;
  }

  onChange(fn: (c: Controls, prev: Controls) => void): void {
    this.listeners.push(fn);
  }

  update(p: ControlsPatchT): Controls {
    const prev = this.c;
    this.c = ControlsSchema.parse(mergeControls(this.c, p));
    if (this.path) writePrivateJson(this.path, this.c);
    for (const fn of this.listeners) fn(this.c, prev);
    return this.c;
  }
}

export interface ControlsHttpDeps {
  store: ControlsStore;
  gate: PasswordGate;
  /** Which providers have a key (true/false only, never the key). */
  available: () => Record<ProviderId, boolean>;
  /** Extra read-only state for the panel (news counts, knowledge budget, portfolio halt). */
  status: () => Record<string, unknown>;
  /** Clear a tripped portfolio breaker. Returns false when nothing was halted. */
  resume: () => boolean;
}

/** /controls routes. Returns false when the path is not one of them. */
export async function handleControls(req: IncomingMessage, res: ServerResponse, path: string, d: ControlsHttpDeps): Promise<boolean> {
  if (path === "/controls" && req.method === "GET") {
    send(res, 200, { controls: d.store.get(), available: d.available(), ownerPasswordSet: d.gate.set, ...d.status() });
    return true;
  }
  if ((path === "/controls" || path === "/controls/resume") && req.method === "POST") {
    const g = d.gate.check(req);
    if (g === "locked") return send(res, 429, { error: "too many wrong passwords: try again in 15 minutes" }), true;
    if (g === "unset") return send(res, 403, { error: "no owner password is set (run Setup again, or set OWNER_PASSWORD)" }), true;
    if (g === "bad") return send(res, 401, { error: "wrong owner password" }), true;
    if (path === "/controls/resume") {
      const ok = d.resume();
      send(res, ok ? 200 : 409, ok ? { ok: true } : { error: "the portfolio is not halted" });
      return true;
    }
    const body = await readJson(req, 4096).catch(() => null);
    const p = ControlsPatch.safeParse(body);
    if (!p.success) return send(res, 400, { error: `invalid controls: ${p.error.issues.map((i) => i.path.join(".") || i.message).join(", ")}` }), true;
    if (p.data.provider && !d.available()[p.data.provider]) return send(res, 400, { error: `no key is set for ${p.data.provider}` }), true;
    const c = d.store.update(p.data);
    log.info("controls changed from the dashboard", { engine: c.engine, provider: c.provider, regimeFilter: c.regimeFilter });
    send(res, 200, { controls: c });
    return true;
  }
  return false;
}
