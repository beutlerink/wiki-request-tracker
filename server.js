"use strict";
/*
 * Wikipedia Request Tracker - shared hosting server
 *
 * Serves the single-file tracker app and keeps all state in a shared store so
 * the whole team sees the same board. Two ways in:
 *   - Internal:  GET /            (Basic Auth, full edit access, all projects)
 *   - Client:    GET /c/:token    (public link, read-only, one sanitized project)
 *
 * Storage: Postgres when DATABASE_URL is set (durable, shared). Falls back to an
 * in-memory store when it is not, which is handy for local runs but NOT durable.
 */

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL || "";
const INTERNAL_USER = process.env.INTERNAL_USER || "";
const INTERNAL_PASS = process.env.INTERNAL_PASS || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const AI_MODEL = process.env.AI_MODEL || "claude-haiku-4-5-20251001";
const AI_PROMPT_VERSION = "v6";  // bump to invalidate cached AI reads after a prompt change
const AI_API_URL = process.env.AI_API_URL || "https://api.anthropic.com/v1/messages";

const INDEX_HTML = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");

/* ---------- storage backend ---------- */
// Interface: get(k)->v|null, getPrefix(pre)->{k:v}, setMany([{k,v}]), del(k)
let db;
async function initDb() {
  if (DATABASE_URL) {
    const { Pool } = require("pg");
    const isLocal = /@(localhost|127\.0\.0\.1)/.test(DATABASE_URL);
    const pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      max: 5,
      connectionTimeoutMillis: 8000,   // fail fast if a connection can't be acquired
      idleTimeoutMillis: 30000,
      query_timeout: 9000,             // abort a query that runs too long
      statement_timeout: 9000
    });
    pool.on("error", err => console.error("pg pool error:", err.message));
    await pool.query("CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v text)");
    db = {
      async get(k) {
        const r = await pool.query("SELECT v FROM kv WHERE k=$1", [k]);
        return r.rows.length ? r.rows[0].v : null;
      },
      async getPrefix(pre) {
        const r = await pool.query("SELECT k, v FROM kv WHERE k LIKE $1", [pre + "%"]);
        const o = {};
        r.rows.forEach(row => { o[row.k] = row.v; });
        return o;
      },
      async setMany(ops) {
        if (!ops.length) return;
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          for (const { k, v } of ops) {
            if (v === null || v === undefined) {
              await client.query("DELETE FROM kv WHERE k=$1", [k]);
            } else {
              await client.query(
                "INSERT INTO kv (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v",
                [k, String(v)]
              );
            }
          }
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      }
    };
    console.log("storage: Postgres");
  } else {
    const mem = new Map();
    db = {
      async get(k) { return mem.has(k) ? mem.get(k) : null; },
      async getPrefix(pre) {
        const o = {};
        for (const [k, v] of mem) if (k.indexOf(pre) === 0) o[k] = v;
        return o;
      },
      async setMany(ops) {
        for (const { k, v } of ops) {
          if (v === null || v === undefined) mem.delete(k);
          else mem.set(k, String(v));
        }
      }
    };
    console.log("storage: in-memory (NOT durable - set DATABASE_URL for shared, persistent data)");
  }
}

/* ---------- app-state helpers ---------- */
// App state lives under the "wrt." prefix. "wrt.current.v2" is a per-browser UI
// preference and is intentionally not shared. "sys." keys are server-only.
// Keys the app keeps strictly per-browser (via localStorage) and never syncs to
// the team. Mirrors the client's own LOCAL_ONLY set; kept out of the shared
// snapshot so one person's local UI state (last project, last filter, last
// comment-signature pick) never leaks into what the team sees.
const LOCAL_ONLY_KEYS = new Set(["wrt.current.v2", "wrt.whoami", "wrt.listsort", "wrt.statssort", "wrt.listowner"]);
function isAppKey(k) { return k.indexOf("wrt.") === 0 && !LOCAL_ONLY_KEYS.has(k); }

async function appSnapshot() {
  const all = await db.getPrefix("wrt.");
  const out = {};
  Object.keys(all).forEach(k => { if (isAppKey(k)) out[k] = all[k]; });
  return out;
}

