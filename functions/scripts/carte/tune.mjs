// Réglage de la carte sur des données collaboratives : les recommandations
// de TMDB.
//
// Le poids de la fiche (ω, `traitScale`) et celui des recommandations
// (`relatedWeight`) se choisissent sur une mesure hors ligne, comme la
// proposition du 18 octobre le prévoit pour les réglages de la carte. Tant
// que nos galeries sont trop peu nombreuses pour la mesure A, les listes de
// recommandations de TMDB en tiennent lieu : chacune est la galerie d'un
// spectateur type d'un film. On en cache un cinquième, on reconstruit la
// carte sans eux, et on regarde si elle les retrouve dans ses 50 premiers
// films, parmi tout le catalogue. Ce ne sont pas des listes écrites à la
// main : c'est le comportement des utilisateurs de TMDB.
//
// Depuis `functions/`, après `npm run build` et `build-local.mjs` :
//   node scripts/carte/tune.mjs --carte carte.json
//     [--scales 1,0.3,0.1,0.03] [--related 1,3] [--users 600]

import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';

const require = createRequire(import.meta.url);
const M = require('../../lib/carte/model.js');
const L = require('../../lib/carte/linalg.js');

function arg(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
}
const raw = JSON.parse(readFileSync(arg('carte'), 'utf8'));
const source = M.decodeCarte({manifest: raw.manifest,
  chunks: raw.chunks.map((c) => Buffer.from(c, 'base64'))});
const films = source.films;
const n = films.length;
const scales = (arg('scales') ?? '1,0.3,0.1,0.03').split(',').map(Number);
const relatedWeights = (arg('related') ?? '1,3').split(',').map(Number);
const USERS = Number(arg('users', 600));
const TOP = 50;

// Les listes à mesurer : celles qui ont au moins 10 films sur la carte.
const random = L.rng(2026);
const lists = films.map((film, i) => ({
  i, items: (film.related ?? []).map((id) => source.index.get(id))
      .filter((row) => row !== undefined && row !== i),
})).filter((l) => l.items.length >= 10);
const sample = lists.map((l) => ({l, r: random()})).sort((a, b) => a.r - b.r)
    .slice(0, USERS).map((x) => x.l);
// Un cinquième de chaque liste échantillonnée est caché.
const hidden = new Map();
for (const l of sample) {
  const shuffled = l.items.map((row) => ({row, r: random()})).sort((a, b) => a.r - b.r).map((x) => x.row);
  hidden.set(l.i, new Set(shuffled.slice(0, Math.round(0.2 * shuffled.length))));
}
const trainFilms = films.map((film, i) => {
  const hide = hidden.get(i);
  if (!hide) return film;
  return {...film, related: film.related.filter((id) => !hide.has(source.index.get(id)))};
});
const votes = films.map((f) => f.voteCount).sort((a, b) => a - b);
const cut = votes[Math.floor(n / 3)];
console.log(`${lists.length} listes d'au moins 10 films ; ${sample.length} mesurées ; ` +
  `${[...hidden.values()].reduce((s, h) => s + h.size, 0)} films cachés`);
console.log('\n   ω   recos   rappel@50   dont peu connus   temps');
for (const traitScale of scales) {
  for (const relatedWeight of relatedWeights) {
    const params = {...M.DEFAULT_CARTE_PARAMS, traitScale, relatedWeight};
    const t0 = Date.now();
    const carte = M.buildCarte(trainFilms, [], params, null);
    let hit = 0;
    let total = 0;
    let lowHit = 0;
    let lowTotal = 0;
    for (const l of sample) {
      const hide = hidden.get(l.i);
      const kept = [l.i, ...l.items.filter((row) => !hide.has(row))];
      const gallery = kept.map((row) => ({id: films[row].id, loved: true, disliked: false}));
      const placed = M.placePerson(carte, gallery);
      const exclude = new Set(kept);
      const scores = new Float64Array(n);
      for (let i = 0; i < n; i++) scores[i] = L.dot(carte.vectors, placed.mean, carte.k, i * carte.k, 0);
      for (const h of hide) {
        let better = 0;
        for (let i = 0; i < n && better < TOP; i++) {
          if (i === h || exclude.has(i)) continue;
          if (scores[i] > scores[h]) better++;
        }
        total++;
        const low = films[h].voteCount < cut;
        if (low) lowTotal++;
        if (better < TOP) {
          hit++;
          if (low) lowHit++;
        }
      }
    }
    console.log(`${String(traitScale).padStart(5)}  ${String(relatedWeight).padStart(5)}` +
      `${(100 * hit / total).toFixed(1).padStart(10)} %` +
      `${(lowTotal ? 100 * lowHit / lowTotal : 0).toFixed(1).padStart(14)} % (${lowTotal})` +
      `${((Date.now() - t0) / 1000).toFixed(0).padStart(7)} s`);
  }
}
