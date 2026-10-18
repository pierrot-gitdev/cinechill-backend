// Vérifications du moteur du deck Découvrir, sans Firebase ni réseau.
//
// À lancer après `npm run build`, depuis `functions/` :
//   node scripts/deck-engine-check.mjs
//
// Le catalogue est synthétique et déterministe (graine fixe) : un échec se
// rejoue à l'identique. Ce banc vérifie que le moteur se comporte comme
// prévu (non-régression). Il ne dit pas si la V2 sert mieux de vraies
// personnes que la V1 : des profils inventés ne le peuvent pas, seul le
// journal `swipeLog` le dira. Hors de `src`, il n'est ni compilé ni déployé.

import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../lib/deck/engine.js');

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  ÉCHEC ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

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

/* ------------------------------------------------------------------ *
 *  Le catalogue : quelques films par famille, du plus au moins voté
 * ------------------------------------------------------------------ */

const SHAPES = {
  spectacle: {genreIds: [28, 12], originalLanguage: 'en', year: 2012},
  classiques_80_90: {genreIds: [12, 35], originalLanguage: 'en', year: 1988},
  comedie_fr: {genreIds: [35], originalLanguage: 'fr', year: 2011},
  auteur_fr: {genreIds: [18], originalLanguage: 'fr', year: 2015},
  animation_famille: {genreIds: [16, 10751], originalLanguage: 'en',
    year: 2010},
  anime: {genreIds: [16, 14], originalLanguage: 'ja', year: 2005},
  coree: {genreIds: [53, 18], originalLanguage: 'ko', year: 2016},
  asie: {genreIds: [28, 18], originalLanguage: 'zh', year: 2002},
  horreur_moderne: {genreIds: [27, 9648], originalLanguage: 'en', year: 2017},
  horreur_culte: {genreIds: [27], originalLanguage: 'en', year: 1980},
  thriller_polar: {genreIds: [80, 53], originalLanguage: 'en', year: 1999},
  romance: {genreIds: [10749, 18], originalLanguage: 'en', year: 2004},
  europe: {genreIds: [18], originalLanguage: 'it', year: 1997},
  inde: {genreIds: [28, 18], originalLanguage: 'hi', year: 2022},
  western: {genreIds: [37], originalLanguage: 'en', year: 1966},
};

let nextId = 1;
const catalog = [];
for (const [family, shape] of Object.entries(SHAPES)) {
  for (let i = 0; i < 40; i++) {
    const big = family === 'spectacle' ? 30000 : 12000;
    catalog.push({
      id: nextId++,
      family,
      source: 'family',
      neighborCount: 0,
      genreIds: shape.genreIds,
      originalLanguage: shape.originalLanguage,
      year: shape.year,
      voteCount: Math.round(big * Math.pow(0.9, i)) + 150,
      voteAverage: 7.6 - i * 0.02,
      taggedFamilies: [family],
    });
  }
}

/* ------------------------------------------------------------------ *
 *  1. Les familles reconnaissent leurs films
 * ------------------------------------------------------------------ */

console.log('\nFamilles');
const famOf = (f) => D.familiesOf({...f, taggedFamilies: []});
check('un anime est un anime, pas un Pixar',
    famOf({genreIds: [16], originalLanguage: 'ja', year: 2001,
      voteCount: 16000, voteAverage: 8.5}).includes('anime') &&
    !famOf({genreIds: [16], originalLanguage: 'ja', year: 2001,
      voteCount: 16000, voteAverage: 8.5}).includes('animation_famille'));
check('un polar coréen est coréen',
    famOf({genreIds: [53, 80], originalLanguage: 'ko', year: 2003,
      voteCount: 9000, voteAverage: 8.3}).includes('coree'));
check('un film sans famille tombe dans « autres »',
    famOf({genreIds: [99], originalLanguage: 'pt', year: 2010,
      voteCount: 50, voteAverage: 6}).join() === 'autres');
check('la langue d\'une famille multilingue est tirée parmi les siennes',
    ['ja', 'zh', 'cn'].includes(D.familyDiscoverParams(
        D.FAMILIES.find((f) => f.key === 'asie'), rng(3),
    )['with_original_language']));

/* ------------------------------------------------------------------ *
 *  2. Le modèle entend les refus
 * ------------------------------------------------------------------ */

console.log('\nModèle');
const spectacleFilm = catalog.find((f) => f.family === 'spectacle');
const fresh = D.emptyModel();
const before = D.pSeenOf(fresh, spectacleFilm, ['spectacle'], null);
const refused = D.emptyModel();
for (let i = 0; i < 20; i++) {
  D.learn(refused, {families: ['spectacle'], voteCount: 25000, seen: 0,
    weight: 1, fromDeck: true});
}
const after = D.pSeenOf(refused, spectacleFilm, ['spectacle'], null);
check(`20 refus font tomber la famille (${before.toFixed(2)} → ${
  after.toFixed(2)})`, after < 0.12 && before - after > 0.4);
