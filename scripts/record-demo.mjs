#!/usr/bin/env node
/**
 * Records demo/concert-demo.mp4 (`npm run demo:video`, needs ffmpeg).
 *
 * Ten fans in ten separate browsers (separate identities) buy tickets while a
 * caption band explains one thing at a time. Scenes run strictly in sequence,
 * the panes involved are spotlighted (others dimmed), and the seat being
 * talked about is outlined on every seat map. An intro card says what to
 * watch for; an outro card shows the results and how it works.
 *
 * Starts its own dev server on port 5300. Doors open after the real 20s;
 * admission (1 fan every 3s) and holds (25s) are slowed/shortened so the queue
 * and an abandoned hold are visible on camera. Those overrides go through
 * E2E_TIMINGS (dev server only), the same hook the Playwright suite uses.
 */
import { chromium } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "demo");
const RAW_DIR = path.join(OUT_DIR, "raw");
const OUT_FILE = path.join(OUT_DIR, "concert-demo.mp4");
const PORT = 5300;
const BASE = `http://localhost:${PORT}`;
const EVENT_ID = `demo-${Date.now()}`;
const REPO_URL = "github.com/saahityaedams/durable-objects-experiment";
const LIVE_URL = "concert-booking.saahitya-e.workers.dev";

const TIMINGS = { QUEUE_TICK_MS: "3000", QUEUE_BATCH_SIZE: "1", HOLD_DURATION_MS: "25000" };
const HOLD_S = Number(TIMINGS.HOLD_DURATION_MS) / 1000;
/** When visitors 1-7 arrive (seconds). Doors open 20s after the first. 8-10 arrive later, on cue. */
const EARLY_ARRIVALS_S = [0, 2, 4, 6, 9, 12, 16];
const VISITORS = 10;

const PANE = { width: 384, height: 420 }; // 5x2 grid under a 240px caption band
const PANE_VIEWPORT = { width: 576, height: 630 };
const BAND = { width: 1920, height: 240 };
const INTRO_S = 10;
const OUTRO_S = 13;

