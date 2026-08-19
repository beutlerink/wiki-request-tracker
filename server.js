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
      ssl: isLocal ? false : { rejectUnauthorized: false }
    });
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

/* ---------- html injection ---------- */
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
app.get("/", auth, async (req, res) => {
  setSessionCookie(req, res);
  const state = await appSnapshot();
  const cfg = { mode: "internal", origin: baseUrl(req) };
  const html = inject(INDEX_HTML,
    "window.__CONFIG__=" + safeJson(cfg) + ";window.__STATE__=" + safeJson(state) + ";");
  res.type("html").send(html);
});

// Read shared state (for polling / initial sync)
app.get("/api/state", auth, async (req, res) => {
  res.json(await appSnapshot());
});

// Write shared state (batched key ops)
app.post("/api/state", auth, async (req, res) => {
  const ops = Array.isArray(req.body && req.body.ops) ? req.body.ops : [];
  const clean = ops.filter(o => o && typeof o.k === "string" && isAppKey(o.k));
  try {
    await db.setMany(clean.map(o => ({ k: o.k, v: o.v })));
    res.json({ ok: true, written: clean.length });
  } catch (e) {
    console.error("write error", e.message);
    res.status(500).json({ ok: false, error: "write failed" });
  }
});

// Get (or create) a client link for a project
app.get("/api/clientlink", auth, async (req, res) => {
  const project = (req.query.project || "").toString();
  if (!project) return res.status(400).json({ ok: false, error: "missing project" });
  const projects = await getProjects();
  if (!projects.find(p => p.name === project)) return res.status(404).json({ ok: false, error: "unknown project" });
  const token = await clientTokenFor(project);
  res.json({ ok: true, url: baseUrl(req) + "/c/" + token, token });
});

// Client link (read-only, one sanitized project)
app.get("/c/:token", async (req, res) => {
  const project = await db.get("sys.cp::" + req.params.token);
  if (!project) return res.status(404).send("This client link is not valid.");
  const baked = await buildBaked(project);
  if (!baked) return res.status(404).send("This project is no longer available.");
  const html = inject(INDEX_HTML, "window.__BAKED__=" + safeJson(baked) + ";");
  res.type("html").send(html);
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
