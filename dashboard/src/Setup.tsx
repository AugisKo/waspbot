// First-run Setup: shown instead of the dashboard until the engine is set up. It starts with the one-time setup code
// from the engine's log (so whoever reaches a fresh server first cannot take it), closes for good once saved, and times
// out after SETUP_WINDOW_MIN. The owner picks an owner password here for the dashboard's controls. Keys go straight to
// the engine. Each wasp is designed from one sentence (OpenAI invents its name, rules, coins and look; the engine
// checks them), then painted.
import { useEffect, useState } from "react";
import { BEE_MARK_URL } from "./BeeMark";

interface StyleInfo {
  id: string;
  label: string;
  blurb: string;
  name: string;
  tagline: string;
}
interface Status {
  needed: boolean;
  timedOut: boolean;
  closesAt: number;
  secure: boolean;
  serverHasOpenAiKey: boolean;
  styles: StyleInfo[];
  codeRequired?: boolean;
  codeLocked?: boolean;
}
interface Design {
  name: string;
  tagline: string;
  rules: string;
  coins: string[];
  baseStyle: string;
  styleLabel: string;
  look: string;
  /** Why the bee runs on a different brain than the one it was designed for. */
  styleNote?: string;
}
interface BeeDraft {
  /** What the owner typed: "How do you want this bee to trade?" */
  ask: string;
  /** The designed bee (null until "Create my bee"). The name and tagline stay editable. */
  design: Design | null;
  img: string | null;
  busy: "" | "design" | "paint";
  error: string;
}

const EXAMPLES = [
  "a patient wasp that only trades BTC and ETH trends",
  "a wasp that only buys solana dips",
  "a meme-coin hunter that chases whatever is pumping",
];

/** Same rule as the engine: the built-in wasps' names (and obvious spellings) are theirs. */
const squash = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .replace(/(wasp|bee)$/, "")
    .replace(/(.)\1+/g, "$1")
    .replace(/(ie|ey|i)$/, "y");