check('le plancher de notoriété tombe pour qui refuse les blockbusters',
    D.voteFloor(refused) <= 800, `plancher ${D.voteFloor(refused)}`);
check('le plancher reste haut pour un profil neuf',
    D.voteFloor(fresh) === 2000);
check('une famille refusée trois fois sans un vu est fermée',
    D.isClosed(refused, 'spectacle') && !D.isClosed(fresh, 'spectacle'));
check('le rendement glissant voit les dix derniers refus',
    D.rollingYield(refused.recent) === 0);

const liked = D.emptyModel();
for (const vc of [18000, 9000, 4000]) {
  D.learn(liked, {families: ['coree'], voteCount: vc, seen: 1, weight: 1});
}
const coreeFilm = catalog.find((f) => f.family === 'coree' && f.voteCount < 5000);
const pCoree = D.pSeenOf(liked, coreeFilm, ['coree'], null);
check(`trois « vu » coréens ouvrent le cinéma coréen (p = ${
  pCoree.toFixed(2)})`, pCoree > 0.5);

const soft = D.emptyModel();
D.learn(soft, {families: ['anime'], voteCount: 16000, seen: 0, weight: 0.5});
const hard = D.emptyModel();
D.learn(hard, {families: ['anime'], voteCount: 16000, seen: 0, weight: 1});
check('une case vide pèse moins qu\'un refus franc',
    D.beliefOf(soft, 'anime').m > D.beliefOf(hard, 'anime').m);

const round = D.parseModel(JSON.parse(JSON.stringify(liked)));
check('le modèle survit à Firestore',
    Math.abs(round.theta.coree.m - liked.theta.coree.m) < 1e-12 &&
    round.n === liked.n);
check('une version inconnue repart de zéro',
    D.parseModel({...liked, v: 99}).n === 0);
check('le voisinage d\'un film vu relève sa probabilité',
    D.pSeenOf(fresh, {...coreeFilm, neighborCount: 3}, ['coree'], null) >
    D.pSeenOf(fresh, coreeFilm, ['coree'], null) + 0.2);

/* ------------------------------------------------------------------ *
 *  3. La composition du lot
 * ------------------------------------------------------------------ */

console.log('\nLot');
function context(model, overrides = {}) {
  return {
    model, phase: 'recolte', mode: 'normal', birthDecade: null,
    gallerySize: 40, lovedCount: 5, watchlistSize: 12, galleryGenreCount: 8,
    rolling: D.rollingYield(model.recent), random: rng(11), ...overrides,
  };
}
const ctx = context(liked);
const scored = D.scoreCandidates(catalog, ctx);
const lot = D.composeLot(scored, ctx);
check('un lot fait dix cartes', lot.cards.length === D.LOT_SIZE);
check('la réserve fait cinq cartes, hors du lot',
    lot.reserve.length === D.RESERVE_SIZE &&
    lot.reserve.every((r) => !lot.cards.some((c) => c.id === r.id)));
check('la réserve est la plus probable du vivier restant',
    lot.reserve.every((r, i, all) => i === 0 || all[i - 1].pSeen >= r.pSeen));
const familiesInLot = new Map();
for (const c of lot.cards) {
  for (const k of c.families) familiesInLot.set(k, (familiesInLot.get(k) ?? 0) + 1);
}
check('aucune famille ne prend plus de quatre cartes',
    Math.max(...familiesInLot.values()) <= 4,
    JSON.stringify([...familiesInLot]));
check('les cartes du cinéma coréen sont en tête de valeur',
    lot.cards.some((c) => c.families.includes('coree')));

const recentrageCtx = context(refused, {mode: 'recentrage'});
const recentrage = D.composeLot(
    D.scoreCandidates(catalog, recentrageCtx), recentrageCtx);
check('un recentrage ne sert pas la famille fermée',
    recentrage.cards.every((c) => !c.families.includes('spectacle')));
check('un recentrage rend quand même un lot plein',
    recentrage.cards.length === D.LOT_SIZE);

const promesseCtx = context(liked, {watchlistSize: 2});
const withPromesse = [...catalog, {
  ...coreeFilm, id: 9999, source: 'promesse', voteCount: 900, year: 2024,
}];
const promesseLot = D.composeLot(
    D.scoreCandidates(withPromesse, promesseCtx), promesseCtx);
check('la Promesse en retard réserve une carte « à voir »',
    promesseLot.cards.some((c) => c.kind === 'promesse'));

