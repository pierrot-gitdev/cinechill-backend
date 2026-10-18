// Mesure A : retrouver des coups de cœur cachés.
//
// Pour chaque compte qui a au moins cinq coups de cœur sur la carte, on en
// cache un cinquième au hasard, on reconstruit tout sans eux, et on regarde
// où chaque méthode les classe parmi tous les films de la carte que le
// compte n'a pas dans sa galerie : sans tirage d'échantillon, qui peut
// inverser un classement (Krichene et Rendle, 2020). Pas de coupe par date :
// la date d'un swipe n'est pas celle du visionnage.
//
// Quatre méthodes : la popularité seule, la fiche d'aujourd'hui (la moyenne
// des trois ressemblances les plus fortes aux coups de cœur), EASE (Steck,
// 2019 ; une seule valeur à régler, essayée sur trois) et la carte,
// reconstruite sur les seules galeries d'entraînement. Le résultat est
// découpé par notoriété (tiers du nombre de votes), pour ne pas récompenser
// une méthode qui ne propose que des succès.
//
// Seuil de la proposition du 18 octobre : la carte retrouve au moins 20 % de
// coups de cœur cachés de plus que la fiche dans ses 50 premiers films, sans
// perdre sur les films peu connus.
//
// Depuis `functions/`, après `npm run build` :
//   node scripts/carte/measure.mjs --export export.json --carte carte.json
//     [--seeds 5] [--top 50] [--iterations 10]
// `export.json` vient de `export-galleries.mjs` ; la carte ne sert ici que
// pour sa liste de films et leurs fiches : elle est refaite à chaque tirage.

import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';

const require = createRequire(import.meta.url);
const M = require('../../lib/carte/model.js');
const C = require('../../lib/carte/catalog.js');
const F = require('../../lib/cinematch/fiche.js');
const L = require('../../lib/carte/linalg.js');

function arg(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
}
if (!arg('export') || !arg('carte')) {
  console.error('Usage : node scripts/carte/measure.mjs --export <export.json> --carte <carte.json>');
  process.exit(2);
}
const SEEDS = Number(arg('seeds', 5));
const TOP = Number(arg('top', 50));
const HIDE = 0.2;
const EASE_LAMBDAS = [10, 100, 500];

const raw = JSON.parse(readFileSync(arg('carte'), 'utf8'));
const carte = M.decodeCarte({manifest: raw.manifest,
  chunks: raw.chunks.map((c) => Buffer.from(c, 'base64'))});
const films = carte.films;
const n = films.length;
const params = {...M.DEFAULT_CARTE_PARAMS,
  iterations: Number(arg('iterations', M.DEFAULT_CARTE_PARAMS.iterations))};

// Les galeries de films, sur la carte seulement.
const exported = JSON.parse(readFileSync(arg('export'), 'utf8'));
const galleries = exported.users
    .map((u) => u.gallery.filter((m) => m.type === 'movie' && carte.index.has(m.id))
        .map((m) => ({id: m.id, loved: m.loved, disliked: m.disliked})))
    .filter((g) => g.length > 0);
const eligible = galleries.map((g, u) => u)
    .filter((u) => galleries[u].filter((m) => m.loved && !m.disliked).length >= 5);
console.log(`${galleries.length} galeries de films, ${eligible.length} avec au moins cinq coups de cœur sur la carte ; ` +
  `${n} films ; ${SEEDS} tirages ; rappel dans les ${TOP} premiers`);
if (eligible.length === 0) {
  console.log('Pas assez de données pour mesurer.');
  process.exit(0);
}

// Notoriété : tiers du nombre de votes sur la carte.
const votes = films.map((f) => f.voteCount).sort((a, b) => a - b);
const cut1 = votes[Math.floor(n / 3)];
const cut2 = votes[Math.floor((2 * n) / 3)];
const tierOf = (row) => films[row].voteCount < cut1 ? 0 : films[row].voteCount < cut2 ? 1 : 2;
const TIERS = ['peu connus', 'moyens', 'très connus'];

const fiches = films.map(C.ficheOfCarteFilm);
const comparer = new F.FicheComparer(F.buildRarity(fiches));

/** Le rang de chaque film caché dans un classement (scores, plus haut = mieux). */
function hitsAt(scores, exclude, hidden) {
  // Le rang d'un film caché = nombre de candidats qui le battent.
  const out = [];
  for (const h of hidden) {
    let better = 0;
    const s = scores[h];
    for (let i = 0; i < n; i++) {
      if (i === h || exclude.has(i)) continue;
      if (scores[i] > s || (scores[i] === s && i < h)) better++;
    }
    out.push(better < TOP);
  }
  return out;
}

