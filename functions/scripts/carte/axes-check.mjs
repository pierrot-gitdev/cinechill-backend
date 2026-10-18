// Vérifications des axes nommés, sur une carte inventée dont on connaît la
// vraie direction « sombre ».
//
// À lancer après `npm run build`, depuis `functions/` :
//   node scripts/carte/axes-check.mjs

import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const X = require('../../lib/carte/axes.js');
const L = require('../../lib/carte/linalg.js');

let failures = 0;
let checks = 0;
function check(label, condition, detail = '') {
  checks++;
  if (!condition) {
    failures++;
    console.log(`  ÉCHEC  ${label} ${detail}`);
  }
}

const k = 8;
const random = L.rng(31);
function inventedCarte(n, seed) {
  const r = L.rng(seed);
  const vectors = new Float32Array(n * k);
  for (let e = 0; e < vectors.length; e++) vectors[e] = L.gaussian(r);
  const films = Array.from({length: n}, (_, i) => ({id: 1000 + i, voteCount: 10000 - i}));
  return {k, films, vectors, index: new Map(films.map((f, i) => [f.id, i]))};
}
const carte = inventedCarte(400, 5);
// La vraie direction « sombre ».
const truth = Array.from({length: k}, (_, d) => (d === 0 ? 0.8 : d === 1 ? 0.6 : 0));
const unit = (row) => { const y = Array.from(carte.vectors.subarray(row * k, (row + 1) * k)); const n = Math.hypot(...y); return y.map((v) => v / n); };
const darkness = (row) => unit(row).reduce((s, v, d) => s + v * truth[d], 0);

function answers(count, informative = true) {
  const out = [];
  for (let t = 0; t < count; t++) {
    const a = Math.floor(random() * 400);
    let b = Math.floor(random() * 400);
    if (b === a) b = (a + 1) % 400;
    const gap = darkness(a) - darkness(b);
    if (Math.abs(gap) < 0.03) {
      out.push({a: 1000 + a, b: 1000 + b, darker: null});
      continue;
    }
    // Des répondants qui se trompent parfois : σ(6 × écart).
    const pA = informative ? 1 / (1 + Math.exp(-6 * gap)) : 0.5;
    out.push({a: 1000 + a, b: 1000 + b, darker: random() < pA ? 1000 + a : 1000 + b});
  }
  return out;
}

check('corrélation des rangs : 1 pour le même ordre', Math.abs(X.rankCorrelation([1, 2, 3, 4], [10, 20, 30, 40]) - 1) < 1e-12);
check('corrélation des rangs : −1 pour l\'ordre inverse', Math.abs(X.rankCorrelation([1, 2, 3, 4], [4, 3, 2, 1]) + 1) < 1e-12);

const few = X.buildAxis(carte, answers(150), null, L.rng(1));
check('moins de 200 réponses : pas d\'axe', few.direction === null && !few.validated, few.n);

const many = answers(900);
const first = X.buildAxis(carte, many, null, L.rng(2));
const cos = first.direction.reduce((s, v, d) => s + v * truth[d], 0);
check('la direction retrouvée est la bonne', cos > 0.9, cos.toFixed(3));
check('plus de 70 % de paires mises de côté dans le bon ordre', first.heldOut >= 0.7, first.heldOut.toFixed(3));
check('mieux que 200 axes appris sur des réponses mélangées', first.heldOut > first.shuffledBest,
    `${first.heldOut.toFixed(3)} / ${first.shuffledBest.toFixed(3)}`);
check('sans semaine précédente, l\'axe n\'est pas encore validé', !first.validated && first.stability === null);
check('l\'écart type le long de l\'axe est posé', first.spread > 0);

const second = X.buildAxis(carte, [...many, ...answers(100)], {carte, axis: first}, L.rng(3));
check('d\'une semaine à l\'autre, le même classement', second.stability > 0.9, second.stability?.toFixed(3));
check('les trois contrôles passés : l\'axe est validé', second.validated);

const noise = X.buildAxis(carte, answers(900, false), {carte, axis: first}, L.rng(4));
check('des réponses au hasard ne valident pas d\'axe', !noise.validated && noise.heldOut < 0.62, noise.heldOut.toFixed(3));

// Les projections suivent la direction.
const along = X.projections(carte, second.direction);
const order = X.rankCorrelation(Array.from(along), carte.films.map((f, i) => darkness(i)));
check('les films se rangent le long de l\'axe comme la vraie noirceur', order > 0.9, order.toFixed(3));

console.log(`${checks - failures}/${checks} vérifications`);
process.exitCode = failures === 0 ? 0 : 1;
