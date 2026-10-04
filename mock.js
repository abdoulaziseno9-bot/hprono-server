// Données fictives (même format que The Odds API) pour tester sans clé
const T0 = Date.now();
const E = [["Rouges FC", "Bleus FC", 2500], ["Lions", "Aigles", 3500], ["Tigres", "Requins", 4500], ["Nord United", "Sud City", 86400000], ["Est Club", "Ouest Club", 172800000]];
const price = (b, i, k) => +(1.5 + ((i * 7 + b * 3 + k * 5) % 17) / 8 + (k === 1 ? 0.9 : 0)).toFixed(2);
export const mockApi = {
  sports: async () => [{ key: "soccer_mock", title: "Championnat démo", active: true }],
  odds: async () => E.map(([h, a, d], i) => ({
    id: "mock" + i, sport_key: "soccer_mock", sport_title: "Championnat démo", commence_time: new Date(T0 + d).toISOString(), home_team: h, away_team: a,
    bookmakers: ["Alpha", "Beta", "Gamma"].map((t, b) => ({ key: t.toLowerCase(), title: t, markets: [
      { key: "h2h", outcomes: [{ name: h, price: price(b, i, 0) }, { name: a, price: i === 1 && b === 2 ? 6.5 : price(b, i, 2) + 0.4 }, { name: "Draw", price: price(b, i, 1) + 1.2 }] },
      { key: "totals", outcomes: [{ name: "Over", price: 1.8 + b * 0.05, point: 2.5 }, { name: "Under", price: 2.0 - b * 0.04, point: 2.5 }] }] }))
  })),
  scores: async () => E.map(([h, a, d], i) => ({ id: "mock" + i, home_team: h, away_team: a, completed: T0 + d < Date.now() - 500,
    scores: T0 + d < Date.now() - 500 ? [{ name: h, score: String((i + 1) % 3) }, { name: a, score: String(i % 2) }] : null }))
};