const RESERVED = new Set(["jacket", "vespa", "hornet"].map(squash));
const nameProblem = (name: string): string | null =>
  !/^[\p{L}\p{N} .'_-]{1,24}$/u.test(name.trim())
    ? "Names are 1-24 letters, numbers, spaces and . ' _ -"
    : RESERVED.has(squash(name))
      ? "Jacket, Vespa and Hornet are the built-in wasps. Pick another name."
      : null;

const STEPS = ["Setup code", "The rules", "Password", "Decisions", "OpenAI", "Your wasps", "Start"] as const;

class TimedOut extends Error {}

/** The setup code typed on the first step; every write carries it. */
let SETUP_CODE = "";

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`/setup/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-setup-code": SETUP_CODE },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (r.status === 410) throw new TimedOut(j.error ?? "Setup timed out.");
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

export function Setup() {
  const [status, setStatus] = useState<Status | null>(null);
  const [step, setStep] = useState(0);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [timedOut, setTimedOut] = useState(false);
  const [accept, setAccept] = useState({ notAdvice: false, paperDefault: false, ownRisk: false });
  const [code, setCode] = useState("");
  // The decision engine: the rules (no key), or a model: Claude, Gemini or Jev.
  const [chooser, setChooser] = useState<"rules" | "claude" | "gemini" | "jev">("rules");
  const [modelKey, setModelKey] = useState("");
  const [keyOk, setKeyOk] = useState(false);
  const [openaiKey, setOpenaiKey] = useState("");
  const [openaiOk, setOpenaiOk] = useState(false);
  const [bees, setBees] = useState<BeeDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    void fetch("/setup/status", { cache: "no-store" })
      .then((r) => r.json() as Promise<Status>)
      .then((s) => {
        setStatus(s);
        if (s.codeRequired === false) setStep(1);
        setBees([0, 1, 2].map(() => ({ ask: "", design: null, img: null, busy: "", error: "" })));
      })
      .catch(() => setError("Can't reach the engine. Give it a few seconds, then reload."));
  }, []);

  // After saving, the engine restarts. Wait for it to come back set up, then load the dashboard.
  useEffect(() => {
    if (!done) return;
    const t = setInterval(() => {
      void fetch("/profile", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((p: { setup?: boolean } | null) => {
          if (p && p.setup === false) location.reload();
        })
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(t);
  }, [done]);

  const hasOpenAi = openaiOk || !!status?.serverHasOpenAiKey;
  const oaBody = openaiKey ? { openaiKey } : {};

  /** The message for an error; a timed-out Setup switches the whole page to the restart hint. */
  const fail = (e: unknown) => {
    if (e instanceof TimedOut) setTimedOut(true);
    return (e as Error).message;
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(fail(e));
    } finally {
      setBusy(false);
    }
  };

  const patch = (i: number, p: Partial<BeeDraft>) => setBees((bs) => bs.map((b, j) => (j === i ? { ...b, ...p } : b)));

  const patchDesign = (i: number, p: Partial<Design>) => setBees((bs) => bs.map((b, j) => (j === i && b.design ? { ...b, design: { ...b.design, ...p } } : b)));

  const create = async (i: number) => {
    const b = bees[i]!;
    patch(i, { busy: "design", error: "" });
    try {
      const d = await post<Design>("design", { ...oaBody, slot: i, description: b.ask.trim() });
      // A new design is a new bee: its old portrait no longer fits.
      patch(i, { design: d, img: null, busy: "" });
    } catch (e) {
      patch(i, { busy: "", error: fail(e) });
    }
  };

  const paint = async (i: number) => {
    const b = bees[i]!;
    if (!b.design) return;
    patch(i, { busy: "paint", error: "" });
    try {
      const r = await post<{ url: string }>("paint", { ...oaBody, slot: i, name: b.design.name, look: b.design.look });
      patch(i, { img: r.url, busy: "" });
    } catch (e) {
      patch(i, { busy: "", error: `${fail(e)} You can try again.` });
    }
  };

  const save = () =>
    run(async () => {
      await post("save", {
        engine: chooser === "rules" ? "rules" : "llm",
        ...(chooser === "gemini" ? { geminiKey: modelKey } : chooser === "claude" ? { anthropicKey: modelKey } : chooser === "jev" ? { jevKey: modelKey } : {}),
        ...(openaiKey ? { openaiKey } : {}),
        accept,
        ownerPassword: password,
        bees: bees.map((b) => ({
          name: b.design!.name.trim(),
          style: b.design!.baseStyle,
          tagline: b.design!.tagline.trim(),
          rules: b.design!.rules,
          coins: b.design!.coins,
          look: b.design!.look,
          image: !!b.img,
        })),
        hive: false,
      });
      setDone(true);
    });

  if (!status) {
    return (
      <div className="setup">
        <div className="setup-card">
          <h1>WaspBot</h1>
          <p className="dim">{error || "Loading…"}</p>
        </div>
      </div>
    );
  }

  if (timedOut || status.timedOut) {
    return (
      <div className="setup">
        <div className="setup-card center">
          <h1>Setup timed out</h1>
          <p>
            Setup timed out to keep this server safe. Restart the engine container (Hostinger <b>Docker Manager</b> → <b>Restart</b>, or{" "}
            <code>docker compose restart engine</code>) to open it again.
          </p>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="setup">
        <div className="setup-card center">
          <h1>Starting your wasps</h1>
          <p>Saved. The engine is restarting in paper trading. This page opens the dashboard as soon as it's back, usually within a minute.</p>
        </div>
      </div>
    );
  }

  const beesReady = bees.length === 3 && bees.every((b) => b.design && b.img && !nameProblem(b.design.name));
  const anyBusy = busy || bees.some((b) => b.busy);

  return (
    <div className="setup">
      <div className="setup-card">
        <div className="setup-head">
          <h1>WaspBot setup</h1>
          <ol className="setup-steps">
            {STEPS.map((s, i) => (
              <li key={s} className={i === step ? "on" : i < step ? "done" : ""}>
                {s}
              </li>
            ))}
          </ol>
        </div>

        {!status.secure && (
          <div className="setup-warn">
            This page is on plain HTTP, so your keys travel unencrypted. For a quick paper-trading test that's a small risk. For anything longer,
            point a domain at the server and set <code>PUBLIC_DOMAIN</code> so it gets HTTPS (see the README).
          </div>
        )}

        {step === 0 && (
          <section>
            <h2>Setup code</h2>
            {status.codeLocked ? (
              <p className="setup-err">
                Too many wrong codes. Restart the engine container (<code>docker compose restart engine</code>); a new code is printed in its log.
              </p>
            ) : (
              <>
                <p>
                  To prove this is your server, type the setup code from the engine's log. Run <code>docker compose logs engine</code> on the server (or
                  open the <b>engine</b> container's logs in your host's Docker manager) and look for <b>WaspBot setup code</b>.
                </p>
                <input
                  className="setup-input mono"
                  autoComplete="off"
                  placeholder="XXXXX-XXXXX-XXXXX"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && code.trim().length >= 8 && !busy && void run(async () => ((SETUP_CODE = code.trim()), await post("check-code", {}), setStep(1)))}
                  autoFocus
                />
              </>
            )}
            <div className="setup-actions">
              <button disabled={busy || code.trim().length < 8 || !!status.codeLocked} onClick={() => run(async () => ((SETUP_CODE = code.trim()), await post("check-code", {}), setStep(1)))}>
                {busy ? "Checking…" : "Continue"}
              </button>
            </div>
          </section>
        )}

        {step === 1 && (
          <section>
            <h2>Before anything else</h2>
            <p>WaspBot is an experiment and a piece of open-source software, not a trading product. Tick all three to carry on.</p>
            <label className="setup-check">
              <input type="checkbox" checked={accept.notAdvice} onChange={(e) => setAccept({ ...accept, notAdvice: e.target.checked })} />
              <span>
                <b>This is not financial advice.</b> Nothing the wasps do, and nothing in the code, is a recommendation to buy or sell anything.
              </span>
            </label>
            <label className="setup-check">
              <input type="checkbox" checked={accept.paperDefault} onChange={(e) => setAccept({ ...accept, paperDefault: e.target.checked })} />
              <span>
                <b>My wasps trade on paper.</b> They use real market prices and simulated money. Nothing touches an exchange account unless I change the
                server settings myself, on purpose.
              </span>
            </label>
            <label className="setup-check">
              <input type="checkbox" checked={accept.ownRisk} onChange={(e) => setAccept({ ...accept, ownRisk: e.target.checked })} />
              <span>
                <b>I use it at my own risk.</b> The software comes with no warranty (MIT licence). Leveraged crypto trading can lose everything you put in, and if
                I ever switch it to real money, that's on me.
              </span>
            </label>
            <div className="setup-actions">
              <button disabled={!accept.notAdvice || !accept.paperDefault || !accept.ownRisk} onClick={() => setStep(2)}>
                I agree
              </button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section>
            <h2>Pick an owner password</h2>
            <p>
              Your dashboard is public, so anything you change from it later (the decision engine, news sources, resuming after the portfolio
              breaker) asks for this password. Pick one only
              you know, at least 8 characters. The server keeps only a scrambled (hashed) copy, so write it down: to reset it, run Setup again (see the
              README).
            </p>
            <input
              className="setup-input"
              type="password"
              autoComplete="new-password"
              placeholder="Owner password (8+ characters)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
            <input className="setup-input" type="password" autoComplete="new-password" placeholder="Type it again" value={password2} onChange={(e) => setPassword2(e.target.value)} />
            {password.length > 0 && password.length < 8 && <p className="setup-err small">At least 8 characters.</p>}
            {password2.length > 0 && password.length >= 8 && password2 !== password && <p className="setup-err small">The two don't match yet.</p>}
            <div className="setup-actions">
              <button className="ghost" onClick={() => setStep(1)}>
                Back
              </button>
              <button disabled={password.length < 8 || password.length > 200 || password !== password2} onClick={() => setStep(3)}>
                Next
              </button>
            </div>
          </section>
        )}

        {step === 3 && (
          <section>
            <h2>Who makes the calls</h2>
            <div className="ctl-seg" role="radiogroup" aria-label="Decision engine">
              {(["rules", "claude", "gemini", "jev"] as const).map((c) => (
                <button key={c} className={chooser === c ? "on" : ""} onClick={() => (setChooser(c), setModelKey(""), setKeyOk(false))} role="radio" aria-checked={chooser === c}>
                  {c === "rules" ? "Rules engine" : c === "claude" ? "Claude" : c === "gemini" ? "Gemini" : "Jev"}
                </button>
              ))}
            </div>
            {chooser === "rules" ? (
              <p>
                <b>The rules engine</b> picks every move with plain code: no key, no cost, and exactly what the backtester measures. Start here; you can
                switch to a model later from <b>Controls</b> on the dashboard once a key is set.
              </p>
            ) : chooser === "claude" ? (
              <p>
                <b>Claude</b> picks among the moves the rules allow (code picks when it cannot). Get a key at{" "}
                <a href="https://console.anthropic.com/" target="_blank" rel="noopener">
                  console.anthropic.com
                </a>
                . The engine asks at most once a minute per wasp and caps spending at $3 a day by default. The same key can read the news for the
                knowledge layer.
              </p>
            ) : chooser === "gemini" ? (
              <p>
                <b>Gemini</b> picks among the moves the rules allow (code picks when it cannot). Get a key in{" "}
                <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">
                  Google AI Studio
                </a>{" "}
                from a project with billing turned on. The engine asks at most once a minute per wasp and caps spending at $3 a day by default.
              </p>
            ) : (
              <p>
                <b>Jev</b> (TypeSafe AI) picks among the moves the rules allow (code picks when it cannot). Get a key at{" "}
                <a href="https://console.typesafe.ai/keys" target="_blank" rel="noopener">
                  console.typesafe.ai/keys
                </a>
                . The engine stops calling Jev at about $2 a day by default (a soft limit).
              </p>
            )}
            {chooser !== "rules" && (
              <>
                <input
                  className="setup-input mono"
                  type="password"
                  autoComplete="off"
                  placeholder={chooser === "claude" ? "Anthropic API key" : chooser === "gemini" ? "Gemini API key" : "Jev API key"}
                  value={modelKey}
                  onChange={(e) => (setModelKey(e.target.value), setKeyOk(false))}
                />
                {keyOk && <p className="setup-ok">✓ The key works.</p>}
              </>
            )}
            <div className="setup-actions">
              <button className="ghost" onClick={() => setStep(2)}>
                Back
              </button>
              {chooser === "rules" || keyOk ? (
                <button onClick={() => setStep(4)}>Next</button>
              ) : (
                <button
                  disabled={busy || modelKey.trim().length < 8}
                  onClick={() => run(async () => (await post(chooser === "claude" ? "check-claude" : chooser === "gemini" ? "check-gemini" : "check-jev", { key: modelKey.trim() }), setKeyOk(true)))}
                >
                  {busy ? "Checking…" : "Check key"}
                </button>
              )}
            </div>
          </section>
        )}

        {step === 4 && (
          <section>
            <h2>OpenAI key</h2>
            <p>
              Required. OpenAI designs each wasp's trading style from a sentence you write, and paints its portrait. A design is one quick, cheap
              ChatGPT call; a portrait takes about 40 seconds and a few cents. The key is only used on this page.
            </p>
            {status.serverHasOpenAiKey ? (
              <p className="setup-ok">✓ The server already has an OpenAI key.</p>
            ) : (
              <>
                <input
                  className="setup-input mono"
                  type="password"
                  autoComplete="off"
                  placeholder="sk-…"
                  value={openaiKey}
                  onChange={(e) => (setOpenaiKey(e.target.value), setOpenaiOk(false))}
                />
                {openaiOk && <p className="setup-ok">✓ OpenAI key works.</p>}
              </>
            )}
            <div className="setup-actions">
              <button className="ghost" onClick={() => setStep(3)}>
                Back
              </button>
              {hasOpenAi ? (
                <button onClick={() => setStep(5)}>Next</button>
              ) : (
                <button disabled={busy || openaiKey.trim().length < 8} onClick={() => run(async () => (await post("check-openai", { openaiKey: openaiKey.trim() }), setOpenaiOk(true)))}>
                  {busy ? "Checking…" : "Check key"}
                </button>
              )}
            </div>
          </section>
        )}

        {step === 5 && (
          <section>
            <h2>Design your wasps</h2>
            <p>
              Three wasps trade side by side. For each one, say how you want it to trade. OpenAI turns that into a name, a set of rules and the coins
              it may trade, then you paint its portrait. The rules steer the decision among the moves its built-in style offers; the risk layer
              always has the last word.
            </p>
            <div className="setup-bees">
              {bees.map((b, i) => {
                const d = b.design;
                const problem = d ? nameProblem(d.name) : null;
                return (
                  <div className="setup-bee" key={i} style={{ ["--bee" as string]: `var(--${["bizzy", "breezy", "boozy"][i]})` }}>
                    <div className={`setup-portrait ${b.img ? "" : "empty"}`}>
                      <img src={b.img ?? BEE_MARK_URL} alt={b.img ? `${d?.name ?? "wasp"} portrait` : "no portrait yet"} />
                      {b.busy === "paint" && <span className="setup-portrait-busy">Painting… (~40 s)</span>}
                    </div>
                    <label className="setup-label" htmlFor={`ask-${i}`}>
                      How do you want this wasp to trade?
                    </label>
                    <textarea
                      id={`ask-${i}`}
                      className="setup-input small"
                      rows={3}
                      maxLength={400}
                      placeholder={`e.g. ${EXAMPLES[i]}`}
                      value={b.ask}
                      onChange={(e) => patch(i, { ask: e.target.value })}
                    />
                    <button className={d ? "ghost" : ""} disabled={!!b.busy || b.ask.trim().length < 3} onClick={() => void create(i)}>
                      {b.busy === "design" ? "Designing…" : d ? "Create again" : "Create my wasp"}
                    </button>

                    {d && (
                      <div className="setup-design">
                        <input className="setup-input setup-name" maxLength={24} value={d.name} onChange={(e) => patchDesign(i, { name: e.target.value })} aria-label="Name" />
                        {problem && <p className="setup-err small">{problem}</p>}
                        <input className="setup-input small" maxLength={40} value={d.tagline} onChange={(e) => patchDesign(i, { tagline: e.target.value })} aria-label="Tagline" />
                        <div className="setup-coins">
                          {d.coins.length ? d.coins.map((c) => <span key={c} className="coin-chip">{c}</span>) : <span className="coin-chip any">any coin</span>}
                          <span className="dim small">runs on {d.styleLabel}</span>
                        </div>
                        {d.styleNote && <p className="setup-note small">{d.styleNote}</p>}
                        <p className="setup-rules">{d.rules}</p>
                        <button className={b.img ? "ghost" : ""} disabled={!!b.busy} onClick={() => void paint(i)}>
                          {b.busy === "paint" ? "Painting… (~40 s)" : b.img ? "Paint again" : "Generate its portrait"}
                        </button>
                      </div>
                    )}
                    {b.error && <p className="setup-err small">{b.error}</p>}
                  </div>
                );
              })}
            </div>
            <div className="setup-actions">
              {!beesReady && <span className="dim small setup-hint">Create all three wasps and paint their portraits to carry on.</span>}
              <button className="ghost" onClick={() => setStep(4)}>
                Back
              </button>
              <button disabled={!beesReady || anyBusy} onClick={() => setStep(6)}>
                Next
              </button>
            </div>
          </section>
        )}

        {step === 6 && (
          <section>
            <h2>Ready</h2>
            <ul className="setup-summary">
              {bees.map((b, i) => (
                <li key={i}>
                  <img src={b.img ?? BEE_MARK_URL} alt="" />
                  <span>
                    <b>{b.design?.name}</b> {b.design?.tagline && <span className="dim">{b.design.tagline}</span>}
                    <br />
                    <span className="dim small">{b.design?.coins.length ? b.design.coins.join(", ") : "any coin"} · {b.design?.styleLabel}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p>
              Each wasp starts with <b>$333 of paper money</b>, and trades OKX perpetuals at real prices. The engine saves your settings, restarts, and
              opens the live dashboard. The setup page then closes for good. To run it again later, see the README.
            </p>
            <p>
              Decisions: <b>{chooser === "rules" ? "the rules engine" : chooser === "claude" ? "Claude" : chooser === "gemini" ? "Gemini" : "Jev"}</b>. News
              (free RSS feeds) and the event calendar start on their own; switch anything from <b>Controls</b> on the dashboard.
            </p>
            <p className="dim small">
              Optional, once you are trading: give your wasps a coach. The <b>Beekeeper</b> card on your dashboard connects a Zap on Zapier that can
              rewrite a losing wasp's rules.{" "}
              <a href="https://github.com/AugisKo/waspbot/blob/main/docs/BEEKEEPER.md" target="_blank" rel="noopener">
                How it works ↗
              </a>
            </p>
            <div className="setup-actions">
              <button className="ghost" onClick={() => setStep(5)}>
                Back
              </button>
              <button disabled={busy} onClick={() => void save()}>
                {busy ? "Saving…" : "Start paper trading"}
              </button>
            </div>
          </section>
        )}

        {error && <p className="setup-err">{error}</p>}
        <p className="setup-foot dim small">Not financial advice. Open source, MIT licence, no warranty.</p>
      </div>
    </div>
  );
}