/** EASE : B = I − P · diag(1/diag P), P = (XᵀX + λI)⁻¹, sur les films vus. */
function easeScores(train, lambda) {
  const items = [...new Set(train.flatMap((g) => g.filter((m) => !m.disliked).map((m) => carte.index.get(m.id))))];
  const pos = new Map(items.map((row, j) => [row, j]));
  const m = items.length;
  const g = new Float64Array(m * m);
  for (const gallery of train) {
    const cols = gallery.filter((x) => !x.disliked).map((x) => pos.get(carte.index.get(x.id)));
    for (const a of cols) for (const b of cols) g[a * m + b] += 1;
  }
  for (let j = 0; j < m; j++) g[j * m + j] += lambda;
  const p = L.inverseSpd(g, m);
  return (gallery) => {
    const scores = new Float64Array(n).fill(-1e9);
    const cols = gallery.filter((x) => !x.disliked).map((x) => pos.get(carte.index.get(x.id)));
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (const a of cols) if (a !== j) s += -p[a * m + j] / p[j * m + j];
      // Un film hors d'EASE garde -1e9 : départagé par la popularité ci-dessous.
      scores[items[j]] = s;
    }
    for (let i = 0; i < n; i++) scores[i] += 1e-9 * films[i].voteCount;
    return scores;
  };
}

const methods = ['popularité', 'fiche', ...EASE_LAMBDAS.map((l) => `EASE λ=${l}`), 'carte'];
const tally = Object.fromEntries(methods.map((k) => [k, {hit: 0, total: 0, tiers: [[0, 0], [0, 0], [0, 0]]}]));

for (let seed = 0; seed < SEEDS; seed++) {
  const random = L.rng(1000 + seed);
  const hiddenOf = new Map();
  const train = galleries.map((g, u) => {
    if (!eligible.includes(u)) return g;
    const hearts = g.filter((m) => m.loved && !m.disliked);
    const shuffled = hearts.map((m) => ({m, r: random()})).sort((a, b) => a.r - b.r).map((x) => x.m);
    const hide = new Set(shuffled.slice(0, Math.max(1, Math.round(HIDE * hearts.length))).map((m) => m.id));
    hiddenOf.set(u, [...hide].map((id) => carte.index.get(id)));
    return g.filter((m) => !hide.has(m.id));
  });
  const built = M.buildCarte(films, train, params, null);
  const ease = EASE_LAMBDAS.map((l) => easeScores(train, l));
  for (const u of eligible) {
    const gallery = train[u];
    const exclude = new Set(gallery.map((m) => carte.index.get(m.id)));
    const hidden = hiddenOf.get(u);
    const record = (name, scores) => {
      const hits = hitsAt(scores, exclude, hidden);
      hits.forEach((hit, j) => {
        const t = tally[name];
        t.total++;
        t.tiers[tierOf(hidden[j])][1]++;
        if (hit) {
          t.hit++;
          t.tiers[tierOf(hidden[j])][0]++;
        }
      });
    };
    record('popularité', Float64Array.from(films, (f) => f.voteCount));

    const hearts = gallery.filter((m) => m.loved && !m.disliked);
    const basis = (hearts.length >= 3 ? hearts : gallery.filter((m) => !m.disliked))
        .map((m) => fiches[carte.index.get(m.id)]);
    const ficheScores = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (exclude.has(i)) continue;
      const sims = basis.map((b) => comparer.similarity(b, fiches[i])).sort((a, b) => b - a).slice(0, 3);
      ficheScores[i] = sims.reduce((s, x) => s + x, 0) / Math.max(1, sims.length);
    }
    record('fiche', ficheScores);

    EASE_LAMBDAS.forEach((l, j) => record(`EASE λ=${l}`, ease[j](gallery)));

    const placed = M.placePerson(built, gallery);
    const carteScores = new Float64Array(n);
    for (let i = 0; i < n; i++) carteScores[i] = L.dot(built.vectors, placed.mean, built.k, i * built.k, 0);
    record('carte', carteScores);
  }
}

const pct = (a, b) => b === 0 ? '   —  ' : `${(100 * a / b).toFixed(1).padStart(5)} %`;
console.log('\nMéthode'.padEnd(16) + `rappel@${TOP}`.padStart(11) + TIERS.map((t) => t.padStart(13)).join(''));
for (const name of methods) {
  const t = tally[name];
  console.log(name.padEnd(15) + pct(t.hit, t.total).padStart(11) +
    t.tiers.map(([h, tot]) => `${pct(h, tot)} (${tot})`.padStart(13)).join(''));
}
const fiche = tally.fiche.hit / Math.max(1, tally.fiche.total);
const carteR = tally.carte.hit / Math.max(1, tally.carte.total);
const lowF = tally.fiche.tiers[0][0] / Math.max(1, tally.fiche.tiers[0][1]);
const lowC = tally.carte.tiers[0][0] / Math.max(1, tally.carte.tiers[0][1]);
console.log(`\nSeuil : carte ≥ 1,2 × fiche (${(100 * carteR).toFixed(1)} % contre ${(120 * fiche).toFixed(1)} % demandés) ` +
  `et pas de perte sur les peu connus (${(100 * lowC).toFixed(1)} % contre ${(100 * lowF).toFixed(1)} %) : ` +
  (carteR >= 1.2 * fiche && lowC >= lowF ? 'atteint.' : 'non atteint.'));
console.log(`${tally.carte.total / SEEDS} coups de cœur cachés par tirage : ` +
  (tally.carte.total / SEEDS < 200 ? 'trop peu pour conclure, le résultat varie d\'un tirage à l\'autre.' : 'assez pour lire un écart de quelques points.'));
