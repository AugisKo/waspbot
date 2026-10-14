// Backtest output: a console table, a JSON file with everything, and a self-contained HTML report (no scripts, no
// external files) with equity curves for every variant against buy-and-hold.
import type { BacktestResult } from "./run.js";
import type { Metrics, Point } from "./metrics.js";

const f = (x: number | null | undefined, d = 2, suffix = "") => (x === null || x === undefined || !Number.isFinite(x) ? "–" : `${x.toFixed(d)}${suffix}`);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function metricsRow(name: string, m: Metrics): string[] {
  return [name, f(m.totalReturnPct, 1, "%"), f(m.cagrPct, 1, "%"), f(m.sharpe), f(m.sortino), f(-m.maxDrawdownPct, 1, "%"), String(m.trades), f(m.winRatePct, 0, "%"), f(m.avgR), f(m.profitFactor), `$${f(m.feesUsd)}`, `$${f(m.fundingUsd)}`, f(m.exposurePct, 0, "%")];
}

export const HEAD = ["", "return", "CAGR", "Sharpe", "Sortino", "max DD", "trades", "win", "avg R", "PF", "fees", "funding", "in mkt"];

export function table(rows: string[][]): string {
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]!) : c.padStart(w[i]!))).join("  ")).join("\n");
}

export function consoleReport(results: BacktestResult[]): string {
  const r0 = results[0]!;
  const lines: string[] = [];
  lines.push(`WaspBot backtest  ${day(r0.from)} → ${day(r0.to)}  (${r0.portfolio.days.toFixed(0)} days)  coins: ${r0.coins.join(", ")}`);
  const rows: string[][] = [HEAD];
  for (const r of results) {
    rows.push(metricsRow(`${r.label} (all wasps)`, r.portfolio));
    for (const w of r.wasps) rows.push(metricsRow(`  ${w.name}`, w.metrics));
    if (r.split) {
      rows.push(metricsRow(`  in-sample → ${day(r.split.at)}`, r.split.inSample));
      rows.push(metricsRow(`  out-of-sample`, r.split.outOfSample));
    }
  }
  if (r0.baseline) rows.push(metricsRow(`buy & hold ${r0.baseline.coin}`, r0.baseline.metrics));
  lines.push(table(rows));
  for (const r of results) for (const n of r.notes) lines.push(`note (${r.label}): ${n}`);
  lines.push("Fills at bid/ask + slippage, taker fees, 8h funding. Stops are checked on 15m closes. No historical news. Not financial advice.");
  return lines.join("\n");
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function pathOf(curve: Point[], x0: number, x1: number, y0: number, y1: number, W: number, H: number): string {
  if (!curve.length) return "";
  const n = curve.length;
  const stride = Math.max(1, Math.floor(n / 600));
  const pts: string[] = [];
  for (let i = 0; i < n; i += stride) {
    const p = curve[i]!;
    pts.push(`${(((p.ts - x0) / (x1 - x0)) * W).toFixed(1)},${(H - ((p.equity - y0) / (y1 - y0)) * H).toFixed(1)}`);
  }
  const last = curve[n - 1]!;
  pts.push(`${W},${(H - ((last.equity - y0) / (y1 - y0)) * H).toFixed(1)}`);
  return `M${pts.join("L")}`;
}

export function htmlReport(results: BacktestResult[]): string {
  const r0 = results[0]!;
  const curves = [...results.map((r) => ({ name: r.label, c: r.curve })), ...(r0.baselineCurve.length ? [{ name: `buy & hold ${r0.baseline!.coin}`, c: r0.baselineCurve }] : [])];
  const all = curves.flatMap((x) => x.c.map((p) => p.equity));
  const y0 = Math.min(...all) * 0.98;
  const y1 = Math.max(...all) * 1.02;
  const W = 900;
  const H = 300;
  const colors = ["#c98a00", "#2f7de1", "#c4413a", "#2e9b5f", "#8b5cf6", "#777"];
  const lines = curves.map((x, i) => `<path d="${pathOf(x.c, r0.from, r0.to, y0, y1, W, H)}" fill="none" stroke="${i === curves.length - 1 && r0.baselineCurve.length ? "var(--muted)" : colors[i % colors.length]}" stroke-width="1.6"${i === curves.length - 1 && r0.baselineCurve.length ? ' stroke-dasharray="4 3"' : ""}/>`).join("");
  const legend = curves.map((x, i) => `<span class="lg"><i style="background:${i === curves.length - 1 && r0.baselineCurve.length ? "var(--muted)" : colors[i % colors.length]}"></i>${esc(x.name)}</span>`).join("");
  const rows: string[][] = [];
  for (const r of results) {
    rows.push(metricsRow(`${r.label} — all wasps`, r.portfolio));
    for (const w of r.wasps) rows.push(metricsRow(`↳ ${w.name}`, w.metrics));
    if (r.split) {
      rows.push(metricsRow(`↳ in-sample (to ${day(r.split.at)})`, r.split.inSample));
      rows.push(metricsRow(`↳ out-of-sample`, r.split.outOfSample));
    }
  }
  if (r0.baseline) rows.push(metricsRow(`buy & hold ${r0.baseline.coin}`, r0.baseline.metrics));
  const tableHtml = `<table><thead><tr>${HEAD.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i ? `<td>${esc(c)}</td>` : `<th scope="row">${esc(c)}</th>`)).join("")}</tr>`).join("")}</tbody></table>`;
  const notes = results.flatMap((r) => r.notes.map((n) => `<li>${esc(r.label)}: ${esc(n)}</li>`)).join("");
  const settings = results.map((r) => `<li><b>${esc(r.label)}</b>: engine ${esc(r.engine)}${Object.keys(r.settings).length ? `, ${esc(Object.entries(r.settings).map(([k, v]) => `${k}=${v}`).join(", "))}` : ""}; ${r.decisions} decisions, ${r.trades.length} trades</li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WaspBot backtest</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1b16;--muted:#8a8478;--line:#e6e1d6;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#14130f;--fg:#ece7dc;--muted:#8f887a;--line:#2b2922;--card:#1b1a15}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px 16px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px;overflow-x:auto}