const RACE_SEAT = "A-1-1";
const ABANDONED_SEAT = "A-1-5";
const BUYER_SEATS = ["A-1-3", "A-1-4", "A-1-6", "A-2-4", "A-2-5", "A-1-2", "A-2-3", "A-2-6", "B-1-4", "B-1-5"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t0 = 0;
const elapsed = () => (Date.now() - t0) / 1000;
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const log = (...a) => console.log(`[${fmt(Math.max(0, elapsed()))}]`, ...a);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

// ---------------------------------------------------------------- dev server

async function startServer() {
  const server = spawn("npx", ["react-router", "dev", "--port", String(PORT), "--strictPort"], {
    cwd: ROOT,
    env: { ...process.env, E2E_TIMINGS: JSON.stringify(TIMINGS) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  server.stdout.on("data", (d) => (output += d));
  server.stderr.on("data", (d) => (output += d));
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`dev server exited:\n${output}`);
    try {
      if ((await fetch(`${BASE}/`)).ok) return server;
    } catch {}
    await sleep(500);
  }
  throw new Error(`dev server did not start:\n${output}`);
}

function stopServer(server) {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
}

/** Loads every route once so Vite's on-demand compile doesn't stall the recording. */
async function warmUp(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const warm = `warmup-${Date.now()}`;
  await page.goto(`${BASE}/event/${warm}`);
  await page.goto(`${BASE}/event/${warm}/seats?token=x`);
  await page.waitForURL(`**/event/${warm}`);
  await page.goto(`${BASE}/event/${warm}/checkout?seatId=A-1-1&holdId=x`);
  await page.waitForTimeout(1000);
  await ctx.close();
}

// ---------------------------------------------------------- in-page overlay

/**
 * Runs in every visitor page: a status banner, the spotlight (orange frame or
 * dimming), an outline on the seat being discussed, zoom-to-fit and click
 * ripples. State comes from localStorage("demo-state"), written by the script.
 */
function visitorOverlay() {
  const base = new CSSStyleSheet();
  base.replaceSync("body{zoom:.85;padding-top:56px}");
  const highlight = new CSSStyleSheet();
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, base, highlight];

  // Lives outside <body> in a shadow root, so React hydration never sees it.
  function host() {
    let el = document.getElementById("demo-overlay");
    if (!el && document.documentElement) {
      el = document.createElement("div");
      el.id = "demo-overlay";
      el.style.pointerEvents = "none";
      el.attachShadow({ mode: "open" }).innerHTML = `<style>
        *{pointer-events:none}
        .bar{position:fixed;inset:0 0 auto 0;height:56px;display:flex;align-items:center;padding:0 18px;
          font:700 26px/1 Inter,system-ui,sans-serif;color:#fff;z-index:2147483646;background:#4b5563;
          white-space:nowrap;overflow:hidden}
        .bar.admit{background:#2563eb}.bar.hold{background:#d97706}.bar.win{background:#16a34a}
        .bar.lose{background:#dc2626}.bar.gone{background:#1f2937}
        .frame{position:fixed;inset:0;z-index:2147483647;transition:background .35s,box-shadow .35s}
        .frame.focus{box-shadow:inset 0 0 0 10px #f97316}
        .frame.dim{background:rgba(15,23,42,.62)}
        .ripple{position:fixed;width:64px;height:64px;margin:-32px 0 0 -32px;border-radius:50%;
          border:6px solid #f97316;background:rgba(249,115,22,.3);z-index:2147483647;animation:r .8s ease-out forwards}
        @keyframes r{from{transform:scale(.3);opacity:1}to{transform:scale(1.5);opacity:0}}
      </style><div class="bar"></div><div class="frame"></div>`;
      document.documentElement.appendChild(el);
    }
    return el;
  }
  let last = "";
  function render() {
    const el = host();
    if (!el) return;
    let raw = "";
    try {
      raw = localStorage.getItem("demo-state") || "";
    } catch {}
    if (!raw || raw === last) return;
    last = raw;
    const s = JSON.parse(raw);
    const bar = el.shadowRoot.querySelector(".bar");
    bar.className = `bar ${s.tone || ""}`;
    bar.textContent = s.text || "";
    el.shadowRoot.querySelector(".frame").className = `frame ${s.focus || ""}`;
    highlight.replaceSync(
      s.highlight
        ? `[data-seat="${s.highlight}"]{outline:5px solid #f97316!important;outline-offset:2px;position:relative;z-index:1}`
        : "",
    );
  }
  window.__demoRender = render;
  setInterval(render, 100);
  document.addEventListener(
    "pointerdown",
    (e) => {
      const el = host();
      if (!el) return;
      const dot = document.createElement("div");
      dot.className = "ripple";
      dot.style.left = `${e.clientX}px`;
      dot.style.top = `${e.clientY}px`;
      el.shadowRoot.appendChild(dot);
      setTimeout(() => dot.remove(), 900);
    },
    true,
  );
}

const screenPage = (title, subtitle) => `<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;height:100vh;display:grid;place-content:center;text-align:center;background:#e5e7eb;
font-family:Inter,system-ui,sans-serif;color:#374151;padding:0 30px}h1{font-size:46px;margin:0}
p{font-size:28px;color:#6b7280;margin:14px 0 0}</style></head><body><h1>${title}</h1><p>${subtitle}</p></body></html>`;

// ------------------------------------------------------------- caption band

const BAND_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;height:100vh;background:#0f172a;color:#e2e8f0;font-family:Inter,system-ui,sans-serif;
  display:flex;gap:40px;padding:24px 36px;border-bottom:3px solid #f97316}
.left{flex:1;display:flex;flex-direction:column;justify-content:center;gap:12px;min-width:0}
.step{display:flex;align-items:center;gap:18px}
.num{flex:none;width:58px;height:58px;border-radius:50%;background:#f97316;color:#0f172a;display:grid;place-items:center;font:800 32px Inter,sans-serif}
.title{font-size:42px;font-weight:800;color:#fff;letter-spacing:-.02em;line-height:1.1}
.sub{font-size:27px;line-height:1.35;color:#cbd5e1}.sub b{color:#fdba74}
.right{width:720px;flex:none;display:flex;flex-direction:column;justify-content:center;gap:10px}
.top{display:flex;justify-content:space-between;align-items:center}
.brand{font-size:19px;color:#94a3b8}.brand b{color:#f97316}
.clock{font:700 36px ui-monospace,Menlo,monospace;color:#f97316}
.row{display:flex;align-items:center;gap:6px;height:40px}.label{width:118px;flex:none;font-size:19px;color:#94a3b8}
.chip{font:700 18px ui-monospace,Menlo,monospace;padding:6px 7px;border-radius:7px;color:#fff;min-width:46px;text-align:center}
.early{background:#2563eb}.late{background:#7c3aed}
.legend{font-size:16px;color:#94a3b8}.legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin:0 6px 0 0;vertical-align:-1px}
</style></head><body>
<div class="left"><div class="step"><div class="num" id="num"></div><div class="title" id="title"></div></div><div class="sub" id="sub"></div></div>
<div class="right">
  <div class="top"><div class="brand">Cloudflare <b>Workers + Durable Objects</b></div><div class="clock" id="clock">0:00</div></div>
  <div class="row"><div class="label">Arrived</div><div id="arrived" style="display:flex;gap:6px"></div></div>
  <div class="row"><div class="label">Turn order</div><div id="turns" style="display:flex;gap:6px"></div></div>
  <div class="legend"><i style="background:#2563eb"></i>came before doors opened &nbsp;&nbsp;<i style="background:#7c3aed"></i>came after</div>
</div>
<script>
window.render = (s) => {
  num.textContent = s.num; title.textContent = s.title; sub.innerHTML = s.sub; clock.textContent = s.clock;
  const chips = (list) => list.map((c) => '<span class="chip ' + c.cls + '">' + c.label + '</span>').join('');
  arrived.innerHTML = chips(s.arrived); turns.innerHTML = chips(s.turns);
};
</script></body></html>`;

const band = { num: "1", title: "", sub: "", arrived: [], turns: [], countdownTo: null, countdownText: null };
let bandPage;

function caption(num, title, sub) {
  Object.assign(band, { num: String(num), title, sub, countdownTo: null, countdownText: null });
  log(`— ${num}. ${title} — ${sub.replace(/<[^>]+>/g, "")}`);
}

async function renderBand() {
  let sub = band.sub;
  if (band.countdownTo) {
    const left = Math.max(0, Math.ceil((band.countdownTo - Date.now()) / 1000));
    sub += band.countdownText.replace("{s}", String(left));
  }
  await bandPage
    ?.evaluate((s) => window.render(s), { ...band, sub, clock: fmt(Math.max(0, elapsed())) })
    .catch(() => {});
}

// ------------------------------------------------------------------ visitors

const visitors = [];

async function pushState(v) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await v.page.evaluate((s) => {
        localStorage.setItem("demo-state", JSON.stringify(s));
        window.__demoRender?.();
      }, v.state);
      return;
    } catch {
      await sleep(150); // mid-navigation; retry on the new document
    }
  }
}

function setBanner(v, text, tone) {
  v.state = { ...v.state, text: `V${v.n} · ${text}`, tone };
  return pushState(v);
}

/** Spotlight: `focused` get an orange frame, everyone else is dimmed. Empty = nobody dimmed. */
function spotlight(focused = []) {
  const set = new Set(focused);
  return Promise.all(
    visitors.map((v) => {
      v.state = { ...v.state, focus: focused.length === 0 ? "" : set.has(v) ? "focus" : "dim" };
      return pushState(v);
    }),
  );
}

/** Outlines a seat on every visitor's seat map (null clears it). */
function highlightSeat(seatId) {
  return Promise.all(
    visitors.map((v) => {
      v.state = { ...v.state, highlight: seatId };
      return pushState(v);
    }),
  );
}

const seatButton = (v, seatId) => v.page.locator(`[data-seat="${seatId}"]`);

/** Clicks a seat; resolves to "won" (reached checkout) or "taken". */
async function tryHold(v, seatId) {
  await seatButton(v, seatId).click();
  return Promise.race([
    v.page.waitForURL(/\/checkout\?/, { timeout: 15_000 }).then(() => "won"),
    v.page.getByText(/just took that seat/).waitFor({ timeout: 15_000 }).then(() => "taken"),
  ]);
}

async function pay(v, seatId, extra = "") {
  await setBanner(v, `🛒 holding ${seatId}`, "hold");
  await sleep(1800);
  await v.page.getByRole("button", { name: /^Pay \$/ }).click();
  await v.page.getByText(/^Booked:/).waitFor({ timeout: 15_000 });
  await setBanner(v, `✅ booked ${seatId}${extra}`, "win");
  v.booked = seatId;
  // Back to the live seat map, so every pane shows the venue filling up.
  await sleep(2200);
  await v.page.goBack();
  await v.page.waitForURL(/\/seats\?token=/);
}

const claimed = new Set([RACE_SEAT, ABANDONED_SEAT]);
async function buySomething(v) {
  for (const seatId of BUYER_SEATS) {
    if (claimed.has(seatId)) continue;
    claimed.add(seatId);
    if ((await tryHold(v, seatId)) === "won") return pay(v, seatId);
  }
  throw new Error(`V${v.n} found no seat`);
}

let turnCount = 0;
const byTurn = new Map(); // turn number -> deferred visitor
const turn = (k) => {
  if (!byTurn.has(k)) byTurn.set(k, deferred());
  return byTurn.get(k).promise;
};

/** A visitor walks in, then waits (in the background) for their turn. */
async function arrive(v) {
  v.arrived = true;
  band.arrived.push({ label: `V${v.n}`, cls: v.early ? "early" : "late" });
  log(`V${v.n} arrives`);
  await setBanner(v, "⏳ waiting in line", "");
  await v.page.goto(`${BASE}/event/${EVENT_ID}`);
  v.admitted = (async () => {
    await v.page.waitForURL(/\/seats\?token=/, { timeout: 240_000 });
    v.turn = ++turnCount;
    band.turns.push({ label: `V${v.n}`, cls: v.early ? "early" : "late" });
    await setBanner(v, `🎟 your turn (#${v.turn})`, "admit");
    log(`V${v.n} gets turn #${v.turn}`);
    await v.page.locator('[data-status="available"]').first().waitFor();
    turn(v.turn);
    byTurn.get(v.turn).resolve(v);
    return v;
  })();
}

/** Asks the queue where V1 (first to arrive) landed in the draw. */
async function placeOfFirstArrival() {
  const v1 = visitors[0];
  for (let i = 0; i < 20; i++) {
    if (v1.turn) return v1.turn;
    try {
      const s = await v1.page.evaluate(async (eventId) => {
        const id = localStorage.getItem("concert-demo-user-id");
        const res = await fetch(`/api/events/${eventId}/queue/status?userId=${id}`);
        return res.json();
      }, EVENT_ID);
      if (s.status === "admitted") return turnCount || 1;
      if (s.waitingAhead !== null) return s.waitingAhead + 1 + (EARLY_ARRIVALS_S.length - s.waitingTotal);
    } catch {}
    await sleep(300);
  }
  return null;
}

// -------------------------------------------------------------------- scenes

async function direct() {
  const early = visitors.filter((v) => v.early);
  const late = visitors.filter((v) => !v.early);

  // 1 · arrivals
  caption(1, "Fans arrive before the doors open",
    "Doors open at <b>0:20</b>. Everyone already waiting then gets a <b>random</b> place in line, so arriving early doesn't help.");
  let saleOpensAt = null;
  for (const v of early) {
    await sleep(Math.max(0, t0 + v.arriveAt * 1000 - Date.now()));
    await spotlight([v]);
    await arrive(v);
    if (v.n === 1) {
      await sleep(800);
      saleOpensAt = await v.page.evaluate(async (eventId) => {
        const id = localStorage.getItem("concert-demo-user-id");
        return (await (await fetch(`/api/events/${eventId}/queue/status?userId=${id}`)).json()).saleOpensAt;
      }, EVENT_ID);
    }
    setTimeout(() => v.state.focus === "focus" && spotlight([]), 1500);
  }
  await sleep(Math.max(0, saleOpensAt - Date.now()));
  await spotlight([]);

  // 2 · the draw
  caption(2, "Doors open: places in line are drawn at random",
    "Now <b>one fan every 3 seconds</b> gets a turn on the seat map. The rest see how many people are ahead of them.");
  const place = await placeOfFirstArrival();
  const first = await turn(1);
  band.sub = place && place > 1
    ? `<b>V${first.n}</b> drew the first turn. <b>V1</b> arrived first, but drew place <b>#${place} of ${early.length}</b>. Arriving early didn't help.`
    : `<b>V${first.n}</b> drew the first turn. The order is a fresh random draw, not arrival order.`;
  await spotlight(first.n === 1 ? [first] : [first, visitors[0]]);
  await sleep(6000);

  // 3 · the race
  const second = await turn(2);
  const racers = [first, second];
  await spotlight(racers);
  await highlightSeat(RACE_SEAT);
  caption(3, "Two fans click the same seat at the same moment",
    `<b>V${first.n}</b> and <b>V${second.n}</b> both go for seat <b>${RACE_SEAT}</b>…`);
  await sleep(2500);
  const results = await Promise.all(racers.map((v) => tryHold(v, RACE_SEAT)));
  const winner = racers[results.indexOf("won")];
  const loser = racers[results.indexOf("taken")];
  await setBanner(loser, `❌ ${RACE_SEAT} was just taken`, "lose");
  band.sub = `Only <b>V${winner.n}</b> gets it. <b>V${loser.n}</b> is told it's taken. One Durable Object owns each section's seats and handles <b>one request at a time</b>, so two clicks can't both win.`;
  await pay(winner, RACE_SEAT);
  await sleep(1500);

  // 4 · latecomers
  await highlightSeat(null);
  caption(4, "Late arrivals join the back of the line",
    "They came after the doors opened, so they wait behind everyone already in line, <b>in the order they arrived</b>.");
  await spotlight(late);
  for (const v of late) {
    await arrive(v);
    await sleep(2200);
  }
  await sleep(3500);

  // 5 · the abandoned seat
  const quitter = await turn(3);
  await spotlight([quitter]);
  await highlightSeat(ABANDONED_SEAT);
  caption(5, "A fan grabs a front-row seat… then closes the tab",
    `<b>V${quitter.n}</b> holds seat <b>${ABANDONED_SEAT}</b> but never pays.`);
  await sleep(1500);
  await tryHold(quitter, ABANDONED_SEAT);
  const heldAt = Date.now();
  await setBanner(quitter, `🛒 holding ${ABANDONED_SEAT}`, "hold");
  await sleep(3000);
  await quitter.page.goto(`${BASE}/__demo/closed`);
  await setBanner(quitter, `🚪 left · ${ABANDONED_SEAT} still held`, "gone");
  band.sub = `<b>${ABANDONED_SEAT}</b> stays locked for everyone while it's held. The hold lasts ${HOLD_S}s in this video (4 minutes for real).`;
  await sleep(3000);

  // 6 · everyone else
  await spotlight([]);
  caption(6, "Everyone else takes their turn",
    `Seat maps update live as seats sell. <b>${ABANDONED_SEAT}</b> stays locked: back on sale in `);
  band.countdownTo = heldAt + HOLD_S * 1000;
  band.countdownText = "<b>~{s}s</b>.";
  const finalist = visitors[VISITORS - 1]; // the last fan to arrive
  const buyers = visitors.filter((v) => v !== winner && v !== quitter && v !== finalist);
  const buying = [];
  for (const v of buyers.sort((a, b) => (a.turn ?? 99) - (b.turn ?? 99))) {
    await v.admitted;
    if (v === loser) await setBanner(v, "🎟 picking another seat", "admit");
    buying.push(buySomething(v));
    await sleep(2000);
  }
  await Promise.all(buying);
  await finalist.admitted;
  await setBanner(finalist, `🎟 your turn · waiting for ${ABANDONED_SEAT}`, "admit");
  await finalist.page
    .locator(`[data-seat="${ABANDONED_SEAT}"][data-status="available"]`)
    .waitFor({ timeout: (HOLD_S + 60) * 1000 });

  // 7 · the hold expires
  await spotlight([finalist]);
  caption(7, `The hold ran out, so ${ABANDONED_SEAT} is back on sale`,
    `A Durable Object <b>alarm</b> released it automatically, and <b>V${finalist.n}</b>, the last fan to arrive, books it.`);
  await sleep(1800);
  await tryHold(finalist, ABANDONED_SEAT);
  await pay(finalist, ABANDONED_SEAT, " (the abandoned seat)");

  // done
  await spotlight([]);
  await highlightSeat(null);
  const sold = visitors.filter((v) => v.booked).length;
  caption("✓", `Done: ${sold} seats sold to ${sold} different fans`,
    "No seat was sold twice, arriving early didn't jump the line, and the abandoned seat came back by itself.");
  await sleep(4500);
  return { sold, v1Place: place, winner, loser, quitter, finalist };
}

// ---------------------------------------------------------------- cards

const CARD_CSS = `*{box-sizing:border-box}body{margin:0;width:1920px;height:1080px;background:#0f172a;color:#e2e8f0;
font-family:Inter,system-ui,sans-serif;padding:90px 130px;display:flex;flex-direction:column}
h1{font-size:76px;margin:0;color:#fff;letter-spacing:-.03em}h1 em{font-style:normal;color:#f97316}
.lead{font-size:34px;color:#94a3b8;margin:18px 0 0}
h2{font-size:30px;text-transform:uppercase;letter-spacing:.12em;color:#f97316;margin:64px 0 26px}
.items{display:grid;gap:26px}.item{display:flex;gap:26px;align-items:flex-start;font-size:34px;line-height:1.35}
.item .n{flex:none;width:58px;height:58px;border-radius:50%;background:#f97316;color:#0f172a;display:grid;place-items:center;font-weight:800}
.item b{color:#fff}.muted{color:#94a3b8}
.legend{margin-top:auto;display:flex;gap:16px;font-size:24px;align-items:center;color:#cbd5e1}
.pill{padding:10px 18px;border-radius:10px;color:#fff;font-weight:700}
.boxes{display:grid;grid-template-columns:repeat(3,1fr);gap:28px}
.box{background:#1e293b;border-radius:18px;padding:30px 32px;font-size:27px;line-height:1.4;color:#cbd5e1}
.box h3{margin:0 0 12px;font-size:32px;color:#fff}.box h3 small{display:block;font-size:22px;color:#f97316;font-weight:600;margin-top:4px}
.results{display:flex;gap:28px;margin-top:40px}.stat{background:#1e293b;border-radius:18px;padding:24px 34px;font-size:28px;color:#94a3b8}
.stat b{display:block;font-size:52px;color:#fff}
.foot{margin-top:auto;font-size:28px;color:#94a3b8;display:grid;gap:10px}.foot b{color:#fdba74}.foot small{font-size:22px;color:#64748b}`;

const introHtml = () => `<!doctype html><html><head><meta charset="utf-8"><style>${CARD_CSS}</style></head><body>
<h1>Selling concert tickets <em>fairly</em> to a crowd</h1>
<p class="lead">A demo on Cloudflare Workers + Durable Objects. ${VISITORS} fans, 64 seats. Each fan is a separate browser.</p>
<h2>Watch for</h2>
<div class="items">
  <div class="item"><span class="n">1</span><div><b>Arriving early doesn't help.</b> <span class="muted">Everyone waiting when the doors open gets a random place in line.</span></div></div>
  <div class="item"><span class="n">2</span><div><b>Two fans, one seat: exactly one gets it.</b> <span class="muted">No seat is ever sold twice.</span></div></div>
  <div class="item"><span class="n">3</span><div><b>Abandoned seats come back.</b> <span class="muted">A seat someone holds but doesn't pay for is released automatically.</span></div></div>
</div>
<div class="legend">Each fan's status bar:
  <span class="pill" style="background:#4b5563">waiting in line</span><span class="pill" style="background:#2563eb">their turn</span>
  <span class="pill" style="background:#d97706">holding a seat</span><span class="pill" style="background:#16a34a">booked</span>
  <span class="pill" style="background:#dc2626">lost the seat</span></div>
</body></html>`;

const outroHtml = (r) => `<!doctype html><html><head><meta charset="utf-8"><style>${CARD_CSS}</style></head><body>
<h1>How it works</h1>
<p class="lead">Three kinds of Durable Object. Each is a single-threaded mini-server with its own storage, so each one is a natural lock.</p>
<div class="boxes" style="margin-top:50px">
  <div class="box"><h3>QueueRoom<small>one per event</small></h3>The waiting room. Draws the random order when the doors open, admits fans on an alarm tick, pushes live places in line over WebSockets.</div>
  <div class="box"><h3>SeatShard<small>one per seating section</small></h3>Owns its seats. Handles one request at a time, so two clicks on one seat can't both win. An alarm releases holds that run out.</div>
  <div class="box"><h3>UserHold<small>one per fan</small></h3>Caps how many seats one fan can hold across all sections, so nobody can hoard.</div>
</div>
<div class="results">
  <div class="stat"><b>${r.sold} / ${r.sold}</b>seats sold to different fans</div>
  <div class="stat"><b>0</b>double-bookings</div>
  <div class="stat"><b>${r.v1Place ? `#${r.v1Place}` : "random"}</b>V1's place, despite arriving first</div>
</div>
<div class="foot"><span>Try it live: <b>${LIVE_URL}</b></span><span>Code: <b>${REPO_URL}</b></span>
<small>Timings shortened for the video: 1 fan admitted every 3s, ${HOLD_S}s holds (real: 4 fans every 2s, 4-minute holds).</small></div>
</body></html>`;

async function renderCard(browser, html, file) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  await page.setContent(html);
  await page.screenshot({ path: file });
  await ctx.close();
}

// ---------------------------------------------------------------------- main

async function main() {
  rmSync(RAW_DIR, { recursive: true, force: true });
  mkdirSync(RAW_DIR, { recursive: true });

  console.log(`Starting dev server on ${BASE} (event ${EVENT_ID})…`);
  const server = await startServer();
  const browser = await chromium.launch();
  try {
    await warmUp(browser);

    for (let i = 0; i < VISITORS; i++) {
      const early = i < EARLY_ARRIVALS_S.length;
      const context = await browser.newContext({
        viewport: PANE_VIEWPORT,
        recordVideo: { dir: RAW_DIR, size: PANE_VIEWPORT },
      });
      await context.addInitScript(visitorOverlay);
      await context.route(`${BASE}/__demo/**`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: route.request().url().endsWith("/closed")
            ? screenPage("🚪 Tab closed", `Seat ${ABANDONED_SEAT} is still held, so nobody can buy it`)
            : screenPage(`Fan ${i + 1}`, early ? `arrives at ${fmt(EARLY_ARRIVALS_S[i])}` : "arrives after the doors open"),
        }),
      );
      const v = { n: i + 1, early, arriveAt: EARLY_ARRIVALS_S[i], context, page: await context.newPage(), state: {} };
      v.state = { text: `V${v.n} · not here yet`, tone: "gone", focus: "", highlight: null };
      visitors.push(v);
    }
    const bandCtx = await browser.newContext({ viewport: BAND, recordVideo: { dir: RAW_DIR, size: BAND } });
    bandPage = await bandCtx.newPage();
    await bandPage.setContent(BAND_HTML);
    await Promise.all(
      visitors.map(async (v) => {
        await v.page.goto(`${BASE}/__demo/lobby`);
        await pushState(v);
      }),
    );

    t0 = Date.now();
    const ticker = setInterval(renderBand, 250);
    const result = await direct();
    clearInterval(ticker);

    const res = await fetch(`${BASE}/api/events/${EVENT_ID}/seats`);
    const booked = (await res.json()).seats.filter((s) => s.status === "booked").length;
    if (booked !== result.sold) throw new Error(`expected ${result.sold} booked seats, server says ${booked}`);

    const videos = [];
    for (const v of visitors) {
      await v.context.close();
      videos.push(await v.page.video().path());
    }
    await bandCtx.close();
    videos.unshift(await bandPage.video().path());

    const intro = path.join(RAW_DIR, "intro.png");
    const outro = path.join(RAW_DIR, "outro.png");
    await renderCard(browser, introHtml(), intro);
    await renderCard(browser, outroHtml(result), outro);
    await browser.close();

    compose(videos, intro, outro);
    console.log(`\nWrote ${path.relative(ROOT, OUT_FILE)}`);
  } finally {
    await browser.close().catch(() => {});
    stopServer(server);
  }
}

/** Caption band on top, the 10 fans in a 5x2 grid below, between intro and outro cards. */
function compose([bandVideo, ...panes], intro, outro) {
  const B = 3;
  const filters = [`[0:v]scale=${BAND.width}:${BAND.height},setsar=1,fps=30[band]`];
  panes.forEach((_, i) =>
    filters.push(
      `[${i + 1}:v]scale=${PANE.width - 2 * B}:${PANE.height - 2 * B},pad=${PANE.width}:${PANE.height}:${B}:${B}:color=0x0b1120,setsar=1,fps=30[p${i}]`,
    ),
  );
  const layout = ["0_0", ...panes.map((_, i) => `${(i % 5) * PANE.width}_${BAND.height + Math.floor(i / 5) * PANE.height}`)];
  filters.push(`[band]${panes.map((_, i) => `[p${i}]`).join("")}xstack=inputs=${panes.length + 1}:layout=${layout.join("|")}:shortest=1,format=yuv420p[grid]`);
  const n = panes.length + 1;
  filters.push(`[${n}:v]fps=30,setsar=1,format=yuv420p,fade=t=in:st=0:d=0.6,fade=t=out:st=${INTRO_S - 0.6}:d=0.6[intro]`);
  filters.push(`[${n + 1}:v]fps=30,setsar=1,format=yuv420p,fade=t=in:st=0:d=0.6,fade=t=out:st=${OUTRO_S - 0.8}:d=0.8[outro]`);
  filters.push(`[intro][grid][outro]concat=n=3:v=1:a=0[out]`);
  execFileSync(
    "ffmpeg",
    [
      "-y", "-loglevel", "error",
      ...[bandVideo, ...panes].flatMap((p) => ["-i", p]),
      "-loop", "1", "-framerate", "30", "-t", String(INTRO_S), "-i", intro,
      "-loop", "1", "-framerate", "30", "-t", String(OUTRO_S), "-i", outro,
      "-filter_complex", filters.join(";"),
      "-map", "[out]",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      OUT_FILE,
    ],
    { stdio: "inherit" },
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