/* ---------- client-link sanitization (mirrors the app's exportClientFile) ---------- */
const AGENCY_ROSTER = ["WWB Too", "Danilo Two", "BINK Robin", "Inkian Jason", "Stephanie BINK", "BatBINK"];
function parseUsers(str) {
  return (str || "").split(/[,\n]/).map(s => s.trim().replace(/^User(?:[ _]talk)?\s*:\s*/i, "").trim()).filter(Boolean);
}
function projAgency(proj) {
  if (!proj) return [];
  if (Array.isArray(proj.agency)) return proj.agency;
  return AGENCY_ROSTER.slice();
}
function effectiveUsers(proj) {
  const seen = new Set(), out = [];
  projAgency(proj).concat(parseUsers(proj && proj.team)).forEach(u => {
    const key = u.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(u); }
  });
  return out;
}
async function getProjects() {
  try { return JSON.parse((await db.get("wrt.projects.v2")) || "[]"); } catch (e) { return []; }
}
async function buildBaked(projectName) {
  const projects = await getProjects();
  const proj = projects.find(p => p.name === projectName);
  if (!proj) return null;
  const projClone = JSON.parse(JSON.stringify(proj));
  projClone.team = effectiveUsers(proj).join("\n"); // fold agency in so ownership computes
  delete projClone.agency;                          // never ship the roster selection
  delete projClone.owner;                            // internal staffing assignment, not for clients
  delete projClone.flagOverrides;                     // internal workflow tuning, not for clients
  delete projClone.archived;                          // internal housekeeping, not for clients
  delete projClone.clientGroup;                       // internal grouping, not for clients
  stripCommentAuthors(projClone.manual);             // "who on our team wrote this" is internal, not for clients
  const baked = { client: true, ts: new Date().toISOString(), project: projClone, notes: {}, statuses: {} };
  baked.notes = scrubNotesAuthors(await db.getPrefix("wrt.note::" + projectName + "::"));
  baked.statuses = await db.getPrefix("wrt.status::" + projectName + "::");
  baked.resolved = await db.getPrefix("wrt.resolved::" + projectName + "::");
  baked.groups = await db.getPrefix("wrt.group::" + projectName + "::");
  const ord = await db.get("wrt.order::" + projectName); if (ord !== null) baked.order = ord;
  const hid = await db.get("wrt.hidden::" + projectName); if (hid !== null) baked.hidden = hid;
  const aiPrefix = "sys.aithread::" + projectName + "::";
  const aiRows = await db.getPrefix(aiPrefix);
  baked.ai = {};
  Object.keys(aiRows).forEach(k => { try { baked.ai[k.slice(aiPrefix.length)] = JSON.parse(aiRows[k]); } catch (e) {} });
  return baked;
}
// Comments carry an optional "by" (which internal team member wrote it) purely for
// internal display. Strip it before any client-facing payload leaves the server.
function stripCommentAuthors(manual) {
  if (!Array.isArray(manual)) return;
  manual.forEach(item => {
    if (Array.isArray(item && item.comments)) item.comments = item.comments.map(c => { const { by, ...rest } = c || {}; return rest; });
  });
}
function scrubNotesAuthors(notes) {
  const out = {};
  Object.keys(notes || {}).forEach(k => {
    try {
      const arr = JSON.parse(notes[k]);
      out[k] = Array.isArray(arr) ? JSON.stringify(arr.map(c => { const { by, ...rest } = c || {}; return rest; })) : notes[k];
    } catch (e) { out[k] = notes[k]; }
  });
  return out;
}

/* ---------- client tokens ---------- */
async function clientTokenFor(projectName) {
  let token = await db.get("sys.ct::" + projectName);
  if (!token) {
    token = crypto.randomBytes(24).toString("base64url");
    await db.setMany([
      { k: "sys.ct::" + projectName, v: token },
      { k: "sys.cp::" + token, v: projectName }
    ]);
  }
  return token;
}

