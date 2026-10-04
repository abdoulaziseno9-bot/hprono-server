// HpronoIA v2 : cotes, prédictions figées et chaînées, résultats vérifiés, VIP (paiement Orange Money confirmé par l'admin), panneau admin
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { predict, evalPick, level } from "./model.js";
import { mockApi } from "./mock.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
try { for (const l of fs.readFileSync(path.join(DIR, ".env"), "utf8").split("\n")) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; } } catch {}
const C = {
  key: process.env.ODDS_API_KEY || "", port: +process.env.PORT || 3000, regions: process.env.REGIONS || "eu", markets: process.env.MARKETS || "h2h,totals",
  sports: (process.env.SPORTS || "").split(",").filter(Boolean), maxSports: +process.env.MAX_SPORTS || 3, every: +process.env.REFRESH_MIN || 360,
  poll: +process.env.RESULT_POLL_MIN || 10, live: process.env.LIVE === "1", floor: +process.env.CREDIT_FLOOR || 25,
  admin: process.env.ADMIN_TOKEN || "", trust: process.env.TRUST_PROXY === "1"
};
const MOCK = !C.key || process.env.MOCK === "1";
const ADMIN_ON = C.admin.length >= 12;
if (!ADMIN_ON) console.warn("[admin] ADMIN_TOKEN absent ou trop court (12 caractères minimum) : le panneau /admin est désactivé.");

// --- base de données (fichier JSON) ---
const DEF = { om: { number: "", name: "", link: "" }, plans: [{ id: "w", name: "VIP 7 jours", days: 7, price: 2000 }, { id: "m", name: "VIP 30 jours", days: 30, price: 5000 }], freePicks: 3 };
const DBF = path.join(DIR, "data", "db.json");
let loaded = {}; try { loaded = JSON.parse(fs.readFileSync(DBF, "utf8")); } catch {}
const db = { events: {}, subs: {}, audit: [], chain: "", seq: 0, ...loaded }; db.settings = { ...DEF, ...(loaded.settings || {}) };
const save = () => { fs.mkdirSync(path.dirname(DBF), { recursive: true }); fs.writeFileSync(DBF + ".tmp", JSON.stringify(db)); fs.renameSync(DBF + ".tmp", DBF); };
const audit = (a, d) => { db.audit.unshift({ t: Date.now(), a, d }); db.audit.length = Math.min(db.audit.length, 500); };
const status = { mode: MOCK ? "démo (données fictives)" : "direct", lastOdds: null, lastScores: null, remaining: null, used: null, error: null, sports: [] };

