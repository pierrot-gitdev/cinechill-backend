// Vérifications du moteur CinéMatch v2, sans Firebase ni réseau.
//
// À lancer après `npm run build`, depuis `functions/` :
//   node scripts/cinematch-engine-check.mjs
//
// Le catalogue est synthétique et déterministe (graine fixe) : un échec se
// rejoue à l'identique. Hors de `src`, ce script n'est ni compilé ni déployé.

import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const E = require('../lib/cinematch/engine.js');

/* ------------------------------------------------------------------ *
 *  Le catalogue synthétique
 * ------------------------------------------------------------------ */

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 8, 15, 20, 0, 0);
const GENRES = [18, 35, 53, 28, 10749, 80, 12, 878, 14, 10751, 16, 99, 36,
  10752, 27, 9648];
const PROVIDERS = [8, 119, 337, 381, 350, 2];
const KEYWORDS = ['feel-good', 'happy ending', 'hope', 'redemption',
  'friendship', 'tragedy', 'death', 'grief', 'suicide', 'inspirational',
  'underdog', 'overcoming adversity', 'heist', 'space', 'small town',
  'revenge', 'road trip', 'coming of age', 'family', 'detective'];
const CERTIFICATIONS = [null, null, null, null, 'U', '10', '12', '16', '18'];

// Une tendance par genre sur les axes, pour que genre et position ne
// soient pas indépendants (sinon « genre commun » ne voudrait rien dire).
const GENRE_BIAS = {
  18: {ch: 0.5, de: 0.4, ry: -0.4}, 35: {ch: -0.6, to: 0.5, de: -0.5},
  53: {ry: 0.6, to: -0.4}, 28: {ry: 0.7, ec: 0.6, de: -0.4},
  10749: {to: 0.4, ec: -0.5}, 80: {ch: 0.4, to: -0.4},
  12: {ec: 0.7, ry: 0.5}, 878: {an: 0.8, de: 0.3}, 14: {an: 0.8, ec: 0.5},
  10751: {ch: -0.7, to: 0.6}, 16: {an: 0.6, to: 0.4}, 99: {an: -0.8, de: 0.6},
  36: {an: -0.7, de: 0.4}, 10752: {ch: 0.8, ec: 0.5}, 27: {ch: 0.4, to: -0.6},
  9648: {de: 0.5},
};

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v) => Math.max(-1, Math.min(1, v));