/* ---------- client groups: one shared page listing a client's tracker links ---------- */
function effectiveGroup(p) {
  const g = String((p && p.clientGroup) || "").trim();
  if (g) return g;
  const n = String((p && p.name) || ""), i = n.indexOf("|");
  return i > 0 ? n.slice(0, i).trim() : "";
}
async function groupTokenFor(group) {
  let token = await db.get("sys.cg::" + group);
  if (!token) {
    token = crypto.randomBytes(24).toString("base64url");
    await db.setMany([
      { k: "sys.cg::" + group, v: token },
      { k: "sys.gp::" + token, v: group }
    ]);
  }
  return token;
}
function escHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
async function buildGroupPage(group) {
  const projects = await getProjects();
  const members = projects.filter(p => effectiveGroup(p) === group);
  if (!members.length) return null;
  const show = p => {                       // "Coyne × Hilton | Conrad Hotels" reads as "Conrad Hotels" under the Coyne × Hilton heading
    const n = String(p.name || ""), i = n.indexOf("|");
    return (i > 0 && n.slice(0, i).trim() === group) ? n.slice(i + 1).trim() : n;
  };
  const rows = [];
  for (const p of members) rows.push({ label: show(p), archived: !!p.archived, url: "/c/" + await clientTokenFor(p.name) });
  const byLabel = (a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase());
  const active = rows.filter(r => !r.archived).sort(byLabel), done = rows.filter(r => r.archived).sort(byLabel);
  const card = r => '<a class="card" href="' + escHtml(r.url) + '"><span>' + escHtml(r.label) + '</span><span class="arrow" aria-hidden="true">&rarr;</span></a>';
  const logo = (String(INDEX_HTML).match(/window\.__LOGO__="([^"]+)"/) || [])[1] || "";
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">' +
    '<link rel="icon" type="image/png" href="/favicon.ico?v=2">' +
    '<title>' + escHtml(group) + ' | Beutler Ink</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=Castoro:ital@0;1&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">' +
    '<style>' +
    ':root{--bg:#FFF9F2;--ink:#241f1c;--muted:#6f6760;--line:#e6ddd2;--accent:#EA503B}' +
    '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif}' +
    '.wrap{max-width:760px;margin:0 auto;padding:28px 20px 48px}' +
    '.brand img{height:30px;width:auto;display:block}.brand b{font-family:Castoro,Georgia,serif;font-size:20px}' +
    '.eyebrow{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin:10px 0 18px}' +
    'hr{border:0;border-top:2px solid var(--ink);margin:0 0 28px}' +
    'h1{font-family:Castoro,Georgia,serif;font-weight:600;font-size:34px;line-height:1.15;margin:0 0 6px}' +
    '.sub{color:var(--muted);margin:0 0 26px;font-size:15px}' +
    'h2{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin:32px 0 10px;font-weight:700}' +
    '.list{display:flex;flex-direction:column;gap:10px}' +
    'a.card{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:16px 18px;background:#fff;border:1px solid var(--line);border-radius:12px;text-decoration:none;color:var(--ink);font-family:Castoro,Georgia,serif;font-size:18px;font-weight:600}' +
    'a.card:hover,a.card:focus-visible{border-color:var(--accent);outline:none}' +
    'a.card:hover .arrow,a.card:focus-visible .arrow{color:var(--accent)}.arrow{color:var(--muted)}' +
    '.done a.card{background:transparent;font-size:16px;font-weight:500;color:var(--muted)}' +
    '.foot{margin-top:40px;padding-top:14px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted)}' +
    '</style></head><body><div class="wrap">' +
    '<div class="brand">' + (logo ? '<img src="' + logo + '" alt="Beutler Ink">' : '<b>Beutler Ink</b>') + '</div>' +
    '<div class="eyebrow">Wikipedia &middot; edit-request status</div><hr>' +
    '<h1>' + escHtml(group) + '</h1><p class="sub">Choose a project to see where its Wikipedia requests stand.</p>' +
    (active.length ? '<div class="list">' + active.map(card).join("") + '</div>' : '') +
    (done.length ? '<h2>Completed</h2><div class="list done">' + done.map(card).join("") + '</div>' : '') +
    '<div class="foot">Prepared by Beutler Ink &middot; updates live from Wikipedia</div></div></body></html>';
}

