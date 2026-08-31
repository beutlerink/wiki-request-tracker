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
const AI_PROMPT_VERSION = "v4";  // bump to invalidate cached AI reads after a prompt change
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
const LOCAL_ONLY_KEYS = new Set(["wrt.current.v2", "wrt.whoami", "wrt.ownerfilter", "wrt.listsort"]);
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
  "  summary: ONE plain sentence (max 22 words) describing the CURRENT state of the discussion, i.e. what has " +
  "happened most recently, not a restatement of the request title. Refer to any of the agency's own accounts as " +
  "'Beutler'. Refer to other participants by their role ('an editor') or their username. Do not use first person. " +
  "If none of the agency's accounts appear in the discussion at all, describe neutrally what the editors are " +
  "discussing, without implying Beutler made any request.\n" +
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
    "\n\nDiscussion wikitext:\n" + String(body || "").slice(0, 8000);
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
    if (!project) return res.status(404).send("This client link is not valid.");
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
