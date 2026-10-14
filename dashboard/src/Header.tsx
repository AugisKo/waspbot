import { useEffect, useState } from "react";
import { money, signed } from "./BeeColumn";
import { ControlsButton } from "./Controls";
import { HiveButton } from "./Hive";
import { chooserShort, fallbackText, PROFILE, type Snapshot } from "./types";

function Clock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="num">{new Date(now).toISOString().slice(11, 19)} UTC</span>;
}

function Recon({ recon, mode }: { recon: Snapshot["recon"] | undefined; mode: Snapshot["mode"] | undefined }) {
  const state = !recon || recon.ok === null ? "idle" : recon.ok ? "ok" : "bad";
  const text =
    state === "ok" ? "books match OKX to the cent" : state === "bad" ? recon!.detail : mode === "dry" ? "paper trading: simulated books" : "first check pending";
  return (
    <div className={`recon recon-${state}`} title={recon?.detail}>
      <span className="recon-light" aria-hidden />
      <div>
        <div className="eyebrow">Reconciliation</div>
        <div className="recon-text">{state === "ok" ? "✓ " : state === "bad" ? "✗ " : ""}{text}</div>
      </div>
    </div>
  );
}

function Counter({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="counter">
      <div className="eyebrow">{label}</div>
      <div className={`counter-value num ${tone ?? ""}`}>{value}</div>
      {sub && <div className="counter-sub num">{sub}</div>}
    </div>
  );
}

export function Header({ snap, connected, stalled, soundOn, onSound }: { snap: Snapshot | null; connected: boolean; stalled: boolean; soundOn: boolean; onSound: () => void }) {
  const day = snap?.startedAt ? Math.floor((Date.now() - snap.startedAt) / 86_400_000) + 1 : 1;
  const t = snap?.totals;
  const jev = snap?.jev;
  const who = chooserShort(snap);
  const onRules = jev?.engine === "rules";
  const onCode = jev?.provider === "code" || onRules;
  const pf = snap?.portfolio;
  // The configured chooser is not proof of who decided: say so whenever the code chooser has been standing in.
  const recentFallback = jev?.lastFallback && snap && snap.ts - jev.lastFallback.at < 15 * 60_000 ? jev.lastFallback : null;
  const standIn = !onCode && (jev?.down || jev?.capTripped || jev?.budgetRefused || !!recentFallback);
  const orders = snap?.bees.reduce((a, b) => a + b.totals.orders, 0) ?? 0;
  const decisions = snap?.bees.reduce((a, b) => a + b.totals.decisions, 0) ?? 0;
  const live = connected && !stalled;
  return (
    <header className="top">
      <div className="brand">
        <div className="brand-row">
          <div className="logo">waspbot</div>
          <ControlsButton halted={pf?.halted?.reason ?? null} />
          <HiveButton />
        </div>
        <div className="brand-sub">
          <span className={`mode mode-${snap?.mode ?? "dry"}`}>{snap?.mode === "live" ? "● LIVE MONEY" : snap?.mode === "demo" ? "OKX DEMO" : "PAPER TRADING"}{snap?.closed ? (snap.closed.flat ? " · ENDED" : " · CLOSING") : ""}</span>
          {snap?.update ? (
            <a className="update-pill" href={`${PROFILE.links?.code || "https://github.com/AugisKo/waspbot"}/releases/latest`} target="_blank" rel="noopener" title={`You run ${snap.update.current}. See what's new and how to update.`}>
              Update available: {snap.update.latest} ↗
            </a>
          ) : null}
          <span className="dim">
            day {day} · 3 wasps · OKX X-Perps · not financial advice
          </span>
          {onRules ? (
            <span className="powered" title="The rules engine decides: deterministic code, no model, nothing spent. Switch it in Controls.">
              <span>
                Decided by <b>the rules engine</b>
              </span>
            </span>
          ) : jev?.provider && jev.provider !== "code" ? (
            <span className="powered" title={`The configured chooser is ${jev.fullName ?? who}. Each call in the decision stream says who made it: CODE marks the code chooser standing in.`}>
              {jev.provider === "gemini" && <img src="/gemini.svg" alt="" width="16" height="16" />}
              <span>
                Decided by <b>{jev.fullName ?? who}</b>
                {standIn ? " · code standing in" : ""}
              </span>
            </span>
          ) : null}
          {pf?.halted && <span className="mode mode-live" title={pf.halted.reason}>PORTFOLIO HALTED</span>}
        </div>
      </div>

      <div className="counters">
        <Counter label="Total P&L" value={t ? signed(t.pnlUsd) : "–"} tone={t ? (t.pnlUsd >= 0 ? "good" : "bad") : undefined} sub={`${orders} orders`} />
        <Counter label="Fees paid" value={t ? money(t.feesUsd) : "–"} sub="taker 0.05%" />
        <Counter label="Funding" value={t ? signed(t.fundingUsd) : "–"} sub="00 · 08 · 16 UTC" />
        <Counter
          label={`${who} spend`}
          value={t ? money(t.jevUsd, 4) : "–"}
          sub={jev ? `today ${money(jev.spentTodayUsd, 3)} of ${money(jev.dailyCapUsd, 0)} cap` : undefined}
        />
        <Counter
          label="Decisions"
          value={decisions.toLocaleString()}
          sub={
            onRules
              ? "rules engine: code decides"
              : onCode
              ? "no model key: code decides"
              : jev?.down
                ? `${who} offline: code decides`
                : jev?.capTripped
                  ? `${who} cap hit: code decides`
                  : jev?.budgetRefused
                    ? `${who} near its cap: code may decide`
                    : recentFallback
                      ? `code stood in: ${fallbackText(recentFallback.reason, who)}`
                      : "every one recorded"
          }
          tone={standIn ? "bad" : undefined}
        />
        <Counter
          label="Net exposure"
          value={pf ? signed(pf.netUsd) : "–"}
          sub={pf ? `limit ±${money(pf.netLimitUsd, 0)} · peak ${money(pf.peakUsd, 0)}` : undefined}
          tone={pf?.halted ? "bad" : undefined}
        />
        <Counter label="Visitors" value={snap?.visitors ? snap.visitors.total.toLocaleString() : "–"} sub={snap?.visitors ? `${snap.visitors.watching} watching now` : undefined} />
        {PROFILE.links?.code ? (
          <a className="counter host" href={PROFILE.links.code} target="_blank" rel="noopener">
            <div className="eyebrow">Open source</div>
            <div className="host-row">
              <span>Get the code</span>
            </div>
            <div className="counter-sub">MIT licence ↗</div>
          </a>
        ) : null}
      </div>

      <div className="top-right">
        <Recon recon={snap?.recon} mode={snap?.mode} />
        <div className="conn">
          <span className={`conn-dot ${live ? "on" : "off"}`} />
          <span>{live ? "live" : connected ? "stalled" : "reconnecting"}</span>
          <Clock />
          <button className={`sound ${soundOn ? "on" : ""}`} onClick={onSound} aria-pressed={soundOn}>
            {soundOn ? "🔊" : "🔇"}
          </button>
        </div>
      </div>
    </header>
  );
}
