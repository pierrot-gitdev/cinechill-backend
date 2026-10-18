// Vérifications de la carte, sans Firebase ni réseau, sur des films inventés.
//
// À lancer après `npm run build`, depuis `functions/` :
//   node scripts/carte/carte-check.mjs
//
// Quatre familles de films (polars, science-fiction, comédies, animation),
// chacune avec ses mots-clés, ses réalisateurs et ses acteurs ; des personnes
// qui aiment une ou deux familles. On vérifie que la factorisation fait ce
// qu'elle dit : la perte baisse, les voisins sont de la même famille, un film
// absent de toute galerie est placé par sa fiche, une personne est placée
// près de ce qu'elle aime, et la carte se range puis se relit à l'identique.

import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../../lib/carte/als.js');
const M = require('../../lib/carte/model.js');
const L = require('../../lib/carte/linalg.js');
const P = require('../../lib/carte/pipeline.js');
const C = require('../../lib/carte/catalog.js');
const E = require('../../lib/carte/evening.js');
const S = require('../../lib/carte/session.js');

let failures = 0;
let checks = 0;
function check(label, condition, detail = '') {
  checks++;
  if (!condition) {
    failures++;
    console.log(`  ÉCHEC  ${label} ${detail}`);
  }
}

/* ------------------------------------------------------------------ *
 *  L'algèbre
 * ------------------------------------------------------------------ */

{
  const k = 3;
  const a = Float64Array.from([4, 1, 0, 1, 3, 1, 0, 1, 2]);
  const x = Float64Array.from([1, -2, 3]);
  const b = new Float64Array(3);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) b[i] += a[i * 3 + j] * x[j];
  const solved = L.solveSpd(Float64Array.from(a), b, k);
  check('Cholesky résout A x = b', solved.every((v, i) => Math.abs(v - x[i]) < 1e-9), solved);
  const inv = L.inverseSpd(Float64Array.from(a), k);
  let id = true;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let p = 0; p < 3; p++) s += a[i * 3 + p] * inv[p * 3 + j];
      if (Math.abs(s - (i === j ? 1 : 0)) > 1e-9) id = false;
    }
  }
  check('inverse : A A⁻¹ = I', id);

  // Vecteurs propres : A v = λ v pour chaque couple.
  const {values, vectors} = L.symmetricEigen(a, 3);
  let worst = 0;
  for (let e = 0; e < 3; e++) {
    for (let i = 0; i < 3; i++) {
      let av = 0;
      for (let j = 0; j < 3; j++) av += a[i * 3 + j] * vectors[j * 3 + e];
      worst = Math.max(worst, Math.abs(av - values[e] * vectors[i * 3 + e]));
    }
  }
  check('vecteurs propres : A v = λ v', worst < 1e-9, worst);
}

/* ------------------------------------------------------------------ *
 *  Des films et des personnes inventés
 * ------------------------------------------------------------------ */

const FAMILIES = [
  {genres: [80, 53], kw: [101, 102, 103, 104, 105], makers: [201, 202, 203], cast: [301, 302, 303, 304]},
  {genres: [878, 12], kw: [111, 112, 113, 114, 115], makers: [211, 212, 213], cast: [311, 312, 313, 314]},
  {genres: [35], kw: [121, 122, 123, 124, 125], makers: [221, 222, 223], cast: [321, 322, 323, 324]},
  {genres: [16, 10751], kw: [131, 132, 133, 134, 135], makers: [231, 232, 233], cast: [331, 332, 333, 334]},
];
const random = L.rng(7);
const pick = (list, n) => [...list].sort(() => random() - 0.5).slice(0, n);
const films = [];
for (let i = 0; i < 160; i++) {
  const fam = i % 4;
  const f = FAMILIES[fam];
  films.push({
    id: 1000 + i, genres: f.genres, keywords: [...pick(f.kw, 3), 900 + (i % 40)],
    makers: pick(f.makers, 1), sources: [], cast: pick(f.cast, 2), collection: null,
    year: 1990 + (i % 30), runtime: 100, voteCount: 1000, voteAverage: 7, providers: [8],
    fam,
  });
}
// Un film « froid » : dans la famille 0 par sa fiche, dans aucune galerie.
const coldIndex = 157; // 157 % 4 = 1 : famille 1
const galleries = [];
for (let u = 0; u < 60; u++) {
  const liked = u % 4;
  const also = (u + 1) % 4;
  const gallery = [];
  films.forEach((film, i) => {
    if (i === coldIndex) return;
    if (film.fam === liked && random() < 0.7) gallery.push({id: film.id, loved: random() < 0.3, disliked: false});
    else if (film.fam === also && random() < 0.2) gallery.push({id: film.id, loved: false, disliked: false});
  });
  galleries.push(gallery);
}