/* ---------- AI discussion analysis ---------- */
const VALID_AI_STATUS = new Set(["awaiting", "replied", "partial", "implemented", "declined", "monitored"]);
function aiHash(title, body, ours) {
  return crypto.createHash("sha256")
    .update(AI_PROMPT_VERSION + "\u0000" + (title || "") + "\u0000" + (body || "") + "\u0000" + (ours || []).join(","))
    .digest("hex").slice(0, 40);
}
const AI_SYSTEM =
  "You analyze a single Wikipedia Talk-page edit-request discussion for a PR agency (Beutler Ink) that posts " +
  "conflict-of-interest edit requests on behalf of clients. You will be given the discussion wikitext and the list " +
  "of usernames that belong to the agency ('our accounts'). Return ONLY a JSON object, no prose, no code fences, with keys:\n" +
  "  status: one of awaiting | replied | partial | implemented | declined | monitored\n" +
  "    - awaiting: the request is waiting on an independent editor to act. This INCLUDES the case where an editor " +
  "asked a question or requested changes and Beutler has already answered or resubmitted, so the ball is back in " +
  "the editor's court and no independent editor has yet accepted or rejected the latest version.\n" +
  "    - replied: an independent editor's comment is the MOST RECENT substantive message and it is now Beutler's " +
  "turn to respond (the ball is in Beutler's court). If Beutler has already responded after the editor, use awaiting, not replied.\n" +
  "    - partial: some of the requested changes were made or accepted, but not all\n" +
  "    - implemented: all requested changes were made/accepted\n" +
  "    - declined: the request was rejected or closed without the changes\n" +
  "    - monitored: an open RfC / requested move / broader discussion rather than a simple accept/decline, OR a " +
  "discussion among editors that does not involve any of the agency's accounts at all.\n" +
  "If Beutler and an editor negotiated a different resolution than the original request (for example, an editor " +
  "declined the original ask but implemented an alternative Beutler agreed to), and that alternative was fully " +
  "carried out, use implemented \u2014 the matter is resolved, just not exactly as first proposed. Do not use partial " +
  "for this; partial means part of the SAME request was done, not that a different request was fulfilled in full.\n" +
  "  summary: ONE plain sentence (max 22 words) describing the CURRENT state of the discussion, i.e. what has " +
  "happened most recently, not a restatement of the request title. Refer to any of the agency's own accounts as " +
  "'Beutler'. Refer to other participants by their role ('an editor') or their username. Do not use first person. " +
  "If none of the agency's accounts appear in the discussion at all, describe neutrally what the editors are " +
  "discussing, without implying Beutler made any request. If the actual outcome differs from the original request " +
  "(a negotiated alternative, a partial fix, or a claim that doesn't match what the discussion shows), the summary " +
  "must say what actually happened or was implemented, not just restate the original ask \u2014 e.g. 'Editor removed the " +
  "disputed content instead of updating it, per Beutler's follow-up suggestion' rather than 'Beutler asked to update X.'\n" +
  "The summary is shown to non-technical clients, so write in plain, natural English. Never include wiki markup, " +
  "template names or syntax, code, field names, URLs, or empty quotation marks. Describe what is being changed in " +
  "ordinary words (for example 'update the headquarters location and brand list'), not by quoting the raw request.\n" +
  "Judge partial vs implemented carefully: if an editor did part of the work or agreed to part, use partial.\n" +
  "Do not take a self-reported status at face value: a template parameter, an edit summary, or an editor's own " +
  "words saying a request is 'done', 'complete', or 'answered' is a CLAIM, not proof. Base your judgment on what " +
  "the conversation actually shows was done or agreed. If a claim of completion is not backed up by the discussion " +
  "actually addressing the specific request (or you cannot tell from the text given), do not mark it implemented; " +
  "use partial or awaiting instead, and note the discrepancy in the summary, e.g. 'marked as done but the discussion " +
  "does not show the change being addressed.'";
