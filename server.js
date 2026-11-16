// Club World Cup picker: first-come club claims for the eFootball tournament.
// Participants pick with no login; the organiser unlocks admin mode with ADMIN_PASSWORD.
// Picks live in Postgres (DATABASE_URL); without it they live in memory (local testing only).
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3081;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const CLUBS = new Set(["realmadrid","mancity","bayern","psg","chelsea","inter","juve","atleti","bvb","porto","benfica","salzburg",
  "palmeiras","flamengo","fluminense","botafogo","river","boca","monterrey","pachuca","seattle","lafc","miami",
  "hilal","urawa","ulsan","alain","ahly","wydad","esperance","sundowns","auckland"]);

// ---------- page (crests inlined once at boot)
const crests = fs.readFileSync(path.join(__dirname, "crests.json"), "utf8");
const page = Buffer.from(fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8").replace("__CRESTS__", crests));
const zlib = require("zlib");
const pageGz = zlib.gzipSync(page);

// ---------- store
let store;
if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : false,
    max: 5,
  });
  store = {
    async init() {
      await pool.query(`create table if not exists picks(
        club text primary key,
        name text not null,
        token text unique,
        at timestamptz not null default now())`);
    },
    async all() {
      const r = await pool.query("select club, name, token, extract(epoch from at)*1000 as at from picks order by at");
      return r.rows.map(x => ({ club: x.club, name: x.name, token: x.token, at: Number(x.at) }));
    },
    // returns "ok" | "club_taken" | "has_pick"
    async claim(club, name, token) {
      const r = await pool.query(
        "insert into picks(club, name, token) values($1,$2,$3) on conflict do nothing returning club", [club, name, token]);
      if (r.rowCount) return "ok";
      const t = await pool.query("select 1 from picks where club=$1", [club]);
      return t.rowCount ? "club_taken" : "has_pick";
    },
    async release(club, token) {
      const r = await pool.query("delete from picks where club=$1 and token=$2", [club, token]);
      return r.rowCount > 0;
    },
    async adminRelease(club) {
      const r = await pool.query("delete from picks where club=$1", [club]);
      return r.rowCount > 0;
    },
    async adminAssign(club, name) {
      const r = await pool.query("insert into picks(club, name, token) values($1,$2,null) on conflict do nothing returning club", [club, name]);
      return r.rowCount ? "ok" : "club_taken";
    },
    async rename(token, name) {
      await pool.query("update picks set name=$2 where token=$1", [token, name]);
    },
  };
} else {
  console.warn("DATABASE_URL not set: picks are kept in memory and vanish on restart.");
  const rows = new Map();
  store = {
    async init() {},
    async all() { return [...rows.values()].sort((a, b) => a.at - b.at); },
    async claim(club, name, token) {
      if (rows.has(club)) return "club_taken";
      for (const r of rows.values()) if (r.token === token) return "has_pick";
      rows.set(club, { club, name, token, at: Date.now() }); return "ok";
    },
    async release(club, token) { const r = rows.get(club); if (r && r.token === token) { rows.delete(club); return true } return false },
    async adminRelease(club) { return rows.delete(club) },
    async adminAssign(club, name) { if (rows.has(club)) return "club_taken"; rows.set(club, { club, name, token: null, at: Date.now() }); return "ok" },
    async rename(token, name) { for (const r of rows.values()) if (r.token === token) r.name = name },
  };
}

// Version bumps on every change so open pages only re-render when something moved.
let version = Date.now();
const bump = () => { version = Math.max(version + 1, Date.now()) };