/* ------------------------------------------------------------------ *
 *  La factorisation
 * ------------------------------------------------------------------ */

{
  const params = {...M.DEFAULT_CARTE_PARAMS, k: 8, iterations: 1};
  const index = new Map(films.map((f, i) => [f.id, i]));
  const rows = [
    ...galleries.map((g) => ({weight: 1, obs: M.galleryObservations(g, index, params)})),
    ...M.traitRows(films, params),
  ];
  const data = A.buildAlsData(films.length, rows);
  let previous = Infinity;
  let decreasing = true;
  let init = null;
  for (let pass = 0; pass < 6; pass++) {
    const result = A.trainAls(data, {...params, iterations: 1}, init);
    const loss = A.alsLoss(data, result, params.k, params.lambda);
    if (loss > previous + 1e-6) decreasing = false;
    previous = loss;
    init = result.items;
  }
  check('la perte baisse à chaque passe', decreasing);
}

const carte = M.buildCarte(films, galleries, {...M.DEFAULT_CARTE_PARAMS, k: 8, iterations: 12});
check('une position par film', carte.vectors.length === films.length * 8);
check('le soutien compte les galeries', carte.support[0] > 10 && carte.support[coldIndex] === 0,
    `${carte.support[0]} / ${carte.support[coldIndex]}`);

let sameFamily = 0;
let total = 0;
for (let i = 0; i < films.length; i += 7) {
  for (const n of M.neighbors(carte, i, 5)) {
    total++;
    if (films[n.row].fam === films[i].fam) sameFamily++;
  }
}
check('les voisins sont de la même famille (≥ 90 %)', sameFamily / total >= 0.9, `${sameFamily}/${total}`);

const coldNeighbors = M.neighbors(carte, coldIndex, 5);
check('un film sans galerie est placé par sa fiche',
    coldNeighbors.every((n) => films[n.row].fam === films[coldIndex].fam),
    coldNeighbors.map((n) => films[n.row].fam).join(','));

// Une personne qui aime les polars (famille 0).
const fan = films.filter((f) => f.fam === 0).slice(0, 12).map((f) => ({id: f.id, loved: true, disliked: false}));
const placed = M.placePerson(carte, fan);
check('une personne placée compte ses films', placed.count === 12);
const scored = films.map((f, i) => ({fam: f.fam, s: L.dot(carte.vectors, placed.mean, 8, i * 8, 0)}))
    .filter((x, i) => !fan.some((g) => g.id === films[i].id))
    .sort((a, b) => b.s - a.s).slice(0, 10);
check('ses dix premiers films sont des polars', scored.every((x) => x.fam === 0), scored.map((x) => x.fam).join(','));
const cov = M.covarianceOf(placed.precision, 8);
check('son incertitude est une matrice symétrique positive',
    cov[0] > 0 && Math.abs(cov[1] - cov[8]) < 1e-9);

// Un « Pas aimé » repousse.
const hater = [...fan, ...films.filter((f) => f.fam === 1).slice(0, 12).map((f) => ({id: f.id, loved: false, disliked: true}))];
const placedHater = M.placePerson(carte, hater);
const sciFi = films.findIndex((f, i) => f.fam === 1 && i > 40);
const before = L.dot(carte.vectors, placed.mean, 8, sciFi * 8, 0);
const after = L.dot(carte.vectors, placedHater.mean, 8, sciFi * 8, 0);
check('un « Pas aimé » éloigne les films qui lui ressemblent', after < before, `${before.toFixed(3)} → ${after.toFixed(3)}`);

/* ------------------------------------------------------------------ *
 *  Ranger et relire
 * ------------------------------------------------------------------ */

carte.films.forEach((f, i) => { f.fetchedDay = 20000 + i; });
const encoded = M.encodeCarte(carte);
const decoded = M.decodeCarte(encoded);
check('la carte rangée tient en morceaux de moins de 1 Mio',
    encoded.chunks.every((c) => c.length <= 900_000) && encoded.manifest.chunks === encoded.chunks.length);