svg{width:100%;height:auto;display:block}.lg{display:inline-flex;align-items:center;gap:6px;margin-right:16px;font-size:13px}.lg i{width:14px;height:3px;display:inline-block;border-radius:2px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:13px}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}th[scope=row],thead th:first-child{text-align:left;font-weight:500}thead th{color:var(--muted);font-weight:500}
ul{margin:0;padding-left:18px;color:var(--muted)}.axis{fill:var(--muted);font-size:11px}
</style></head><body><main>
<h1>WaspBot backtest</h1>
<p class="sub">${day(r0.from)} → ${day(r0.to)} · ${r0.portfolio.days.toFixed(0)} days · ${esc(r0.coins.join(", "))} · start $${r0.portfolio.startEquity.toFixed(0)}</p>
<div class="card"><svg viewBox="0 0 ${W} ${H + 20}" role="img" aria-label="Equity curves"><line x1="0" x2="${W}" y1="${H - ((r0.portfolio.startEquity - y0) / (y1 - y0)) * H}" y2="${H - ((r0.portfolio.startEquity - y0) / (y1 - y0)) * H}" stroke="var(--line)"/>${lines}<text class="axis" x="0" y="${H + 16}">${day(r0.from)}</text><text class="axis" x="${W}" y="${H + 16}" text-anchor="end">${day(r0.to)}</text><text class="axis" x="4" y="12">$${y1.toFixed(0)}</text><text class="axis" x="4" y="${H - 4}">$${y0.toFixed(0)}</text></svg><div>${legend}</div></div>
<div class="card">${tableHtml}</div>
<div class="card"><ul>${settings}${notes}<li>Fills at bid/ask plus slippage, taker fees on every fill, funding every 8 hours. Stops are checked on 15-minute closes, so a gap through a stop fills at the close. No historical news, so the news digest is off. Sharpe and Sortino use daily returns, annualised over 365 days.</li><li>A backtest is not a forecast, and good past results are often luck or overfitting. Compare out-of-sample to in-sample before trusting anything. Not financial advice.</li></ul></div>
</main></body></html>`;
}
