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
const AI_PROMPT_VERSION = "v2";  // bump to invalidate cached AI reads after a prompt change
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
const CURRENT_KEY = "wrt.current.v2";
function isAppKey(k) { return k.indexOf("wrt.") === 0 && k !== CURRENT_KEY; }

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
  const baked = { client: true, ts: new Date().toISOString(), project: projClone, notes: {}, statuses: {} };
  baked.notes = await db.getPrefix("wrt.note::" + projectName + "::");
  baked.statuses = await db.getPrefix("wrt.status::" + projectName + "::");
  const aiPrefix = "sys.aithread::" + projectName + "::";
  const aiRows = await db.getPrefix(aiPrefix);
  baked.ai = {};
  Object.keys(aiRows).forEach(k => { try { baked.ai[k.slice(aiPrefix.length)] = JSON.parse(aiRows[k]); } catch (e) {} });
  return baked;
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
  "    - awaiting: the request was posted but no independent editor has responded yet\n" +
  "    - replied: an independent editor has responded and discussion is ongoing, no resolution yet\n" +
  "    - partial: some of the requested changes were made or accepted, but not all\n" +
  "    - implemented: all requested changes were made/accepted\n" +
  "    - declined: the request was rejected or closed without the changes\n" +
  "    - monitored: an open RfC / requested move / broader discussion rather than a simple accept/decline\n" +
  "  summary: ONE plain sentence (max 22 words) describing the CURRENT state of the discussion, i.e. what has " +
  "happened most recently, not a restatement of the request title. Refer to any of the agency's own accounts as " +
  "'Beutler'. Refer to other participants by their role ('an editor') or their username. Do not use first person.\n" +
  "The summary is shown to non-technical clients, so write in plain, natural English. Never include wiki markup, " +
  "template names or syntax, code, field names, URLs, or empty quotation marks. Describe what is being changed in " +
  "ordinary words (for example 'update the headquarters location and brand list'), not by quoting the raw request.\n" +
  "Judge partial vs implemented carefully: if an editor did part of the work or agreed to part, use partial.";
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