check('la carte se relit : même jour de lecture', decoded.films[7].fetchedDay === 20007);
check('la carte se relit : mêmes films', decoded.films.length === films.length && decoded.films[5].id === films[5].id);
check('la carte se relit : mêmes positions', decoded.vectors.every((v, i) => v === carte.vectors[i]));
check('la carte se relit : même soutien', decoded.support.every((v, i) => v === carte.support[i]));
check('la carte se relit : même proximité',
    Math.abs(M.proximity(decoded, 3, 11) - M.proximity(carte, 3, 11)) < 1e-12);

// Repartir de la carte précédente garde les mêmes voisinages.
const again = M.buildCarte(films, galleries, {...M.DEFAULT_CARTE_PARAMS, k: 8, iterations: 4}, carte);
let kept = 0;
for (let i = 0; i < films.length; i += 9) {
  const a = new Set(M.neighbors(carte, i, 5).map((n) => n.row));
  kept += M.neighbors(again, i, 5).filter((n) => a.has(n.row)).length;
}
check('repartir de la carte précédente garde les voisinages (≥ 60 %)', kept / (Math.ceil(films.length / 9) * 5) >= 0.6, kept);

/* ------------------------------------------------------------------ *
 *  Le recalage sur la carte précédente
 * ------------------------------------------------------------------ */

{
  // Une rotation au hasard (Gram-Schmidt sur des tirages gaussiens).
  const k = 8;
  const q = new Float64Array(k * k);
  for (let j = 0; j < k; j++) {
    const v = Array.from({length: k}, () => L.gaussian(random));
    for (let p = 0; p < j; p++) {
      let d = 0;
      for (let i = 0; i < k; i++) d += v[i] * q[i * k + p];
      for (let i = 0; i < k; i++) v[i] -= d * q[i * k + p];
    }
    const n = Math.hypot(...v);
    for (let i = 0; i < k; i++) q[i * k + j] = v[i] / n;
  }
  const turned = new Float64Array(carte.vectors.length);
  for (let i = 0; i < films.length; i++) {
    for (let b = 0; b < k; b++) {
      let s = 0;
      for (let a = 0; a < k; a++) s += carte.vectors[i * k + a] * q[a * k + b];
      turned[i * k + b] = s;
    }
  }
  const back = M.alignTo(turned, films, carte);
  let worst = 0;
  for (let e = 0; e < back.length; e++) worst = Math.max(worst, Math.abs(back[e] - carte.vectors[e]));
  check('une carte tournée se recale sur la précédente', worst < 1e-4, worst);
}

/* ------------------------------------------------------------------ *
 *  Rassembler les films : un faux TMDB
 * ------------------------------------------------------------------ */

const PROVIDERS = [
  {provider_id: 8, provider_name: 'Netflix'},
  {provider_id: 119, provider_name: 'Amazon Prime Video'},
  {provider_id: 337, provider_name: 'Disney Plus'},
  {provider_id: 381, provider_name: 'Canal+'},
  {provider_id: 999, provider_name: 'Une plateforme inconnue'},
];
check('les plateformes de l\'app se lisent par leur nom TMDB',
    JSON.stringify(C.appProviderIds(PROVIDERS)) === JSON.stringify([8, 119, 337, 381]),
    C.appProviderIds(PROVIDERS));

function fakeTmdb(count, {gone = new Set(), failing = new Set(), delayMs = 0} = {}) {
  const all = Array.from({length: count}, (_, i) => ({
    id: i + 1, year: 1950 + (i % 76), votes: 150 + ((i * 7919) % 30000), runtime: 70 + (i % 90),
  }));
  const calls = {discover: 0, movie: 0};
  return {
    calls,
    source: {
      async discover(q) {
        calls.discover++;
        const from = Number(q['primary_release_date.gte'].slice(0, 4));
        const to = Number(q['primary_release_date.lte'].slice(0, 4));
        let rows = all.filter((f) => f.year >= from && f.year <= to);
        if (q.with_watch_providers) rows = rows.filter((f) => f.id % 3 === Number(q.with_watch_providers) % 3);
        rows.sort((a, b) => b.votes - a.votes || a.id - b.id);
        const page = Number(q.page);
        const total = Math.min(rows.length, 10000);
        return {
          results: rows.slice((page - 1) * 20, page * 20).filter((_, i) => (page - 1) * 20 + i < 10000)
              .map((f) => ({id: f.id, vote_count: f.votes, vote_average: 7.1})),
          total_results: rows.length, total_pages: Math.ceil(total / 20),
        };
      },
      async providers() { return PROVIDERS; },
      async movie(id) {
        calls.movie++;
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (gone.has(id)) return null;
        if (failing.has(id)) throw new Error('réseau');
        const f = all[id - 1];
        return {
          id, genres: [{id: 18}], release_date: `${f.year}-05-01`, runtime: f.runtime,
          vote_average: 6.5, vote_count: f.votes, belongs_to_collection: null,
          keywords: {keywords: [{id: 100 + (id % 9)}]},
          credits: {cast: [{id: 5000 + (id % 13)}], crew: [{id: 7000 + (id % 5), job: 'Director', department: 'Directing'}]},
        };
      },
    },
  };
}