// Une sonde de genre attend quand le rendement est bas, sauf en finitions :
// à 70 films, un genre jamais sondé doit passer.
const lowYield = D.emptyModel();
lowYield.recent = [1, 0, 0, 1, 0, 0, 0, 1, 0, 0];
const withCoverage = [...catalog, {
  ...coreeFilm, id: 9998, source: 'coverage', voteCount: 6000,
  genreIds: [10751], taggedFamilies: [],
}];
const coverageOf = (overrides) => {
  const c = context(lowYield, overrides);
  return D.composeLot(D.scoreCandidates(withCoverage, c), c)
      .cards.some((card) => card.kind === 'coverage');
};
check('sous un film sur deux, la sonde de genre attend en récolte',
    !coverageOf({phase: 'recolte', gallerySize: 40}));
check('en finitions, la sonde de genre passe même sous un film sur deux',
    coverageOf({phase: 'finitions', gallerySize: 75}));

/* ------------------------------------------------------------------ *
 *  Le public français
 * ------------------------------------------------------------------ */

console.log('\nPublic français');
check('un film en français voit ses votes relevés',
    D.frenchVotes('fr', 2300) === 2300 * D.FRENCH_VOTE_FACTOR);
check('un film dans une autre langue ne bouge pas',
    D.frenchVotes('en', 2300) === 2300 && D.frenchVotes(null, 2300) === 2300);
check('des votes inconnus restent inconnus',
    D.frenchVotes('fr', null) === null);
const visiteurs = {genreIds: [35], originalLanguage: 'fr', year: 1993,
  voteCount: 2300, voteAverage: 7, neighborCount: 0};
const visiteursBefore = D.pSeenOf(fresh, visiteurs, ['comedie_fr'], null);
const visiteursAfter = D.pSeenOf(fresh, {...visiteurs,
  voteCount: D.frenchVotes('fr', 2300)}, ['comedie_fr'], null);
console.log(`        Les Visiteurs, a priori : ${visiteursBefore.toFixed(2)} → ${
  visiteursAfter.toFixed(2)}`);
check('un succès français remonte sans dépasser un classique mondial',
    visiteursBefore < 0.3 && visiteursAfter > 0.35 && visiteursAfter < 0.6);

/* ------------------------------------------------------------------ *
 *  4. Les mosaïques
 * ------------------------------------------------------------------ */

console.log('\nMosaïques');
const start1 = D.gridPlan('start1', fresh, rng(5));
check('la première mosaïque couvre neuf familles',
    start1.length === 9 && start1.every((p) => p.count === 1));
const afterStart = D.emptyModel();
D.learn(afterStart, {families: ['anime'], voteCount: 16000, seen: 1,
  weight: 1});
for (const key of D.START_GRID_FAMILIES.filter((k) => k !== 'anime')) {
  D.learn(afterStart, {families: [key], voteCount: 20000, seen: 0,
    weight: 0.5});
}
const start2 = D.gridPlan('start2', afterStart, rng(5));
const total2 = start2.reduce((s, p) => s + p.count, 0);
check('la deuxième resserre autour de ce qui a été coché',
    start2[0].key === 'anime' && start2[0].count === 2, JSON.stringify(start2));
check('la deuxième garde neuf affiches', total2 === 9, String(total2));
const relance2 = D.gridPlan('relance2', afterStart, rng(5));
check('la seconde relance va vers les familles de niche',
    relance2.every((p) => D.FAMILIES.find((f) => f.key === p.key).niche ||
      relance2.length === 9));

/* ------------------------------------------------------------------ *
 *  5. Deux personnes, 60 cartes, comme dans l'app
 *
 *  L'une a vu 70 % de l'anime, du cinéma coréen et de l'horreur moderne,
 *  5 % du reste ; l'autre, 70 % du grand public et 10 % du reste. On sert
 *  des lots comme le fait l'app, garde-fous compris : carte de réserve
 *  après trois refus (en sautant les familles qu'on vient de refuser),
 *  recentrage sous 45 % sur dix cartes, mosaïque de relance à trois « vu »
 *  sur quinze. Avec et sans la mosaïque de départ.
 * ------------------------------------------------------------------ */

