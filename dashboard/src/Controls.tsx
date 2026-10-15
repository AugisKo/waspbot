// "Controls" in the header: switch the decision engine (rules or a model, and which model), the regime filter, each
// news source and each part of the knowledge layer, without a restart. Reading is public (GET /controls, /knowledge);
// every change, and resuming after the portfolio breaker, needs the owner password picked on Setup.
import { useCallback, useEffect, useState } from "react";
import type { ControlsState, KnowledgeState } from "./types";

type Patch = Partial<Omit<ControlsState["controls"], "news" | "knowledge">> & {
  news?: Partial<ControlsState["controls"]["news"]>;
  knowledge?: Partial<ControlsState["controls"]["knowledge"]>;
};

const PROVIDER_LABEL: Record<string, string> = { gemini: "Gemini", claude: "Claude", openai: "OpenAI", jev: "Jev" };
const NEWS_LABEL: Record<string, [string, string]> = {
  rss: ["RSS feeds", "CoinDesk, Cointelegraph, Decrypt, The Block. Free."],
  cryptopanic: ["CryptoPanic", "Aggregated news with votes. Needs CRYPTOPANIC_TOKEN."],
  websearch: ["Model web search", "The knowledge model searches the web hourly. Uses the knowledge budget."],
  okx: ["OKX sentiment", "OKX's own bullish/bearish ratio. Demo and live only."],
};
const KNOW_LABEL: Record<string, [string, string]> = {
  digest: ["News digest", "Reads the news per coin: may veto a long into an exploit, or shrink a trade against strong news."],
  calendar: ["Event calendar", "No new trades around high-impact events (data/events.json, EVENTS_ICS_URL)."],
  memory: ["Trade memory", "Shrinks a trade when similar past trades lost on average (needs 15+ of them)."],
  notes: ["Owner notes", "Your .md/.txt files in data/notes, read by the model with every decision."],
};

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60_000);
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}
function until(ts: number): string {
  const m = Math.round((ts - Date.now()) / 60_000);
  return m < 60 ? `in ${m}m` : m < 48 * 60 ? `in ${Math.round(m / 60)}h` : `in ${Math.round(m / 1440)}d`;
}

function Toggle({ on, disabled, onChange, label, hint }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <label className={`ctl-row ${disabled ? "off" : ""}`}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <b>{label}</b>
        <span className="dim small"> {hint}</span>
      </span>
    </label>
  );
}