{
  // 12 000 films : plus que les 10 000 qu'une recherche TMDB peut rendre.
  const tmdb = fakeTmdb(12000);
  const first = await P.gatherFilms(tmdb.source, {today: 20000, lastYear: 2025, previous: null, budgetMs: 60000, concurrency: 16});
  check('le catalogue est lu en entier malgré la limite de TMDB', first.films.length === 12000, first.films.length);
  check('chaque film est lu une fois', tmdb.calls.movie === 12000, tmdb.calls.movie);
  check('la réception vient de la liste', first.films[0].voteAverage === 7.1);
  check('les plateformes viennent des recherches par plateforme',
      first.films.find((f) => f.id === 3).providers.join() === '381' &&
      first.films.find((f) => f.id === 5).providers.join() === '8,119', first.films[4].providers);
  check('les films sont triés par identifiant', first.films.every((f, i) => i === 0 || f.id > first.films[i - 1].id));
  check('le compte rendu dit tout lu', first.report.fetched === 12000 && first.report.deferred === 0, JSON.stringify(first.report));

  // Une semaine plus tard : rien n'est relu.
  const previous = {films: first.films};
  const again = fakeTmdb(12000);
  const week = await P.gatherFilms(again.source, {today: 20007, lastYear: 2025, previous, budgetMs: 60000, concurrency: 16});
  check('une semaine plus tard, aucune fiche n\'est relue', again.calls.movie === 0 && week.report.kept === 12000, again.calls.movie);

  // Six mois plus tard : les relectures s'étalent.
  const later = fakeTmdb(12000);
  await P.gatherFilms(later.source, {today: 20000 + 170, lastYear: 2025, previous, budgetMs: 60000, concurrency: 16});
  check('à 170 jours, environ un tiers des fiches est relu', later.calls.movie > 3000 && later.calls.movie < 5000, later.calls.movie);

  // Un film disparu, une lecture qui échoue, un film jamais lu faute de temps.
  const broken = fakeTmdb(300, {gone: new Set([5]), failing: new Set([6, 7])});
  const prev300 = {films: first.films.filter((f) => f.id <= 300 && f.id !== 7).map((f) => ({...f, fetchedDay: 1}))};
  const res = await P.gatherFilms(broken.source, {today: 20000, lastYear: 2025, previous: prev300, budgetMs: 60000, concurrency: 4});
  const ids = new Set(res.films.map((f) => f.id));
  check('un film disparu de TMDB sort de la carte', !ids.has(5));
  check('une lecture échouée garde la fiche précédente', ids.has(6));
  check('une lecture échouée sans fiche précédente attend', !ids.has(7) && res.report.deferred === 1 && res.report.failed === 2,
      JSON.stringify(res.report));

  let t = 0;
  const slow = fakeTmdb(200);
  const timed = await P.gatherFilms(slow.source, {
    today: 20000, lastYear: 2025, previous: null, budgetMs: 50, concurrency: 1, now: () => t++,
  });
  check('le temps imparti arrête la lecture des fiches', timed.films.length < 200 && timed.report.deferred === 200 - timed.films.length,
      JSON.stringify(timed.report));
}

/* ------------------------------------------------------------------ *
 *  Le moteur du soir
 * ------------------------------------------------------------------ */