function simulate(seed, truth, withStartGrid) {
  const draw = rng(seed);
  const person = D.emptyModel();
  const served = new Set();
  const outcomes = [];
  let window = [];
  let gallery = 0;
  let queue = [];
  let reserve = [];
  let mode = 'normal';
  let relanceUsed = false;
  const answer = (film) => draw() < truth(film) ? 1 : 0;
  // Ce que l'app retient pendant la session : les familles où la personne
  // a dit « vu ». La réserve ne saute jamais l'une d'elles, même juste
  // refusée : trois refus d'affilée sur une famille aimée sont de la
  // malchance, pas un signal.
  const seenFamilies = new Set();

  const grid = (stage) => {
    for (const {key, count} of D.gridPlan(stage, person, draw)) {
      const films = catalog.filter((f) => f.family === key && !served.has(f.id))
          .slice(0, count);
      for (const film of films) {
        served.add(film.id);
        const seen = answer(film);
        gallery += seen;
        if (seen) D.familiesOf(film).forEach((k) => seenFamilies.add(k));
        D.learn(person, {families: D.familiesOf(film), voteCount: film.voteCount,
          seen, weight: seen ? 1 : 0.5});
      }
    }
  };
  if (withStartGrid) ['start1', 'start2', 'start3'].forEach(grid);

  const refill = () => {
    const lotCtx = context(person, {
      phase: D.phaseOf(person, gallery), mode, gallerySize: gallery,
      rolling: D.rollingYield(person.recent), random: draw,
    });
    const pool = catalog.filter((f) => !served.has(f.id));
    const next = D.composeLot(D.scoreCandidates(pool, lotCtx), lotCtx);
    queue = next.cards;
    reserve = next.reserve;
  };
  while (outcomes.length < 60) {
    if (queue.length === 0) refill();
    const lastThree = window.slice(-3);
    const streak = lastThree.length === 3 && lastThree.every((o) => o.seen === 0);
    let card;
    if (streak) {
      const refused = new Set(lastThree.flatMap((o) => o.families)
          .filter((k) => !seenFamilies.has(k)));
      // Une carte de réserve à peine probable ne protège de rien.
      const index = reserve.findIndex((r) => !served.has(r.id) &&
        r.pSeen >= 0.45 && !r.families.some((k) => refused.has(k)));
      if (index >= 0) card = reserve.splice(index, 1)[0];
    }
    card = card ?? queue.shift();
    if (!card || served.has(card.id)) continue;
    served.add(card.id);
    const seen = answer(card);
    if (seen) card.families.forEach((k) => seenFamilies.add(k));
    gallery += seen;
    outcomes.push(seen);
    window.push({seen, families: card.families});
    D.learn(person, {families: card.families, voteCount: card.voteCount,
      seen, weight: 1, fromDeck: true});
    if (process.env.TRACE) {
      console.log(outcomes.length, card.family, card.kind, mode,
          card.pSeen.toFixed(2), seen);
    }
    const tail = window.slice(-15);
    const rolling = window.length >= 10 ?
      window.slice(-10).reduce((s, o) => s + o.seen, 0) / 10 : null;
    if (!relanceUsed && tail.length === 15 &&
      tail.reduce((s, o) => s + o.seen, 0) <= 3) {
      relanceUsed = true;
      grid('relance1');
      window = [];
      mode = 'normal';
      queue = [];
    } else if (mode === 'normal' && rolling !== null && rolling < 0.45) {
      mode = 'recentrage';
      queue = [];
    } else if (mode === 'recentrage' && rolling !== null && rolling >= 0.55) {
      mode = 'normal';
    }
  }
  const yieldOf = (from, to) =>
    outcomes.slice(from, to).reduce((s, v) => s + v, 0) / (to - from);
  let worst = 1;
  for (let i = 0; i + 10 <= 60; i++) worst = Math.min(worst, yieldOf(i, i + 10));
  return {early: yieldOf(0, 20), late: yieldOf(20, 60), worst, gallery};
}

const pointu = (film) =>
  ['anime', 'coree', 'horreur_moderne'].includes(film.family) ? 0.7 : 0.05;
const grandPublic = (film) =>
  ['spectacle', 'classiques_80_90', 'animation_famille', 'comedie_fr',
    'thriller_polar', 'romance'].includes(film.family) ? 0.7 : 0.1;
const SEEDS = [42, 7, 99, 1234, 5, 77, 2026, 31];
for (const withStartGrid of [true, false]) {
  console.log(withStartGrid ? '\nAvec la mosaïque de départ' :
    '\nMosaïque de départ passée');
  for (const [label, truth] of [['pointu', pointu],
    ['grand public', grandPublic]]) {
    const runs = SEEDS.map((seed) => simulate(seed, truth, withStartGrid));
    const mean = (key) => runs.reduce((s, r) => s + r[key], 0) / runs.length;
    console.log(`        ${label} : cartes 1-20 ${
      Math.round(mean('early') * 100)} %, 21-60 ${
      Math.round(mean('late') * 100)} %, pire fenêtre de 10 : ${
      Math.round(Math.min(...runs.map((r) => r.worst)) * 100)} %, galerie ${
      Math.round(mean('gallery'))} films`);
    check(`${label}, ${withStartGrid ? 'avec' : 'sans'} mosaïque : ` +
      'plus d\'une carte sur deux vue après vingt cartes', mean('late') > 0.5);
  }
}

console.log(failures === 0 ? '\nTout passe.\n' : `\n${failures} échec(s).\n`);
process.exit(failures === 0 ? 0 : 1);