function aiUserMsg(title, body, ours) {
  return "Agency ('our') accounts: " + ((ours && ours.length) ? ours.join(", ") : "(none specified)") +
    "\n\nRequest title: " + (title || "(untitled)") +
    "\n\nDiscussion wikitext:\n" + String(body || "").slice(0, 40000);
}
function stripFences(t) { return String(t || "").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim(); }
async function analyzeThread(title, body, ours) {
  const r = await fetch(AI_API_URL, {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: AI_MODEL, max_tokens: 300, system: AI_SYSTEM,
      messages: [{ role: "user", content: aiUserMsg(title, body, ours) }]
    })
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("anthropic " + r.status + " " + t.slice(0, 200)); }
  const data = await r.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const parsed = JSON.parse(stripFences(text));
  const status = VALID_AI_STATUS.has(parsed.status) ? parsed.status : "replied";
  const summary = String(parsed.summary || "").replace(/\s+/g, " ").trim().slice(0, 300);
  return { status, summary };
}
function inject(html, scriptBody) {
  const tag = "<script>" + scriptBody + "</scr" + "ipt>";
  return html.replace("</head>", tag + "</head>");
}
function safeJson(obj) {
  return JSON.stringify(obj).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/* ---------- auth ----------
 * The page loads behind Basic Auth. On success we hand out a session cookie so
 * that the app's background save requests (fetch) authenticate via the cookie,
 * which browsers always send, instead of relying on Basic Auth being re-attached
 * to every fetch (which some browsers do not do). */
function sessionToken() {
  return crypto.createHmac("sha256", INTERNAL_PASS + "::" + INTERNAL_USER).update("session-v1").digest("hex");
}
function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function safeEq(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function setSessionCookie(req, res) {
  const https = (req.headers["x-forwarded-proto"] || req.protocol || "").split(",")[0].trim() === "https";
  const parts = ["sess=" + sessionToken(), "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=2592000"];
  if (https) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}
function auth(req, res, next) {
  if (!INTERNAL_USER || !INTERNAL_PASS) {
    return res.status(503).send("Server not configured. Set INTERNAL_USER and INTERNAL_PASS environment variables in Render, then redeploy.");
  }
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.sess && safeEq(cookies.sess, sessionToken())) return next();
  const h = req.headers.authorization || "";
  const m = h.match(/^Basic (.+)$/);
  if (m) {
    const decoded = Buffer.from(m[1], "base64").toString();
    const i = decoded.indexOf(":");
    const u = decoded.slice(0, i), p = decoded.slice(i + 1);
    if (u === INTERNAL_USER && p === INTERNAL_PASS) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Request Tracker"');
  res.status(401).send("Authentication required.");
}

/* ---------- routes ---------- */
const app = express();
app.use(express.json({ limit: "6mb" }));

app.get("/healthz", (req, res) => res.json({ ok: true }));

// Some browsers request /favicon.ico directly regardless of the <link rel="icon">
// tag in the page head; serve the same pen-nib mark there too.
const FAVICON_PNG = Buffer.from(
  "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",
  "base64"
);
app.get("/favicon.ico", (req, res) => { res.set("Content-Type", "image/png"); res.set("Cache-Control", "public, max-age=86400"); res.send(FAVICON_PNG); });


// Internal app (full access)
// Internal app shell (public HTML/JS, no data). The app logs in and fetches
// state itself via the authenticated API, sending credentials on every request.
app.get("/", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const cfg = { mode: "internal", origin: baseUrl(req) };
  const html = inject(INDEX_HTML, "window.__CONFIG__=" + safeJson(cfg) + ";");
  res.type("html").send(html);
});

// Lightweight credential check for the app's login form.
app.get("/api/ping", auth, (req, res) => res.json({ ok: true }));

// Read shared state (for login, polling, initial sync)
app.get("/api/state", auth, async (req, res) => {
  try {
    res.json(await appSnapshot());
  } catch (e) {
    console.error("read error:", e.message);
    res.status(500).json({ ok: false, error: "read failed" });
  }
});

// Write shared state (batched key ops)
app.post("/api/state", auth, async (req, res) => {
  const ops = Array.isArray(req.body && req.body.ops) ? req.body.ops : [];
  const clean = ops.filter(o => o && typeof o.k === "string" && isAppKey(o.k));
  try {
    await db.setMany(clean.map(o => ({ k: o.k, v: o.v })));
    res.json({ ok: true, written: clean.length });
  } catch (e) {
    console.error("write error:", e.message);
    res.status(500).json({ ok: false, error: "write failed" });
  }
});

// AI discussion analysis (status + summary), cached per discussion content
app.post("/api/analyze", auth, async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.json({ enabled: false });
  const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 40) : [];
  const ours = Array.isArray(req.body && req.body.ours) ? req.body.ours : [];
  const project = String((req.body && req.body.project) || "");
  const force = !!(req.body && req.body.force);
  const results = {};
  // small concurrency limit so we don't hammer the API
  const queue = items.slice();
  async function worker() {
    while (queue.length) {
      const it = queue.shift();
      if (!it || typeof it.id !== "string") continue;
      const title = String(it.title || ""), body = String(it.body || "");
      if (!body.trim()) continue;
      const hash = aiHash(title, body, ours);
      const cacheKey = "sys.ai::" + hash;
      try {
        let rec = null;
        if (!force) { const cached = await db.get(cacheKey); if (cached) rec = JSON.parse(cached); }
        if (!rec) { rec = await analyzeThread(title, body, ours); await db.setMany([{ k: cacheKey, v: JSON.stringify(rec) }]); }
        results[it.id] = rec;
        // also store keyed by thread so client links (which have no AI access) can reuse it
        if (project) {
          const hideKey = it.id.replace(/^w:/, "");
          await db.setMany([{ k: "sys.aithread::" + project + "::" + hideKey, v: JSON.stringify(rec) }]);
        }
      } catch (e) {
        console.error("analyze error:", e.message);
        results[it.id] = { error: true };
      }
    }
  }
  try {
    await Promise.all([worker(), worker(), worker()]);
    res.json({ enabled: true, results });
  } catch (e) {
    console.error("analyze batch error:", e.message);
    res.status(500).json({ enabled: true, error: "analyze failed", results });
  }
});