// ---------- helpers
const send = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
};
const readJson = req => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on("data", c => { n += c.length; if (n > 10_000) { reject(new Error("too_big")); req.destroy() } else chunks.push(c) });
  req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")) } catch (e) { reject(e) } });
  req.on("error", reject);
});
const cleanName = s => String(s || "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 28);
const validToken = t => typeof t === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(t);
const isAdmin = pw => {
  if (!ADMIN_PASSWORD || typeof pw !== "string") return false;
  const a = crypto.createHash("sha256").update(pw).digest(), b = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
};
// small brute-force brake on the admin password
const fails = new Map();
const ipOf = req => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
function adminGate(req, pw) {
  const ip = ipOf(req), f = fails.get(ip) || { n: 0, until: 0 };
  if (f.until > Date.now()) return "locked";
  if (isAdmin(pw)) { fails.delete(ip); return "ok" }
  f.n++; if (f.n >= 5) { f.until = Date.now() + 5 * 60_000; f.n = 0 }
  fails.set(ip, f); return "bad";
}

// Public view of picks: never send other people's tokens; mark the caller's own pick.
async function publicPicks(token) {
  const rows = await store.all();
  return { version, picks: rows.map(r => ({ club: r.club, name: r.name, at: r.at, mine: !!token && r.token === token, manual: r.token === null })) };
}

// ---------- routes
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const gz = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", ...(gz ? { "content-encoding": "gzip" } : {}) });
      return res.end(gz ? pageGz : page);
    }
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });

    if (req.method === "GET" && url.pathname === "/api/picks") {
      const token = url.searchParams.get("t");
      if (url.searchParams.get("v") === String(version)) return send(res, 200, { version, same: true });
      return send(res, 200, await publicPicks(validToken(token) ? token : null));
    }

    if (req.method === "POST" && url.pathname === "/api/claim") {
      const b = await readJson(req);
      const club = String(b.club || ""), name = cleanName(b.name);
      if (!CLUBS.has(club)) return send(res, 400, { error: "unknown_club" });
      if (!name) return send(res, 400, { error: "name_required" });
      if (!validToken(b.token)) return send(res, 400, { error: "bad_token" });
      const r = await store.claim(club, name, b.token);
      if (r === "ok") bump();
      return send(res, r === "ok" ? 200 : 409, { result: r, ...(await publicPicks(b.token)) });
    }

    if (req.method === "POST" && url.pathname === "/api/release") {
      const b = await readJson(req);
      if (!CLUBS.has(String(b.club)) || !validToken(b.token)) return send(res, 400, { error: "bad_request" });
      const ok = await store.release(String(b.club), b.token);
      if (ok) bump();
      return send(res, ok ? 200 : 403, { result: ok ? "ok" : "not_yours", ...(await publicPicks(b.token)) });
    }

    if (req.method === "POST" && url.pathname === "/api/rename") {
      const b = await readJson(req); const name = cleanName(b.name);
      if (!validToken(b.token) || !name) return send(res, 400, { error: "bad_request" });
      await store.rename(b.token, name); bump();
      return send(res, 200, { result: "ok" });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/admin/")) {
      const b = await readJson(req);
      if (!ADMIN_PASSWORD) return send(res, 503, { error: "admin_not_configured" });
      const gate = adminGate(req, b.password);
      if (gate === "locked") return send(res, 429, { error: "locked" });
      if (gate !== "ok") return send(res, 401, { error: "wrong_password" });
      const action = url.pathname.slice("/api/admin/".length);
      if (action === "check") return send(res, 200, { result: "ok" });
      const club = String(b.club || "");
      if (!CLUBS.has(club)) return send(res, 400, { error: "unknown_club" });
      if (action === "release") {
        const ok = await store.adminRelease(club); if (ok) bump();
        return send(res, 200, { result: ok ? "ok" : "already_free", ...(await publicPicks(b.token)) });
      }
      if (action === "assign") {
        const name = cleanName(b.name); if (!name) return send(res, 400, { error: "name_required" });
        const r = await store.adminAssign(club, name); if (r === "ok") bump();
        return send(res, r === "ok" ? 200 : 409, { result: r, ...(await publicPicks(b.token)) });
      }
    }
    send(res, 404, { error: "not_found" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "server_error" });
  }
});

store.init().then(async () => {
  version = Date.now();
  server.listen(PORT, () => console.log("cwc-picker on http://localhost:" + PORT + (ADMIN_PASSWORD ? "" : " (admin disabled: set ADMIN_PASSWORD)")));
}).catch(e => { console.error("DB init failed", e); process.exit(1) });