{
  const params = {...E.DEFAULT_EVENING_PARAMS};
  const k = carte.k;
  const famRows = (f) => films.map((x, i) => i).filter((i) => films[i].fam === f);
  // Quelqu'un qui aime les polars et la science-fiction.
  const gallery = [...famRows(0).slice(0, 15), ...famRows(1).slice(0, 15)]
      .map((i) => ({id: films[i].id, loved: i % 3 === 0, disliked: false}));
  const prior = E.eveningPrior(carte, gallery, params);
  const trace = (p) => { const c = L.inverseSpd(Float64Array.from(p.precision), k); let t = 0; for (let d = 0; d < k; d++) t += c[d * k + d]; return t; };

  // Il choisit un film de science-fiction parmi six (trois polars, trois SF).
  const shownRows = [...famRows(0).slice(20, 23), ...famRows(1).slice(20, 23)];
  const shown = shownRows.map((r) => E.vectorOf(carte, r));
  const after = E.updateChoice(prior, shown, 3, params);
  check('un choix rapproche le point du film pris',
      L.dot(shown[3], after.mean, k) > L.dot(shown[3], prior.mean, k));
  const sfShare = (p) => {
    const scored = films.map((f, i) => ({f: f.fam, s: L.dot(carte.vectors, p.mean, k, i * k, 0)}))
        .sort((a, b) => b.s - a.s).slice(0, 20);
    return scored.filter((x) => x.f === 1).length / 20;
  };
  check('après le choix, la science-fiction passe devant', sfShare(after) > sfShare(prior),
      `${sfShare(prior)} → ${sfShare(after)}`);
  check('un choix resserre le nuage', trace(after) < trace(prior), `${trace(prior).toFixed(4)} → ${trace(after).toFixed(4)}`);
  const none = E.updateChoice(prior, shown, null, params);
  check('« aucun de ceux-là » éloigne le point de tous les films montrés',
      shown.every((y) => L.dot(y, none.mean, k) < L.dot(y, prior.mean, k)));
  const probs = E.choiceProbabilities(prior, shown, params);
  check('les probabilités de réponse font 1', Math.abs(probs.reduce((a, b) => a + b, 0) - 1) < 1e-9 && probs.length === 7);

  // Les tirages suivent le nuage.
  const random = L.rng(99);
  const draws = 4000;
  const m = new Float64Array(k);
  const samples = [];
  for (let t = 0; t < draws; t++) { const e = E.drawPoint(after, random); samples.push(e); for (let d = 0; d < k; d++) m[d] += e[d] / draws; }
  const cov = L.inverseSpd(Float64Array.from(after.precision), k);
  let worstMean = 0;
  for (let d = 0; d < k; d++) worstMean = Math.max(worstMean, Math.abs(m[d] - after.mean[d]) / Math.sqrt(cov[d * k + d]));
  let v00 = 0;
  for (const e of samples) v00 += (e[0] - m[0]) ** 2 / (draws - 1);
  check('les tirages ont la moyenne du nuage', worstMean < 0.1, worstMean);
  check('et sa largeur', Math.abs(v00 / cov[0] - 1) < 0.1, (v00 / cov[0]).toFixed(3));

  // Un écran de la galerie : six films, aucun doublon, une saga une fois.
  const galleryRows = gallery.map((g) => carte.index.get(g.id));
  films[galleryRows[0]].collection = 77;
  films[galleryRows[1]].collection = 77;
  const screen = E.drawScreen(carte, galleryRows, prior, 6, params, L.rng(5));
  check('un écran a six films différents de la galerie',
      screen.length === 6 && new Set(screen).size === 6 && screen.every((r) => galleryRows.includes(r)));
  check('un écran ne montre pas deux films de la même saga',
      screen.filter((r) => films[r].collection === 77).length <= 1);

  // Les cinq.
  const candidateRows = films.map((f, i) => i).filter((i) => !galleryRows.includes(i));
  films[candidateRows[0]].collection = 88;
  films[candidateRows[4]].collection = 88;
  const cands = E.prepareCandidates(carte, candidateRows, (r) => films[r].voteAverage + (r % 5) * 0.1, null, null, params);
  const vecOf = (id) => { const r = carte.index.get(id); return r === undefined ? null : E.vectorOf(carte, r); };
  const anchorEvening = E.eveningFromTouches(carte, prior,
      [{kind: 'anchor', shown: shownRows.map((r) => films[r].id), chosen: films[shownRows[3]].id}], vecOf, params);
  const slate = E.drawSlate(carte, cands, anchorEvening, 5, params, L.rng(11), 100);
  check('cinq films, différents, hors galerie', slate.rows.length === 5 && new Set(slate.rows).size === 5 &&
      slate.rows.every((r) => !galleryRows.includes(r)));
  check('une probabilité d\'affichage par film, entre 0 et 1',
      slate.rows.every((r) => slate.propensity.get(r) >= 0 && slate.propensity.get(r) <= 1));
  const sfInFive = slate.rows.filter((r) => films[r].fam === 1).length;
  check('après un choix de science-fiction, les cinq en sont surtout', sfInFive >= 3, sfInFive);
  const twoSagas = E.expectedSlate(carte, cands, after, 5, params).filter((r) => films[r].collection === 88).length;
  check('les cinq ne montrent qu\'un film d\'une saga', twoSagas <= 1);
  // δ : sans pénalité de ressemblance, les cinq se ressemblent plus.
  const meanCos = (rows) => { let s = 0, n = 0; for (let a = 0; a < rows.length; a++) for (let b = a + 1; b < rows.length; b++) { s += M.proximity(carte, rows[a], rows[b]); n++; } return s / n; };
  const tight = E.expectedSlate(carte, cands, after, 5, {...params, delta: 0});
  const varied = E.expectedSlate(carte, cands, after, 5, {...params, delta: 3});
  check('δ rend les cinq plus variés', meanCos(varied) < meanCos(tight), `${meanCos(tight).toFixed(3)} → ${meanCos(varied).toFixed(3)}`);

  // La règle des écrans.
  check('des réponses qui ne changent rien : zéro film changé',
      E.expectedChange([1, 2, 3, 4, 5], [[1, 2, 3, 4, 5], [5, 4, 3, 2, 1]], [0.5, 0.5]) === 0);
  check('les films changés se pondèrent par la probabilité de la réponse',
      Math.abs(E.expectedChange([1, 2, 3, 4, 5], [[1, 2, 3, 9, 8], [6, 7, 8, 9, 10]], [0.75, 0.25]) - 2.75) < 1e-12);

  // La cible du soir : 60 % du chemin vers la position du film choisi.
  const filmPoint = shown[3];
  const declared = E.declareTargets(carte, prior, [filmPoint], params);
  const ratio = E.spreadOf(carte, prior.mean) / E.spreadOf(carte, filmPoint);
  const scaled = Float64Array.from(filmPoint, (v) => v * ratio);
  // L'étalement se calcule sans parcourir les films : vérifions-le contre le calcul direct.
  const direct = (() => { const v = films.map((f, i) => L.dot(carte.vectors, prior.mean, k, i * k, 0)); const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); })();
  check('l\'étalement des notes, calculé par la covariance', Math.abs(E.spreadOf(carte, prior.mean) - direct) < 1e-6 * Math.max(1, direct), `${E.spreadOf(carte, prior.mean)} / ${direct}`);
  let gap = 0;
  for (let d = 0; d < k; d++) gap = Math.max(gap, Math.abs(declared.mean[d] - (0.4 * prior.mean[d] + 0.6 * scaled[d])));
  check('la cible du soir pèse 60 %', gap < 1e-12, gap);
  check('et resserre le nuage', trace(declared) < trace(prior));
  const vecFor = (id) => { const r = carte.index.get(id); return r === undefined ? null : E.vectorOf(carte, r); };
  const fromTouches = E.eveningFromTouches(carte, prior,
      [{kind: 'anchor', shown: shownRows.map((r) => films[r].id), chosen: films[shownRows[3]].id}], vecFor, params);
  check('le film de départ, relu, fait passer la science-fiction devant', sfShare(fromTouches) > sfShare(prior) && sfShare(fromTouches) >= 0.8,
      `${sfShare(prior)} → ${sfShare(fromTouches)}`);
  const refusedAll = E.eveningFromTouches(carte, prior,
      [{kind: 'refused', shown: [films[shownRows[3]].id], chosen: null}], vecFor, params);
  check('« Pas celui-là » éloigne le point du film', L.dot(shown[3], refusedAll.mean, k) < L.dot(shown[3], prior.mean, k));
  const unknown = E.eveningFromTouches(carte, prior, [{kind: 'anchor', shown: [999999], chosen: 999999}], vecFor, params);
  check('un film sans position ne déplace rien', unknown.mean.every((v, d) => v === prior.mean[d]));

  // Un film hors carte, placé par ses voisins de fiche.
  const target = famRows(2)[3];
  const folded = E.foldIn(carte, (r) => (r !== target && films[r].fam === 2 ? 1 / (1 + Math.abs(r - target)) : 0), 10);
  const near = films.map((f, i) => ({i, s: L.dot(carte.vectors, folded, k, i * k, 0) /
      (M.norm(carte, i) * Math.hypot(...folded))})).sort((a, b) => b.s - a.s).slice(0, 10);
  check('un film hors carte se place parmi ses voisins de fiche', near.filter((x) => films[x.i].fam === 2).length >= 9);
}

