// Modèle de Poisson calé sur les cotes réelles du marché (probabilités sans marge)
export const pois = (k, l) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; };
export function grid(lh, la) {
  let w = 0, d = 0, l = 0, o15 = 0, o25 = 0, bt = 0;
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) {
    const p = pois(i, lh) * pois(j, la);
    if (i > j) w += p; else if (i === j) d += p; else l += p;
    if (i + j >= 2) o15 += p; if (i + j >= 3) o25 += p; if (i > 0 && j > 0) bt += p;
  }
  const t = w + d + l;
  return { w: w / t, d: d / t, l: l / t, o15: o15 / t, o25: o25 / t, u25: 1 - o25 / t, btts: bt / t };
}
// Cale le total de buts sur "plus de 2.5" (si dispo) puis la répartition domicile/extérieur sur le 1N2
export function fit({ pH, pA, pO }) {
  let T = 2.6;
  if (pO > 0 && pO < 1) { let lo = 1, hi = 5; for (let i = 0; i < 40; i++) { T = (lo + hi) / 2; grid(T / 2, T / 2).o25 < pO ? lo = T : hi = T; } }
  let best = 0.5, bd = 9;
  for (let s = 0.12; s <= 0.88; s += 0.005) { const g = grid(T * s, T * (1 - s)), d = Math.abs(g.w - pH) + Math.abs(g.l - pA); if (d < bd) { bd = d; best = s; } }
  return { lh: T * best, la: T * (1 - best), T };
}
export const level = p => (p >= 0.7 ? "eleve" : p >= 0.6 ? "moyen" : "faible");
export const evalPick = (t, a, b) => ({ "1": a > b, "2": b > a, "1X": a >= b, "X2": b >= a, O15: a + b >= 2, O25: a + b >= 3, U25: a + b <= 2, BTTS: a > 0 && b > 0 })[t];
export function predict(ev) {
  const { lh, la, T } = fit(ev.cons), g = grid(lh, la), B = ev.cons.best || {};
  const C = [], add = (t, label, p, o) => { const od = o || 0.92 / p; if (od >= 1.15 && p >= 0.5) C.push({ t, label, p: +p.toFixed(3), od: +od.toFixed(2), real: !!o }); };
  add("1", "Victoire " + ev.home, g.w, B.h?.o); add("2", "Victoire " + ev.away, g.l, B.a?.o);
  add("1X", ev.home + " ou nul", g.w + g.d); add("X2", ev.away + " ou nul", g.l + g.d);
  add("O15", "Plus de 1.5 buts", g.o15); add("O25", "Plus de 2.5 buts", g.o25, B.o?.o); add("U25", "Moins de 2.5 buts", g.u25, B.u?.o);
  add("BTTS", "Les 2 équipes marquent", g.btts);
  C.sort((x, y) => y.p - x.p);
  return { at: Date.now(), lh: +lh.toFixed(2), la: +la.toFixed(2), probs: { ...g, ht: 1 - Math.exp(-0.45 * T) }, picks: C.slice(0, 3), pick: C[0] || null,
    outcome: g.w >= g.d && g.w >= g.l ? "h" : g.l >= g.d ? "a" : "d" };
}