function makeCatalogue(count, seed) {
  const random = rng(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const films = [];
  for (let i = 0; i < count; i++) {
    const primary = pick(GENRES);
    const genreIds = random() < 0.5 ? [primary] : [primary, pick(GENRES)];
    const bias = GENRE_BIAS[primary] ?? {};
    const axes = {};
    for (const axis of E.ENGINE_AXES) {
      axes[axis] = clamp((bias[axis] ?? 0) + (random() * 2 - 1) * 0.6);
    }
    const runtime = 75 + Math.floor(random() * 105);
    axes.in = clamp((runtime - 120) / 30);
    const providerIds = [...new Set([pick(PROVIDERS), pick(PROVIDERS)])]
        .slice(0, 1 + Math.floor(random() * 2));
    const keywordNames = [];
    const kwCount = Math.floor(random() * 4);
    for (let k = 0; k < kwCount; k++) keywordNames.push(pick(KEYWORDS));
    films.push({
      id: 1000 + i,
      axes,
      genreIds: [...new Set(genreIds)],
      year: 1960 + Math.floor(random() * 66),
      voteCount: Math.floor(100 + random() * 20000),
      runtime: random() < 0.03 ? null : runtime,
      providerIds,
      keywordNames,
      listed: random() < 0.03,
      certification: pick(CERTIFICATIONS),
    });
  }
  return films;
}

// La galerie : des films du catalogue, pour vérifier qu'ils ne sont jamais
// proposés. Les coups de cœur dépendent du profil.
function makeGallery(catalogue, count, seed, lovedRule) {
  const random = rng(seed);
  const pool = [...catalogue];
  const gallery = [];
  while (gallery.length < count && pool.length > 0) {
    const film = pool.splice(Math.floor(random() * pool.length), 1)[0];
    gallery.push({
      id: film.id,
      axes: film.axes,
      genreIds: film.genreIds,
      loved: false,
      posterLastShownAt: random() < 0.3 ?
        NOW - Math.floor(random() * 20) * DAY : null,
    });
  }
  if (lovedRule) {
    const ranked = [...gallery].sort((a, b) => lovedRule(b) - lovedRule(a));
    const lovedCount = Math.max(3, Math.floor(count * 0.25));
    for (const film of ranked.slice(0, lovedCount)) film.loved = true;
  }
  return gallery;
}

const PROFILES = [
  {name: 'cérébral', rule: (f) => f.axes.de - f.axes.ry},
  {name: 'léger', rule: (f) => f.axes.to - f.axes.ch},
  {name: 'sans coup de cœur', rule: null},
];

const SITUATION = {company: 'alone', duration: 'any', platformIds: []};

function baseInput(catalogue, gallery, overrides = {}) {
  return {
    films: catalogue,
    gallery,
    situation: SITUATION,
    want: 'suspense',
    energy: 'high',
    comparisons: [],
    hesitations: 0,
    exposure: new Map(),
    now: NOW,
    ...overrides,
  };
}

// Le classement complet, comme `recommendFive` le calcule avant composition.
function ranking(input) {
  const excludedIds = new Set(input.gallery.map((f) => f.id));
  const filtered = E.applyFilters(input.films, {
    situation: input.situation, excludedIds,
    exposure: input.exposure, now: input.now,
  });
  const loved = input.gallery.filter((f) => f.loved);
  const weights = E.buildWeights(
      loved.map((f) => f.axes),
      filtered.eligible.map((f) => f.axes),
      input.comparisons,
      new Map(input.gallery.map((f) => [f.id, f.axes])),
  );
  const ranked = E.scoreFilms(filtered.eligible, {
    situation: input.situation, want: input.want, energy: input.energy,
    hesitations: input.hesitations, loved, weights,
    exposure: input.exposure, now: input.now,
    conforming: filtered.widened ? filtered.conforming : null,
  });
  return {ranked, weights, filtered};
}

/* ------------------------------------------------------------------ *
 *  Les vérifications
 * ------------------------------------------------------------------ */

let failures = 0;
let checks = 0;
function check(label, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  const mark = ok ? 'OK    ' : 'ÉCHEC ';
  console.log(`${mark} ${label}${detail ? `  (${detail})` : ''}`);
}

const catalogue = makeCatalogue(400, 7);

for (const [index, profile] of PROFILES.entries()) {
  console.log(`\n— Profil « ${profile.name} » —`);
  const gallery = makeGallery(catalogue, 60, 100 + index, profile.rule);
  const galleryIds = new Set(gallery.map((f) => f.id));
  const input = baseInput(catalogue, gallery);
  const five = E.recommendFive(input);
  const ids = five.films.map((s) => s.film.id);

  check('cinq films distincts',
      ids.length === 5 && new Set(ids).size === 5, `${ids.join(', ')}`);
  check('aucun film vu proposé', ids.every((id) => !galleryIds.has(id)));
  check('au plus un film de la watchlist',
      five.films.filter((s) => s.film.listed).length <= 1);

  // Un film montré la veille recule.
  const {ranked} = ranking(input);
  const target = ranked[0].film.id;
  const exposed = ranking({
    ...input,
    exposure: new Map([[target, {
      shownCount: 1, lastShownAt: NOW - DAY, chosenAt: null,
    }]]),
  }).ranked;
  const before = ranked.findIndex((s) => s.film.id === target);
  const after = exposed.findIndex((s) => s.film.id === target);
  check('un film montré la veille recule', after > before,
      `rang ${before + 1} → ${after + 1}`);

  // Montré deux fois, jamais choisi, il y a deux jours : exclu. Choisi :
  // il revient.
  const resting = {shownCount: 2, lastShownAt: NOW - 2 * DAY, chosenAt: null};
  const restFilter = E.applyFilters(catalogue, {
    situation: SITUATION, excludedIds: galleryIds,
    exposure: new Map([[target, resting]]), now: NOW,
  });
  const chosenFilter = E.applyFilters(catalogue, {
    situation: SITUATION, excludedIds: galleryIds,
    exposure: new Map([[target, {...resting, chosenAt: NOW - 3 * DAY}]]),
    now: NOW,
  });
  check('shownCount ≥ 2 sans choix : exclu',
      !restFilter.eligible.some((f) => f.id === target) &&
      chosenFilter.eligible.some((f) => f.id === target));

  // Une comparaison « pick » déplace le classement vers le film gardé.
  let kept = gallery[0];
  let excluded = gallery[1];
  let gap = -1;
  for (const a of gallery) {
    for (const b of gallery) {
      const d = E.filmSimilarity(a.axes, b.axes);
      if (a.id !== b.id && 1 - d > gap) {
        gap = 1 - d; kept = a; excluded = b;
      }
    }
  }
  const direction = (film) => E.ENGINE_AXES.reduce((sum, axis) =>
    sum + film.axes[axis] * (kept.axes[axis] - excluded.axes[axis]), 0);
  const topLean = (list) => list.slice(0, 10)
      .reduce((sum, s) => sum + direction(s.film), 0) / 10;
  const picked = ranking({
    ...input,
    comparisons: [
      {kind: 'pick', keptId: kept.id, excludedId: excluded.id, latencyMs: 700},
    ],
  });
  check('une comparaison pick penche le classement vers le film gardé',
      topLean(picked.ranked) > topLean(ranked),
      `${topLean(ranked).toFixed(3)} → ${topLean(picked.ranked).toFixed(3)}`);

  // « Aucun des quatre » ne change pas W.
  const axesById = new Map(gallery.map((f) => [f.id, f.axes]));
  const lovedAxes = gallery.filter((f) => f.loved).map((f) => f.axes);
  const w0 = E.buildWeights(lovedAxes, catalogue.map((f) => f.axes), [],
      axesById);
  const wNone = E.buildWeights(lovedAxes, catalogue.map((f) => f.axes),
      [{kind: 'none', shownIds: gallery.slice(0, 4).map((f) => f.id)}],
      axesById);
  check('« none » ne change pas W',
      JSON.stringify(w0) === JSON.stringify(wNone));

  if (!profile.rule) {
    check('sans coup de cœur : taste nul pour tous',
        ranked.every((s) => s.terms.taste === 0));
    check('sans coup de cœur : prior nul',
        E.ENGINE_AXES.every((axis) => w0[axis] === 0));
  }

  // La famille : jamais d'horreur ni de 16/18.
  const family = {...SITUATION, company: 'family'};
  const familyFilter = E.applyFilters(catalogue, {
    situation: family, excludedIds: galleryIds, exposure: new Map(), now: NOW,
  });
  const familyFive = E.recommendFive({...input, situation: family,
    want: 'everyone'});
  const safe = (f) => !f.genreIds.includes(27) &&
    f.certification !== '16' && f.certification !== '18';
  check('famille : jamais horreur ni 16/18',
      familyFilter.eligible.every(safe) &&
      familyFive.films.every((s) => safe(s.film)) &&
      familyFive.films.length === 5);

  // Les comparaisons : quatre tours d'affilée, remplaçants compris.
  const shown = [];
  const history = [];
  let planOk = true;
  let planDetail = '';
  for (let round = 1; round <= 4; round++) {
    const plan = E.planComparison({
      gallery, shownIds: [...shown], history, round,
      seedKey: `uid-${index}:2026-09-15`, recycle: false,
    });
    const four = plan.films.map((f) => f.id);
    const fourSet = new Set(four);
    const valid = four.length === 4 && fourSet.size === 4 &&
      four.every((id) => galleryIds.has(id) && !shown.includes(id));
    const replacementsValid = plan.replacements.size === 4 &&
      [...plan.replacements].every(([id, film]) => fourSet.has(id) &&
        !fourSet.has(film.id) && !shown.includes(film.id) &&
        galleryIds.has(film.id));
    if (!valid || !replacementsValid) {
      planOk = false;
      planDetail = `tour ${round} : ${four.join(', ')}`;
    }
    const keptFilm = plan.films[0];
    const replacement = plan.replacements.get(keptFilm.id);
    shown.push(...four, replacement.id);
    history.push({kind: 'pick', keptId: keptFilm.id,
      excludedId: plan.films[1].id, latencyMs: 1500});
  }
  check('planComparison : 4 films distincts non montrés, remplaçants valides',
      planOk, planDetail);

  const again = E.planComparison({
    gallery, shownIds: [], history: [], round: 1,
    seedKey: `uid-${index}:2026-09-15`, recycle: false,
  });
  const twice = E.planComparison({
    gallery, shownIds: [], history: [], round: 1,
    seedKey: `uid-${index}:2026-09-15`, recycle: false,
  });
  check('planComparison : même graine, mêmes affiches',
      again.films.map((f) => f.id).join() ===
      twice.films.map((f) => f.id).join());

  const daily = E.pickDaily(input, 258);
  const dailyAgain = E.pickDaily(input, 258);
  check('pickDaily : un film des cinq, stable pour un même jour',
      daily.film !== null && daily.top.some((s) => s === daily.film) &&
      daily.film.film.id === dailyAgain.film.film.id &&
      daily.top[258 % 5].film.id === daily.film.film.id);
}

console.log('\n— Élargissement —');
{
  const gallery = makeGallery(catalogue, 30, 9, (f) => f.axes.de);
  // Une plateforme que personne n'a : on élargit aux autres plateformes.
  const noPlatform = E.recommendFive(baseInput(catalogue, gallery, {
    situation: {company: 'alone', duration: 'any', platformIds: ['99999']},
  }));
  check('plateforme introuvable : élargissement signalé',
      noPlatform.widened !== null && noPlatform.widened.platforms === true &&
      noPlatform.widened.duration === false && noPlatform.films.length === 5,
      JSON.stringify(noPlatform.widened));

  // Des films de 100 minutes seulement, et une soirée « moins d'1h30 » :
  // la durée s'élargit, les plateformes ne bougent pas.
  const longish = makeCatalogue(40, 11).map((f) => ({...f, runtime: 100}));
  const shortEvening = E.recommendFive(baseInput(longish, [], {
    situation: {company: 'alone', duration: 'short', platformIds: []},
  }));
  check('durée introuvable : durée élargie, plateformes intactes',
      shortEvening.widened !== null &&
      shortEvening.widened.duration === true &&
      shortEvening.widened.platforms === false &&
      shortEvening.films.length === 5,
      JSON.stringify(shortEvening.widened));

  // Les films conformes gardent la priorité : un seul film tient dans la
  // durée. Il reçoit l'avance du contrat (+3), qui le fait entrer dans les
  // cinq ; elle ne garantit pas la première place face à un film bien
  // meilleur sur l'envie, et ce n'est pas ce que le contrat demande.
  const mixed = makeCatalogue(40, 12).map((f, i) =>
    ({...f, runtime: i === 5 ? 85 : 100}));
  const mixedInput = baseInput(mixed, [], {
    situation: {company: 'alone', duration: 'short', platformIds: []},
  });
  const mixedFive = E.recommendFive(mixedInput);
  const conformingPick = mixedFive.films
      .find((s) => s.film.id === mixed[5].id);
  check('élargissement : le film conforme reçoit +3 et entre dans les cinq',
      conformingPick !== undefined && conformingPick.terms.conforming === 3 &&
      mixedFive.films.every((s) => s.film.id === mixed[5].id ||
        s.terms.conforming === 0),
      `rang ${mixedFive.films.indexOf(conformingPick) + 1}`);

  const plain = E.recommendFive(baseInput(catalogue, gallery));
  check('sans contrainte : rien d\'élargi', plain.widened === null);

  check('comparisonTotal : 3 → 0, 19 → 3, 20 → 4, 300 → 4',
      E.comparisonTotal(3) === 0 && E.comparisonTotal(19) === 3 &&
      E.comparisonTotal(20) === 4 && E.comparisonTotal(300) === 4);

  // La Porte recycle quand la galerie est épuisée.
  const small = makeGallery(catalogue, 10, 13, (f) => f.axes.to);
  const allShown = small.map((f) => f.id);
  const doorPlan = E.planComparison({
    gallery: small, shownIds: allShown, history: [], round: 11,
    seedKey: 'door', recycle: true,
  });
  const closedPlan = E.planComparison({
    gallery: small, shownIds: allShown, history: [], round: 11,
    seedKey: 'door', recycle: false,
  });
  check('Porte : recyclage quand tout a été montré',
      doorPlan.films.length === 4 &&
      new Set(doorPlan.films.map((f) => f.id)).size === 4 &&
      closedPlan.films.length === 0);
}

console.log('\n— Performance (3 000 films, 300 films de galerie) —');
{
  const big = makeCatalogue(3000, 21);
  const gallery = makeGallery(big, 300, 22, (f) => f.axes.ch + f.axes.de);
  const exposure = new Map(big.slice(0, 200).map((f, i) => [f.id, {
    shownCount: i % 3, lastShownAt: NOW - (i % 14) * DAY, chosenAt: null,
  }]));
  const input = baseInput(big, gallery, {
    situation: {company: 'duo', duration: 'medium', platformIds: ['8', '119']},
    comparisons: [
      {kind: 'pick', keptId: gallery[0].id, excludedId: gallery[1].id,
        latencyMs: 800},
      {kind: 'none', shownIds: gallery.slice(2, 6).map((f) => f.id)},
    ],
    hesitations: 2,
    exposure,
  });
  E.recommendFive(input); // chauffe du JIT
  const timings = [];
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    E.recommendFive(input);
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  const median = timings[3];
  const worst = timings[timings.length - 1];
  check('recommendFive < 200 ms', worst < 200,
      `médiane ${median.toFixed(1)} ms, pire ${worst.toFixed(1)} ms`);

  const planTimings = [];
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    E.planComparison({gallery, shownIds: [], history: input.comparisons,
      round: 1 + (i % 4), seedKey: 'perf', recycle: false});
    planTimings.push(performance.now() - start);
  }
  planTimings.sort((a, b) => a - b);
  check('planComparison < 200 ms', planTimings[6] < 200,
      `médiane ${planTimings[3].toFixed(1)} ms, ` +
      `pire ${planTimings[6].toFixed(1)} ms`);

  const dailyStart = performance.now();
  E.pickDaily(input, 258);
  const dailyMs = performance.now() - dailyStart;
  check('pickDaily < 200 ms', dailyMs < 200, `${dailyMs.toFixed(1)} ms`);
}

console.log(`\n${checks - failures}/${checks} vérifications passées.`);
process.exit(failures === 0 ? 0 : 1);