function ControlsDialog({ onClose, halted }: { onClose: () => void; halted: string | null }) {
  const [state, setState] = useState<ControlsState | null>(null);
  const [know, setKnow] = useState<KnowledgeState | null>(null);
  const [draft, setDraft] = useState<ControlsState["controls"] | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(() => {
    void fetch("/controls", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<ControlsState>) : null))
      .then((s) => {
        if (!s) return;
        setState(s);
        setDraft((d) => d ?? s.controls);
      })
      .catch(() => undefined);
    void fetch("/knowledge", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<KnowledgeState>) : null))
      .then((k) => k && setKnow(k))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [load, onClose]);

  const post = async (path: string, body: unknown) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-owner-password": encodeURIComponent(password) }, body: JSON.stringify(body) });
      const j = (await r.json().catch(() => ({}))) as { error?: string; controls?: ControlsState["controls"] };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      if (j.controls) {
        setDraft(j.controls);
        setNote("Saved. The wasps use it from the next tick.");
      } else setNote("Resumed. The wasps may trade again.");
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const patch = (p: Patch) => setDraft((d) => (d ? { ...d, ...p, news: { ...d.news, ...(p.news ?? {}) }, knowledge: { ...d.knowledge, ...(p.knowledge ?? {}) } } : d));
  const changed = !!state && !!draft && JSON.stringify(state.controls) !== JSON.stringify(draft);
  const passwordOk = password.length >= 8;
  const providers = state ? (Object.keys(state.available) as Array<keyof ControlsState["available"]>).filter((p) => state.available[p]) : [];
  const conf = state?.newsConfigured;

  return (
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="ctl-title">
        <button className="modal-x" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h2 id="ctl-title">Controls</h2>
        {!state || !draft ? (
          <p className="dim">Loading…</p>
        ) : (
          <>
            {halted && (
              <div className="ctl-halt">
                <b>Portfolio halted:</b> {halted}
                <button disabled={busy || !passwordOk} onClick={() => void post("/controls/resume", {})}>
                  Resume trading
                </button>
              </div>
            )}

            <h3>Who decides</h3>
            <div className="ctl-seg" role="radiogroup" aria-label="Decision engine">
              <button className={draft.engine === "rules" ? "on" : ""} onClick={() => patch({ engine: "rules" })} role="radio" aria-checked={draft.engine === "rules"}>
                Rules engine
              </button>
              <button className={draft.engine === "llm" ? "on" : ""} disabled={!providers.length} onClick={() => patch({ engine: "llm" })} role="radio" aria-checked={draft.engine === "llm"} title={providers.length ? "" : "No model key is set on this server"}>
                Model
              </button>
            </div>
            <p className="dim small">
              {draft.engine === "rules"
                ? "Deterministic code picks every move. Free, and exactly what the backtester measures."
                : "A model picks among the moves the rules allow; the risk layer still decides. When the model is down or over its cap, the rules stand in."}
              {state.chooser ? ` Now: ${state.chooser.engine === "rules" ? "rules" : `${state.chooser.provider} · ${state.chooser.model}`}.` : ""}
            </p>
            {draft.engine === "llm" && providers.length > 0 && (
              <div className="ctl-seg small" role="radiogroup" aria-label="Model">
                {providers.map((p) => (
                  <button key={p} className={(draft.provider ?? state.chooser?.provider) === p ? "on" : ""} onClick={() => patch({ provider: p })} role="radio" aria-checked={draft.provider === p}>
                    {PROVIDER_LABEL[p]}
                  </button>
                ))}
              </div>
            )}

            <h3>Risk</h3>
            <Toggle on={draft.regimeFilter} onChange={(v) => patch({ regimeFilter: v })} label="Regime filter" hint="Trend and Momentum open only with a trend their way; Breakout stays out of choppy markets." />

            <h3>News sources</h3>
            {(Object.keys(NEWS_LABEL) as Array<keyof ControlsState["controls"]["news"]>).map((k) => (
              <Toggle key={k} on={draft.news[k]} disabled={conf ? !conf[k] : false} onChange={(v) => patch({ news: { [k]: v } })} label={`${NEWS_LABEL[k]![0]}${know?.counts[k] ? ` (${know.counts[k]} today)` : ""}`} hint={NEWS_LABEL[k]![1]} />
            ))}

            <h3>Knowledge</h3>
            {(Object.keys(KNOW_LABEL) as Array<keyof ControlsState["controls"]["knowledge"]>).map((k) => (
              <Toggle key={k} on={draft.knowledge[k]} onChange={(v) => patch({ knowledge: { [k]: v } })} label={KNOW_LABEL[k]![0]} hint={KNOW_LABEL[k]![1]} />
            ))}
            <p className="dim small">
              The knowledge layer can only veto or shrink a trade, never open one.{" "}
              {state.knowledgeModel ? `News is read by ${state.knowledgeModel.provider} · ${state.knowledgeModel.model}` : "No model key: news digests use keywords only"}
              {state.knowledgeBudget ? `, $${state.knowledgeBudget.spentTodayUsd.toFixed(3)} of $${state.knowledgeBudget.capUsd} today.` : "."}
            </p>

            {know && (
              <details className="ctl-know">
                <summary>What the wasps know right now</summary>
                {know.digests.length > 0 && (
                  <ul className="ctl-list">
                    {know.digests.map((d) => (
                      <li key={d.coin}>
                        <b>{d.coin}</b> <span className={d.sentiment > 0.15 ? "good" : d.sentiment < -0.15 ? "bad" : "dim"}>{d.sentiment >= 0 ? "+" : ""}{d.sentiment.toFixed(2)}</span>
                        <span className="dim"> conf {d.confidence.toFixed(1)} · {d.items} items · {d.by}</span>
                        {d.flags.length > 0 && <span className="bad"> ⚑ {d.flags.join(", ")}</span>}
                        {d.events.length > 0 && <span className="dim"> · {d.events.join("; ")}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {know.events.length > 0 && (
                  <ul className="ctl-list">
                    {know.events.slice(0, 6).map((e) => (
                      <li key={`${e.at}-${e.title}`}>
                        <span className={e.impact === "high" ? "bad" : "dim"}>{e.impact}</span> {e.title} <span className="dim">{until(e.at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="dim small">
                  Trade memory: {know.memory.trades} closed trades
                  {know.memory.byStyle.map((s) => ` · ${s.style} ${s.n} (win ${(s.winRate * 100).toFixed(0)}%, ${s.avgR >= 0 ? "+" : ""}${s.avgR.toFixed(2)}R)`).join("")}
                  {know.notes ? ` · owner notes ${know.notes} chars` : ""}
                </p>
                <ul className="ctl-list">
                  {know.news.slice(0, 10).map((n) => (
                    <li key={`${n.publishedAt}-${n.title}`}>
                      {n.url ? (
                        <a href={n.url} target="_blank" rel="noopener noreferrer">
                          {n.title}
                        </a>
                      ) : (
                        n.title
                      )}{" "}
                      <span className="dim">
                        {n.publisher} · {ago(n.publishedAt)}
                        {n.coins.length ? ` · ${n.coins.join(" ")}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {!state.ownerPasswordSet ? (
              <p className="bad">This server has no owner password, so nothing can be changed here. Run Setup again or set OWNER_PASSWORD.</p>
            ) : (
              <>
                <label className="modal-label" htmlFor="ctl-password">
                  Owner password
                </label>
                <input
                  id="ctl-password"
                  className="modal-input"
                  type="password"
                  autoComplete="current-password"
                  placeholder="The password you picked on Setup"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </>
            )}
            {error && <p className="bad">{error}</p>}
            {note && <p className="good">{note}</p>}
            <div className="modal-actions">
              <span className="dim small">Not financial advice.</span>
              <button disabled={busy || !passwordOk || !changed} onClick={() => void post("/controls", draft)}>
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function ControlsButton({ halted = null }: { halted?: string | null }) {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void fetch("/controls", { cache: "no-store" })
      .then((r) => setAvailable(r.ok))
      .catch(() => undefined);
  }, []);
  // Older engines have no /controls: no button.
  if (!available) return null;
  return (
    <>
      <button className={`hive-btn ${halted ? "alert" : ""}`} onClick={() => setOpen(true)}>
        ⚙ Controls
      </button>
      {open && <ControlsDialog onClose={() => setOpen(false)} halted={halted} />}
    </>
  );
}