/* ---------- matching planned (pre-loaded) requests to threads that were actually posted ---------- */
const MATCH_PROMPT_VERSION = "m1";
const MATCH_SYSTEM =
  "You help a PR agency track Wikipedia edit requests. The team writes PLANNED requests in advance as short internal labels, " +
  "then later posts the real request on a Wikipedia talk page under whatever heading the author chose (often prefixed with " +
  "'Request:' or 'Edit request:'). Decide which POSTED thread, if any, is the same request as each PLANNED one.\n\n" +
  "The wording will rarely be identical. Match on substance: the same article section, topic, or change being asked for. " +
  "Matching only because both concern the same company, product or article is NOT enough, and two different asks about " +
  "different sections must stay separate. Each posted thread can match at most one planned request, and each planned " +
  "request at most one thread. When unsure, leave it unmatched: a wrong match hides a planned request, while a missed match is easy to fix by hand.\n\n" +
  "Input is JSON: {\"planned\":[{\"id\",\"title\",\"note\"}],\"posted\":[{\"key\",\"heading\",\"gist\"}]}. Reply with ONLY JSON, no prose and no code fences: " +
  "{\"matches\":[{\"id\":\"<planned id>\",\"key\":\"<posted key>\",\"confidence\":\"high\"|\"medium\"}]}. " +
  "Use \"high\" when the subject clearly matches and \"medium\" when it likely matches but the wording differs a lot. " +
  "Leave out anything weaker. Return {\"matches\":[]} if nothing matches.";