/* ------------------------------------------------------------------ *
 *  Relire la soirée, entrelacer
 * ------------------------------------------------------------------ */

{
  const events = [
    {type: 'styles', served: ['thriller', 'drama']},
    {type: 'starters', style: 'thriller', page: 0, served: [1, 2, 3, 4, 5, 6], afterShown: 0},
    {type: 'starters', style: 'thriller', page: 1, served: [7, 8, 9, 10, 11, 12], afterShown: 6},
    {type: 'near', anchorId: 9, served: [20, 21, 22]},
    {type: 'picks', served: [{id: 100}, {id: 101}]},
    {type: 'replace', served: [{id: 102}], refusedIds: [100], seenIds: []},
  ];
  const t = S.touchesFromJournal(events, {anchorId: 9, secondId: 21, refusedIds: [101]});
  check('« Pas ceux-là » : aucun des six premiers', t[0].kind === 'none-of-screen' && t[0].chosen === null && t[0].shown.join() === '1,2,3,4,5,6');
  check('le film de départ, pris parmi son écran', t[1].kind === 'anchor' && t[1].chosen === 9 && t[1].shown.join() === '7,8,9,10,11,12');
  check('le second film, pris parmi les voisins et le film de départ', t[2].kind === 'second' && t[2].chosen === 21 && t[2].shown.join() === '20,21,22,9');
  check('les films écartés, du journal et de la demande', t.slice(3).map((x) => x.shown[0]).join() === '100,101' && t.slice(3).every((x) => x.chosen === null));
  const same = S.touchesFromJournal(events, {anchorId: 9, secondId: null, refusedIds: []});
  check('« Pile comme » : le film de départ pris parmi ses voisins', same[2].kind === 'same' && same[2].chosen === 9);
  const skipped = S.touchesFromJournal([{type: 'starters', served: [1, 2], afterShown: 0}, {type: 'near', anchorId: 2, served: []}],
      {anchorId: 2, secondId: null, refusedIds: []});
  check('un écran de voisins sauté ne compte pas', skipped.length === 1 && skipped[0].kind === 'anchor');
  const any = S.touchesFromJournal(events, {anchorId: null, secondId: null, refusedIds: []});
  check('« Peu importe » : seulement les refus', any.every((x) => x.kind !== 'anchor') && any.some((x) => x.kind === 'refused'));
  const lone = S.touchesFromJournal([], {anchorId: 5, secondId: null, refusedIds: []});
  check('un film de départ sans journal reste un choix', lone.length === 1 && lone[0].shown.join() === '5');

  // Entrelacement.
  const a = [1, 2, 3, 4, 5, 6, 7];
  const b = [3, 8, 9, 1, 10, 11];
  let balanced = true;
  let firstA = 0;
  for (let seed = 0; seed < 200; seed++) {
    const d = S.teamDraft(a, b, ['fiche', 'carte'], 5, L.rng(seed));
    const na = d.filter((x) => x.team === 'fiche').length;
    if (d.length !== 5 || new Set(d.map((x) => x.id)).size !== 5 || Math.abs(na - (5 - na)) > 1) balanced = false;
    if (d[0].team === 'fiche') firstA++;
  }
  check('l\'entrelacement rend cinq films, à parts égales à un près', balanced);
  check('le premier choix revient à l\'un ou l\'autre au hasard', firstA > 70 && firstA < 130, firstA);
  const saga = S.teamDraft([1, 2, 3], [4, 5, 6], ['x', 'y'], 4, L.rng(1), (id) => (id === 1 || id === 4 ? 9 : null));
  check('l\'entrelacement ne prend qu\'un film d\'une saga', saga.filter((x) => x.id === 1 || x.id === 4).length === 1);
  const short = S.teamDraft([1], [2, 3, 4, 5, 6], ['x', 'y'], 5, L.rng(2));
  check('un moteur à court laisse l\'autre compléter', short.length === 5);
}

console.log(`${checks - failures}/${checks} vérifications`);
process.exitCode = failures === 0 ? 0 : 1;