// --- API cotes (The Odds API v4) ---
const BASE = "https://api.the-odds-api.com/v4";
async function call(p, q = {}) {
  const u = new URL(BASE + p); u.searchParams.set("apiKey", C.key); for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  const r = await fetch(u); const rem = r.headers.get("x-requests-remaining"); if (rem != null) { status.remaining = +rem; status.used = +r.headers.get("x-requests-used"); }
  if (!r.ok) throw new Error(`API ${r.status} ${p}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}
const api = MOCK ? mockApi : { sports: () => call("/sports"), odds: s => call(`/sports/${s}/odds`, { regions: C.regions, markets: C.markets, oddsFormat: "decimal" }), scores: s => call(`/sports/${s}/scores`, { daysFrom: 3 }) };
const low = () => status.remaining != null && status.remaining < C.floor;

function consensus(e) {
  const H = [], D = [], A = [], O = [], best = {}, up = (k, o, b) => { if (!best[k] || o > best[k].o) best[k] = { o, b }; };
  for (const b of e.bookmakers || []) {
    const h2h = b.markets.find(m => m.key === "h2h");
    if (h2h) { const g = n => h2h.outcomes.find(x => x.name === n)?.price, h = g(e.home_team), a = g(e.away_team), d = g("Draw");
      if (h > 1 && a > 1 && d > 1) { const I = 1 / h + 1 / d + 1 / a; H.push(1 / h / I); D.push(1 / d / I); A.push(1 / a / I); up("h", h, b.title); up("d", d, b.title); up("a", a, b.title); } }
    const t = b.markets.find(m => m.key === "totals");
    if (t) { const ov = t.outcomes.find(x => x.name === "Over" && x.point === 2.5), un = t.outcomes.find(x => x.name === "Under" && x.point === 2.5);
      if (ov && un) { const I = 1 / ov.price + 1 / un.price; O.push(1 / ov.price / I); up("o", ov.price, b.title); up("u", un.price, b.title); } }
  }
  if (!H.length) return null; const av = a => a.reduce((x, y) => x + y, 0) / a.length;
  return { pH: av(H), pD: av(D), pA: av(A), pO: O.length ? av(O) : 0, nb: H.length, best };
}
function arbs(ev) {
  const B = ev.cons.best, out = [], chk = (kind, legs) => { if (legs.some(l => !l.o)) return; const I = legs.reduce((s, l) => s + 1 / l.o, 0);
    if (I < 1) out.push({ id: ev.id, home: ev.home, away: ev.away, league: ev.league, commence: ev.commence, kind, profitPct: +((1 / I - 1) * 100).toFixed(2), I: +I.toFixed(4), legs: legs.map(l => ({ name: l.n, odds: l.o, bookmaker: l.b, share: +((1 / l.o) / I).toFixed(4) })) }); };
  chk("1N2", [{ n: ev.home, ...B.h }, { n: "Nul", ...B.d }, { n: ev.away, ...B.a }]);
  if (B.o && B.u) chk("Plus/Moins 2.5", [{ n: "Plus de 2.5", ...B.o }, { n: "Moins de 2.5", ...B.u }]);
  return out;
}

// --- registre des prédictions : chaque prédiction est figée puis chaînée par hachage ---
const hashOf = (prev, e) => crypto.createHash("sha256").update([prev, e.id, e.home, e.away, e.pred.c0, e.pred.at, e.pred.pick?.t, e.pred.pick?.p, e.pred.seq].join("|")).digest("hex");
function seal(e) { const p = e.pred; p.c0 = e.commence; p.seq = ++db.seq; p.prev = db.chain || "genesis"; p.hash = hashOf(p.prev, e); db.chain = p.hash; }
function verifyChain() {
  let prev = "genesis"; const L = Object.values(db.events).filter(e => e.pred?.hash).sort((a, b) => a.pred.seq - b.pred.seq);
  for (const e of L) { const h = hashOf(prev, e); if (e.pred.prev !== prev || e.pred.hash !== h) return { ok: false, count: L.length, badId: e.id }; prev = h; }
  return { ok: true, count: L.length, head: prev === "genesis" ? null : prev };
}

// --- mises à jour ---
async function refreshOdds() {
  let keys = C.sports;
  if (!keys.length) { const s = await api.sports(); keys = s.filter(x => x.active && x.key.startsWith("soccer_") && !x.has_outrights).map(x => x.key).slice(0, C.maxSports); }
  status.sports = keys; const now = Date.now();
  for (const k of keys) {
    if (low()) { status.error = `Quota bas (${status.remaining} crédits) : mise à jour suspendue`; break; }
    for (const e of await api.odds(k)) {
      const t = Date.parse(e.commence_time); if (t <= now) continue;
      const cons = consensus(e); if (!cons) continue;
      const r = db.events[e.id] ||= { id: e.id, sport: k, league: e.sport_title, home: e.home_team, away: e.away_team, commence: t };
      r.cons = cons; r.commence = t; if (!r.pred) { r.pred = predict(r); seal(r); } r.arbs = arbs(r);
    }
  }
  status.lastOdds = Date.now();
}
async function refreshScores() {
  const now = Date.now(), st = C.live ? 0 : 100 * 60e3;
  const pend = Object.values(db.events).filter(e => !e.result && e.commence + st < now && now < e.commence + 72 * 3600e3);
  for (const k of [...new Set(pend.map(e => e.sport))]) {
    if (low()) break;
    for (const s of await api.scores(k)) {
      const r = db.events[s.id]; if (!r || r.result || !s.scores) continue;
      const g = n => +s.scores.find(x => x.name === n)?.score, gh = g(r.home), ga = g(r.away); if (!Number.isFinite(gh) || !Number.isFinite(ga)) continue;
      if (s.completed) { r.result = { gh, ga, at: Date.now(), src: "api" }; delete r.live; } else r.live = { gh, ga, at: Date.now() };
    }
  }
  status.lastScores = Date.now(); if (pend.length) save();
}
let busyO = false, busyS = false;
const safe = (fn, flag) => async () => { if (flag.v) return; flag.v = true; try { await fn(); status.error = status.error?.startsWith("Quota") ? status.error : null; save(); } catch (e) { status.error = String(e.message || e); console.error("[job]", status.error); } flag.v = false; };
const jobOdds = safe(refreshOdds, { v: false }), jobScores = safe(refreshScores, { v: false });

const day = t => new Date(t).toISOString().slice(0, 10);
function accuracy() {
  const all = Object.values(db.events).filter(e => e.pred?.pick && e.pred.at < e.pred.c0);
  const ev = all.filter(e => e.result).map(e => ({ e, ok: evalPick(e.pred.pick.t, e.result.gh, e.result.ga), o1: e.pred.outcome === (e.result.gh > e.result.ga ? "h" : e.result.gh < e.result.ga ? "a" : "d") }));
  const row = a => ({ n: a.length, hits: a.filter(x => x.ok).length, pct: a.length ? +(a.filter(x => x.ok).length / a.length * 100).toFixed(1) : null, avgConf: a.length ? +(a.reduce((s, x) => s + x.e.pred.pick.p, 0) / a.length * 100).toFixed(1) : null });
  const days = [...new Set(ev.map(x => day(x.e.commence)))].sort().reverse();
  return { total: row(ev), levels: Object.fromEntries(["eleve", "moyen", "faible"].map(l => [l, row(ev.filter(x => level(x.e.pred.pick.p) === l))])),
    days: days.map(d => ({ day: d, ...row(ev.filter(x => day(x.e.commence) === d)) })), outcome1N2: { n: ev.length, hits: ev.filter(x => x.o1).length },
    sources: { api: ev.filter(x => x.e.result.src === "api").length, manuel: ev.filter(x => x.e.result.src === "manuel").length },
    pending: all.filter(e => !e.result && e.pred.c0 + 2 * 3600e3 < Date.now()).length, lastVerified: ev.reduce((m, x) => Math.max(m, x.e.result.at), 0) || null,
    recent: ev.sort((a, b) => b.e.commence - a.e.commence).slice(0, 50).map(x => ({ match: `${x.e.home} – ${x.e.away}`, pick: x.e.pred.pick.label, conf: x.e.pred.pick.p, score: `${x.e.result.gh}-${x.e.result.ga}`, ok: x.ok, src: x.e.result.src, at: x.e.result.at })),
    warning: ev.length < 100 ? `Échantillon de ${ev.length} match(s) vérifié(s) : trop petit pour conclure (viser 100 ou plus).` : null };
}

const ipOf = req => (C.trust && req.headers["x-forwarded-for"]?.split(",")[0].trim()) || req.socket.remoteAddress || "?";
const hits = new Map(), fails = new Map();
const limited = (k, max, win) => { const n = Date.now(), a = (hits.get(k) || []).filter(t => n - t < win); a.push(n); hits.set(k, a); return a.length > max; };
function adminCheck(req) {
  if (!ADMIN_ON) return 503; const ip = ipOf(req), n = Date.now(), a = (fails.get(ip) || []).filter(t => n - t < 9e5); if (a.length >= 8) return 429;
  const t = String(req.headers["x-admin-token"] || ""), ok = t.length === C.admin.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(C.admin));
  if (!ok) { a.push(n); fails.set(ip, a); return 401; } return 200;
}
const vipOf = req => { const c = String(req.headers["x-vip-code"] || "").trim(); return c ? Object.values(db.subs).find(s => s.status === "active" && s.code === c && s.expires > Date.now()) || null : null; };
const genCode = () => { const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let s = ""; for (const b of crypto.randomBytes(10)) s += A[b % A.length]; return `HP-${s.slice(0, 5)}-${s.slice(5)}`; };
const readBody = async req => { let b = ""; for await (const c of req) { b += c; if (b.length > 20000) throw new Error("corps trop volumineux"); } return b ? JSON.parse(b) : {}; };
const send = (res, code, body, type = "application/json; charset=utf-8") => { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const page = (res, f) => send(res, 200, fs.readFileSync(path.join(DIR, "public", f)), "text/html; charset=utf-8");
const pubSub = s => ({ id: s.id, status: s.status, plan: s.planName, at: s.at, expires: s.expires || null });

const handler = async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname;
  try {
    if (p === "/api/status") return send(res, 200, { ...status, events: Object.keys(db.events).length, refreshMin: C.every, pollMin: C.poll, live: C.live });
    if (p === "/api/config") { const o = db.settings.om, link = /^https?:\/\//.test(o.link) ? o.link : ""; return send(res, 200, { plans: db.settings.plans, om: { number: o.number, name: o.name, link }, freePicks: db.settings.freePicks }); }
    if (p === "/api/vip/check") { const s = vipOf(req); return send(res, 200, s ? { vip: true, expires: s.expires, plan: s.planName } : { vip: false }); }
    if (p === "/api/matches") {
      const vip = !!vipOf(req), lg = u.searchParams.get("league"), lv = u.searchParams.get("level"), view = u.searchParams.get("view") || "all", now = Date.now(), RD = 3 * 864e5;
      const all = Object.values(db.events).filter(e => e.pred);
      const st = e => e.result ? "finished" : e.commence > now ? "upcoming" : now < e.commence + 3 * 3600e3 ? "live" : "awaiting";
      const byConf = (a, b) => (b.pred.pick?.p || 0) - (a.pred.pick?.p || 0);
      const upc = all.filter(e => st(e) === "upcoming").sort(byConf), live = all.filter(e => st(e) === "live").sort(byConf);
      const rank = new Map(upc.map((e, i) => [e.id, i]));
      const fin = all.filter(e => ["finished", "awaiting"].includes(st(e)) && e.commence > now - RD).sort((a, b) => b.commence - a.commence);
      const pool = view === "upcoming" ? [...live, ...upc] : view === "finished" ? fin : [...live, ...upc, ...fin];
      const out = pool.filter(e => (!lg || e.league === lg) && (!lv || (e.pred.pick && level(e.pred.pick.p) === lv))).map(e => {
        const s = st(e), r = e.result, b = { id: e.id, league: e.league, home: e.home, away: e.away, commence: e.commence, status: s, live: e.live || null, result: r ? { gh: r.gh, ga: r.ga, src: r.src, at: r.at } : null };
        if (s === "upcoming" && !vip && rank.get(e.id) >= db.settings.freePicks) return { ...b, locked: true };
        return { ...b, bookmakers: e.cons.nb, best: e.cons.best, market: { h: e.cons.pH, d: e.cons.pD, a: e.cons.pA, over25: e.cons.pO || null }, pred: e.pred, level: e.pred.pick ? level(e.pred.pick.p) : null, arb: (e.arbs || []).length > 0,
          verdict: r ? { ok: e.pred.pick ? evalPick(e.pred.pick.t, r.gh, r.ga) : null, picks: (e.pred.picks || []).map(x => evalPick(x.t, r.gh, r.ga)) } : null };
      });
      return send(res, 200, { vip, freePicks: db.settings.freePicks, matches: out });
    }
    if (p === "/api/arbitrage") { const L = Object.values(db.events).filter(e => e.commence > Date.now()).flatMap(e => e.arbs || []).sort((a, b) => b.profitPct - a.profitPct); return send(res, 200, vipOf(req) ? { vip: true, list: L } : { vip: false, count: L.length, list: [] }); }
    if (p === "/api/accuracy") return send(res, 200, accuracy());
    if (p === "/api/ledger") { const n = Math.min(+u.searchParams.get("limit") || 100, 500); return send(res, 200, { chain: verifyChain(), list: Object.values(db.events).filter(e => e.pred?.hash).sort((a, b) => b.pred.seq - a.pred.seq).slice(0, n).map(e => ({ seq: e.pred.seq, match: `${e.home} – ${e.away}`, league: e.league, commence: e.pred.c0, at: e.pred.at, pick: e.pred.pick?.label || null, conf: e.pred.pick?.p || null, hash: e.pred.hash, prev: e.pred.prev, result: e.result ? `${e.result.gh}-${e.result.ga}` : null })) }); }
    if (p === "/api/subscribe" && req.method === "POST") {
      if (limited("sub" + ipOf(req), 5, 3600e3)) return send(res, 429, { error: "trop de demandes, réessaie plus tard" });
      const b = await readBody(req), phone = String(b.phone || "").replace(/[\s.-]/g, ""), ref = String(b.ref || "").trim(), plan = db.settings.plans.find(x => x.id === b.plan);
      if (!/^\+?\d{8,15}$/.test(phone)) return send(res, 400, { error: "numéro de téléphone invalide" });
      if (!/^[A-Za-z0-9._-]{4,40}$/.test(ref)) return send(res, 400, { error: "référence de transaction invalide (4 à 40 caractères)" });
      if (!plan) return send(res, 400, { error: "formule inconnue" });
      if (Object.values(db.subs).some(s => s.ref.toLowerCase() === ref.toLowerCase())) return send(res, 409, { error: "cette référence a déjà été déclarée" });
      const s = { id: crypto.randomBytes(5).toString("hex"), phone, ref, plan: plan.id, planName: plan.name, days: plan.days, amount: plan.price, status: "pending", at: Date.now() };
      db.subs[s.id] = s; audit("abonnement_demande", `${s.id} ${plan.name}`); save(); return send(res, 200, { id: s.id, status: "pending" });
    }
    if (p === "/api/subscribe/status") {
      if (limited("st" + ipOf(req), 30, 3600e3)) return send(res, 429, { error: "trop de requêtes" });
      const phone = (u.searchParams.get("phone") || "").replace(/[\s.-]/g, ""), ref = (u.searchParams.get("ref") || "").trim().toLowerCase();
      const s = Object.values(db.subs).find(x => x.phone === phone && x.ref.toLowerCase() === ref); if (!s) return send(res, 404, { error: "aucune demande trouvée avec ce numéro et cette référence" });
      return send(res, 200, { ...pubSub(s), code: s.status === "active" && s.expires > Date.now() ? s.code : null });
    }
    if (p === "/admin") return page(res, "admin.html");
    if (p.startsWith("/api/admin/")) {
      const c = adminCheck(req); if (c !== 200) return send(res, c, { error: c === 503 ? "admin désactivé" : c === 429 ? "trop d'essais, réessaie dans 15 minutes" : "jeton invalide" });
      if (p === "/api/admin/overview") { const now = Date.now(), A = accuracy(); return send(res, 200, { status: { ...status, events: Object.keys(db.events).length, pollMin: C.poll, live: C.live }, settings: db.settings, chain: verifyChain(), accuracy: A,
        awaiting: Object.values(db.events).filter(e => !e.result && e.commence < now).sort((a, b) => b.commence - a.commence).slice(0, 100).map(e => ({ id: e.id, match: `${e.home} – ${e.away}`, league: e.league, commence: e.commence, pick: e.pred?.pick?.label || null, live: e.live || null })),
        subs: Object.values(db.subs).sort((a, b) => b.at - a.at).slice(0, 200), audit: db.audit.slice(0, 60) }); }
      if (req.method !== "POST") return send(res, 405, { error: "méthode non autorisée" });
      const b = await readBody(req);
      if (p === "/api/admin/refresh") { if (b.what === "scores") await jobScores(); else await jobOdds(); audit("actualisation", b.what || "odds"); return send(res, 200, { ok: true, error: status.error }); }
      if (p === "/api/admin/result") { const r = db.events[b.id]; if (!r || !Number.isInteger(b.gh) || !Number.isInteger(b.ga) || b.gh < 0 || b.ga < 0 || b.gh > 30 || b.ga > 30) return send(res, 400, { error: "id, gh et ga (entiers de 0 à 30) requis" }); if (r.commence > Date.now()) return send(res, 409, { error: "le match n'a pas encore commencé" }); if (r.result?.src === "api") return send(res, 409, { error: "résultat déjà vérifié par l'API : non modifiable" }); audit("resultat_manuel", `${r.home} – ${r.away} : ${r.result ? `${r.result.gh}-${r.result.ga} → ` : ""}${b.gh}-${b.ga}`); r.result = { gh: b.gh, ga: b.ga, at: Date.now(), src: "manuel" }; delete r.live; save(); return send(res, 200, { ok: true }); }
      if (p === "/api/admin/sub") { const s = db.subs[b.id]; if (!s) return send(res, 404, { error: "demande inconnue" }); if (b.action === "approve") { if (s.status === "active") return send(res, 409, { error: "déjà active" }); s.status = "active"; s.code = genCode(); s.expires = Date.now() + s.days * 864e5; } else if (b.action === "reject") s.status = "rejected"; else if (b.action === "revoke") s.status = "revoked"; else if (b.action === "extend" && s.status === "active") s.expires += (Math.min(Math.max(+b.days || 0, 1), 365)) * 864e5; else return send(res, 400, { error: "action invalide" }); audit("abonnement_" + b.action, `${s.id} ${s.phone}`); save(); return send(res, 200, { ok: true, sub: s }); }
      if (p === "/api/admin/settings") { const o = b.om || {}, plans = Array.isArray(b.plans) ? b.plans : null; if (/^javascript:/i.test(o.link || "") || (o.link && !/^https:\/\//.test(o.link))) return send(res, 400, { error: "le lien de paiement doit commencer par https://" }); if (plans && (!plans.length || plans.some(x => !/^[a-z0-9]{1,8}$/.test(x.id) || !(x.days > 0) || !(x.price >= 0) || !String(x.name || "").trim()))) return send(res, 400, { error: "formules invalides (id, nom, durée en jours, prix)" }); db.settings = { om: { number: String(o.number ?? db.settings.om.number).slice(0, 20), name: String(o.name ?? db.settings.om.name).slice(0, 60), link: String(o.link ?? db.settings.om.link).slice(0, 500) }, plans: plans ? plans.map(x => ({ id: x.id, name: String(x.name).slice(0, 40), days: Math.round(+x.days), price: Math.round(+x.price) })) : db.settings.plans, freePicks: Math.min(Math.max(Math.round(+b.freePicks >= 0 ? +b.freePicks : db.settings.freePicks), 0), 20) }; audit("reglages", "mise à jour"); save(); return send(res, 200, { ok: true }); }
      return send(res, 404, { error: "introuvable" });
    }
    if (p === "/" || p === "/index.html") return page(res, "index.html");
    send(res, 404, { error: "introuvable" });
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
};

const app = http.createServer(handler);
if (process.env.VERCEL !== "1") {
  app.listen(C.port, () => { console.log(`HpronoIA sur http://localhost:${C.port}  [mode ${status.mode}]  admin : ${ADMIN_ON ? "/admin" : "désactivé"}`); });
  jobOdds(); setInterval(jobOdds, C.every * 60000); setInterval(jobScores, C.poll * 60000);
}

export default handler;