async function matchPlanned(planned, posted) {
  const r = await fetch(AI_API_URL, {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: AI_MODEL, max_tokens: 700, system: MATCH_SYSTEM,
      messages: [{ role: "user", content: JSON.stringify({ planned, posted }) }]
    })
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("anthropic " + r.status + " " + t.slice(0, 200)); }
  const data = await r.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const parsed = JSON.parse(stripFences(text));
  const ids = new Set(planned.map(p => p.id)), keys = new Set(posted.map(p => p.key));
  const usedId = new Set(), usedKey = new Set(), out = [];
  for (const m of (Array.isArray(parsed.matches) ? parsed.matches : [])) {
    const id = String(m && m.id), key = String(m && m.key), conf = m && m.confidence;
    if (!ids.has(id) || !keys.has(key) || usedId.has(id) || usedKey.has(key)) continue;   // ignore anything invented or double-booked
    if (conf !== "high" && conf !== "medium") continue;
    usedId.add(id); usedKey.add(key); out.push({ id, key, confidence: conf });
  }
  return out;
}
app.post("/api/match", auth, async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.json({ enabled: false, matches: [] });
  const clip = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);
  const planned = (Array.isArray(req.body && req.body.upcoming) ? req.body.upcoming : []).slice(0, 25)
    .map(u => ({ id: clip(u && u.id, 40), title: clip(u && u.title, 200), note: clip(u && u.note, 300) })).filter(u => u.id && u.title);
  const posted = (Array.isArray(req.body && req.body.threads) ? req.body.threads : []).slice(0, 60)
    .map(t => ({ key: clip(t && t.key, 300), heading: clip(t && t.heading, 200), gist: clip(t && t.gist, 300) })).filter(t => t.key && t.heading);
  if (!planned.length || !posted.length) return res.json({ enabled: true, matches: [] });
  const cacheKey = "sys.match::" + crypto.createHash("sha256").update(MATCH_PROMPT_VERSION + "\u0000" + JSON.stringify(planned) + "\u0000" + JSON.stringify(posted)).digest("hex").slice(0, 40);
  try {
    const cached = await db.get(cacheKey);
    if (cached) return res.json({ enabled: true, matches: JSON.parse(cached) });
    const matches = await matchPlanned(planned, posted);
    await db.setMany([{ k: cacheKey, v: JSON.stringify(matches) }]);
    res.json({ enabled: true, matches });
  } catch (e) {
    console.error("match error:", e.message);
    res.json({ enabled: true, matches: [], error: true });     // best-effort: planned items simply stay where they are
  }
});

// Get (or create) the shared link for a client group
app.get("/api/grouplink", auth, async (req, res) => {
  try {
    const group = (req.query.group || "").toString().trim();
    if (!group) return res.status(400).json({ ok: false, error: "missing group" });
    const projects = await getProjects();
    if (!projects.some(p => effectiveGroup(p) === group)) return res.status(404).json({ ok: false, error: "unknown group" });
    const token = await groupTokenFor(group);
    res.json({ ok: true, url: baseUrl(req) + "/c/" + token, token });
  } catch (e) {
    console.error("grouplink error:", e.message);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

// Get (or create) a client link for a project
app.get("/api/clientlink", auth, async (req, res) => {
  try {
    const project = (req.query.project || "").toString();
    if (!project) return res.status(400).json({ ok: false, error: "missing project" });
    const projects = await getProjects();
    if (!projects.find(p => p.name === project)) return res.status(404).json({ ok: false, error: "unknown project" });
    const token = await clientTokenFor(project);
    res.json({ ok: true, url: baseUrl(req) + "/c/" + token, token });
  } catch (e) {
    console.error("clientlink error:", e.message);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

// Client link (read-only, one sanitized project)
app.get("/c/:token", async (req, res) => {
  try {
    const project = await db.get("sys.cp::" + req.params.token);
    if (!project) {
      const group = await db.get("sys.gp::" + req.params.token);       // not a project link: maybe a client-group link
      if (group) {
        const page = await buildGroupPage(group);
        if (!page) return res.status(404).send("This client link is no longer available.");
        res.set("Cache-Control", "no-store");
        return res.type("html").send(page);
      }
      return res.status(404).send("This client link is not valid.");
    }
    const baked = await buildBaked(project);
    if (!baked) return res.status(404).send("This project is no longer available.");
    res.set("Cache-Control", "no-store");
    const html = inject(INDEX_HTML, "window.__BAKED__=" + safeJson(baked) + ";");
    res.type("html").send(html);
  } catch (e) {
    console.error("client page error:", e.message);
    res.status(500).send("Something went wrong loading this link. Please try again shortly.");
  }
});

function baseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  return proto + "://" + req.get("host");
}

/* ---------- boot ---------- */
initDb().then(() => {
  app.listen(PORT, () => console.log("listening on " + PORT));
}).catch(e => {
  console.error("failed to start:", e.message);
  process.exit(1);
});
