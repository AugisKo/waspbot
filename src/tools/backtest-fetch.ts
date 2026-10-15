// pnpm backtest:fetch -- --coins BTC,ETH,SOL [--days 120] [--swap] [--data data/backtest/history]
// Downloads 15-minute candles and funding history from OKX's public API (no key) into one JSON file per coin.
// Default: the coin's EEA X-Perp on eea.okx.com (what the wasps trade). X-Perps are young, so their history is short;
// --swap reads the global USDT perpetual (<COIN>-USDT-SWAP on www.okx.com) instead, for longer tests. Prices of the two
// track each other closely, but fees, funding and liquidity differ: say which one a result came from.
import { saveHistory, type CoinHistory, type Row } from "../backtest/data.js";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "true";
}

const coins = (arg("coins", "BTC,ETH,SOL") ?? "").split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
const days = Number(arg("days", "120"));
const swap = arg("swap") === "true";
const base = (arg("api") ?? (swap ? "https://www.okx.com" : "https://eea.okx.com")).replace(/\/+$/, "");
const dir = arg("data", "./data/backtest/history")!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "fetch failed" says nothing: name the real network error (DNS, refused, TLS, timeout) and the host. */
function netError(err: unknown, url: string): Error {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const host = new URL(url).host;
  const why = e.cause?.code ?? e.cause?.message ?? (e.name === "TimeoutError" ? "timeout after 20 s" : e.message ?? String(err));
  const hint =
    /ENOTFOUND|EAI_AGAIN/.test(why) ? "the name could not be looked up (no internet, or DNS blocked)"
    : /ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout|UND_ERR_CONNECT/.test(why) ? "the connection was blocked or timed out (firewall, proxy, VPN or a regional block)"
    : /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(why) ? "a certificate problem (often a corporate proxy that inspects HTTPS)"
    : "";
  return new Error(`cannot reach ${host}: ${why}${hint ? ` — ${hint}` : ""}`);
}

async function get<T>(path: string, q: Record<string, string>): Promise<T> {
  const url = `${base}${path}?${new URLSearchParams(q)}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw netError(err, url);
    }
    if (res.status === 429) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    const j = (await res.json()) as { code?: string; msg?: string; data?: T };
    if (j.code !== "0") throw new Error(`${path}: ${j.code} ${j.msg ?? ""}`.trim());
    return j.data as T;
  }
  throw new Error(`${path}: rate limited`);
}

async function instIdFor(coin: string): Promise<string> {
  if (swap) return `${coin}-USDT-SWAP`;
  const rows = await get<Array<{ instId: string; state: string }>>("/api/v5/public/instruments", { instType: "FUTURES" });
  const hit = rows.find((r) => r.instId.startsWith(`${coin}-`) && r.instId.includes("_UM_XPERP-") && r.state === "live");
  if (!hit) throw new Error(`no live X-Perp for ${coin} on ${base} (try --swap)`);
  return hit.instId;
}

async function fetchCoin(coin: string): Promise<CoinHistory> {
  const instId = await instIdFor(coin);
  const since = Date.now() - days * 86_400_000;
  const rows: Row[] = [];
  let after = "";
  for (;;) {
    const data = await get<string[][]>("/api/v5/market/history-candles", { instId, bar: "15m", limit: "100", ...(after ? { after } : {}) });
    if (!data.length) break;
    for (const r of data) if (r[8] === "1") rows.push([Number(r[0]), Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4]), Number(r[7])]);
    const oldest = Number(data[data.length - 1]![0]);
    process.stderr.write(`\r${coin}: ${new Date(oldest).toISOString().slice(0, 10)}  ${rows.length} bars   `);
    if (oldest <= since) break;
    after = String(oldest);
    await sleep(110);
  }
  const funding: Array<[number, number]> = [];
  after = "";
  for (let page = 0; page < 30; page++) {
    let data: Array<{ fundingTime: string; realizedRate?: string; fundingRate?: string }>;
    try {
      data = await get("/api/v5/public/funding-rate-history", { instId, limit: "100", ...(after ? { after } : {}) });
    } catch {
      break; // some instruments have no funding history endpoint: the default rate is used
    }
    if (!data.length) break;
    for (const d of data) funding.push([Number(d.fundingTime), Number(d.realizedRate ?? d.fundingRate)]);
    const oldest = Number(data[data.length - 1]!.fundingTime);
    if (oldest <= since) break;
    after = String(oldest);
    await sleep(250);
  }
  process.stderr.write("\n");
  const seen = new Set<number>();
  const candles = rows.filter((r) => r[0] >= since && !seen.has(r[0]) && (seen.add(r[0]), true)).sort((x, y) => x[0] - y[0]);
  return { coin, source: `${instId} @ ${base}`, candles, funding: funding.filter((f) => f[0] >= since && Number.isFinite(f[1])).sort((x, y) => x[0] - y[0]) };
}

for (const coin of coins) {
  try {
    const h = await fetchCoin(coin);
    saveHistory(dir, h);
    const span = h.candles.length ? `${new Date(h.candles[0]![0]).toISOString().slice(0, 10)} → ${new Date(h.candles[h.candles.length - 1]![0]).toISOString().slice(0, 10)}` : "no bars";
    process.stdout.write(`${coin}: ${h.candles.length} bars (${span}), ${h.funding.length} funding rates, from ${h.source}\n`);
  } catch (err) {
    process.stdout.write(`${coin}: failed: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}
