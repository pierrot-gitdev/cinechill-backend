// Le moteur du soir sur la vraie carte : réglages et comportement.
//
// Des galeries simulées (des films de départ aimés, et leurs voisins vus),
// des soirées jouées : un écran « Un film proche de… », le film choisi,
// l'écran « Plutôt du côté de… ». On mesure :
//
//  - la part du film choisi dans les cinq : parmi les 20 premiers du soir,
//    combien viennent du voisinage du film choisi plutôt que du goût
//    durable. Le moteur d'aujourd'hui donne environ 60 % au film choisi ;
//    les réglages de départ doivent s'en approcher ;
//  - combien de films changerait l'écran « Plutôt du côté de… », et donc
//    combien de fois il serait sauté (moins de 3 sur 5).
//
// Depuis `functions/`, après `npm run build` et `build-local.mjs` :
//   node scripts/carte/evening-check.mjs --carte carte.json [--grid] [--verbose]

import {createRequire} from 'node:module';
import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

const require = createRequire(import.meta.url);
const M = require('../../lib/carte/model.js');
const C = require('../../lib/carte/catalog.js');
const E = require('../../lib/carte/evening.js');
const F = require('../../lib/cinematch/fiche.js');
const L = require('../../lib/carte/linalg.js');

function arg(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
}
const raw = JSON.parse(readFileSync(arg('carte'), 'utf8'));
const carte = M.decodeCarte({manifest: raw.manifest,
  chunks: raw.chunks.map((c) => Buffer.from(c, 'base64'))});
const cacheDir = arg('cache', join(homedir(), '.cache', 'cinechill-carte'));
const verbose = process.argv.includes('--verbose');

const normalize = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const titleOf = new Map();
const byTitle = new Map();
for (const film of carte.films) {
  const file = join(cacheDir, 'movie', `${film.id}.json`);
  if (!existsSync(file)) continue;
  const d = JSON.parse(readFileSync(file, 'utf8'));
  titleOf.set(film.id, d.title);
  const key = normalize(d.title);
  if (!byTitle.has(key) || byTitle.get(key).voteCount < film.voteCount) byTitle.set(key, film);
}
const find = (t) => byTitle.get(normalize(t)) ?? null;

const fiches = carte.films.map(C.ficheOfCarteFilm);
const comparer = new F.FicheComparer(F.buildRarity(fiches));
const receptionOf = (row) => F.receptionOf(fiches[row]);

// Les voisins d'un film, au sens du mélange carte + fiche.
function blendNeighbors(row, count) {
  const sims = carte.films.map((f, i) => i === row ? -Infinity :
    M.proximity(carte, row, i) + comparer.similarity(fiches[row], fiches[i]));
  return sims.map((s, i) => ({i, s})).sort((a, b) => b.s - a.s).slice(0, count).map((x) => x.i);
}

const PROFILES = {
  polar: ['Heat', 'Se7en', 'Zodiac', 'The Departed', 'No Country for Old Men', 'Prisoners'],
  sf: ['Interstellar', 'Arrival', 'Blade Runner 2049', 'The Matrix', 'Inception', 'Alien'],
  comedie: ["What's in a Name?", 'The Intouchables', 'The Dinner Game', 'OSS 117: Cairo, Nest of Spies',
    'Welcome to the Sticks', 'Serial (Bad) Weddings'],
  animation: ['Spirited Away', 'Toy Story', 'Up', 'Coco', 'Ratatouille', 'My Neighbor Totoro'],
  mixte: ['Interstellar', 'Arrival', 'La La Land', 'Before Sunrise', 'Pride & Prejudice', 'The Martian'],
};

function galleryOf(seeds) {
  const rows = seeds.map(find).filter(Boolean).map((f) => carte.index.get(f.id));
  const marks = new Map();
  for (const row of rows) {
    marks.set(row, {id: carte.films[row].id, loved: true, disliked: false});
    for (const n of blendNeighbors(row, 12)) {
      if (!marks.has(n)) marks.set(n, {id: carte.films[n].id, loved: false, disliked: false});
    }
  }
  return {seeds: rows, marks: [...marks.values()], rows: [...marks.keys()]};
}

const top = (notes, rows, n) => Array.from(notes.keys()).sort((a, b) => notes[b] - notes[a]).slice(0, n).map((i) => rows[i]);

const vecFor = (id) => {
  const r = carte.index.get(id);
  return r === undefined ? null : E.vectorOf(carte, r);
};

function playEvening(profile, anchorTitle, params, random) {
  const g = galleryOf(PROFILES[profile]);
  const seen = new Set(g.rows);
  const candidates = carte.films.map((f, i) => i).filter((i) => !seen.has(i) && carte.films[i].providers.length > 0);
  const prior = E.eveningPrior(carte, g.marks, params);
  const idOf = (r) => carte.films[r].id;

  // L'écran « Un film proche de… » : six films de la galerie tirés dans le nuage.
  const screen = E.drawScreen(carte, g.rows, prior, 6, params, random);
  const anchorFilm = find(anchorTitle);
  const anchor = anchorFilm ? carte.index.get(anchorFilm.id) : screen[0];
  const shown = screen.includes(anchor) ? screen : [...screen.slice(0, 5), anchor];
  const touches = [{kind: 'anchor', shown: shown.map(idOf), chosen: idOf(anchor)}];
  const point = E.eveningFromTouches(carte, prior, touches, vecFor, params);

  const sim = (a) => (row) => comparer.similarity(fiches[a], fiches[row]);
  const candidatesFor = (similarity) => E.prepareCandidates(carte, candidates, receptionOf,
      similarity, null, params);
  const c = candidatesFor(sim(anchor));
  const evening = top(E.scoreCandidates(carte, c, point.mean, params), candidates, 20);
  const durable = top(E.scoreCandidates(carte, E.prepareCandidates(carte, candidates, receptionOf, null, null, params), prior.mean, params), candidates, 20);
  const anchorOnly = new Set(blendNeighbors(anchor, 400).filter((r) => !seen.has(r)).slice(0, 20));
  const durableSet = new Set(durable);
  const fromAnchor = evening.filter((r) => anchorOnly.has(r) && !durableSet.has(r)).length;
  const fromDurable = evening.filter((r) => durableSet.has(r) && !anchorOnly.has(r)).length;
  const share = fromAnchor + fromDurable === 0 ? 0.5 : fromAnchor / (fromAnchor + fromDurable);

  // « Plutôt du côté de… » : quarante voisins de la galerie, six tirés. Chaque
  // réponse possible : un second film (point et fiche), ou « Pile comme ».
  const near = g.rows.filter((r) => r !== anchor)
      .map((r) => ({r, s: M.proximity(carte, anchor, r)})).sort((a, b) => b.s - a.s).slice(0, 40).map((x) => x.r);
  const nearScreen = E.drawScreen(carte, near, point, 6, params, random);
  const nearShown = [...nearScreen, anchor].map(idOf);
  const base = E.expectedSlate(carte, c, point, 5, params);
  const answers = [...nearScreen, anchor].map((r) => {
    const second = r === anchor ?
      {kind: 'same', shown: nearShown, chosen: idOf(anchor)} :
      {kind: 'second', shown: nearShown, chosen: idOf(r)};
    const p = E.eveningFromTouches(carte, prior, [...touches, second], vecFor, params);
    const cs = r === anchor ? c : candidatesFor((row) => (sim(anchor)(row) + sim(r)(row)) / 2);
    return E.expectedSlate(carte, cs, p, 5, params);
  });
  const probs = E.choiceProbabilities(point, [...nearScreen, anchor].map((r) => E.vectorOf(carte, r)), params).slice(0, -1);
  const change = E.expectedChange(base, answers, probs);
  const five = E.drawSlate(carte, c, point, 5, params, random, 50);
  // La stabilité des tirages : deux tirages des cinq ont-ils des films en commun ?
  const again = E.drawSlate(carte, c, point, 5, params, random, 0);
  const common = again.rows.filter((r) => five.rows.includes(r)).length;
  return {share, change, common, five: five.rows, screen, nearScreen, anchor, durable: durable.slice(0, 5)};
}

const EVENINGS = [
  ['polar', 'Heat'], ['polar', 'Zodiac'], ['sf', 'Interstellar'], ['sf', 'Alien'],
  ['comedie', "What's in a Name?"], ['animation', 'Spirited Away'], ['animation', 'Toy Story'],
  ['mixte', 'La La Land'], ['mixte', 'Interstellar'],
];

function run(params, print) {
  let share = 0;
  let change = 0;
  let skipped = 0;
  let common = 0;
  for (const [profile, anchor] of EVENINGS) {
    const r = playEvening(profile, anchor, params, L.rng(7));
    share += r.share;
    change += r.change;
    common += r.common;
    if (r.change < 3) skipped++;
    if (print) {
      const t = (rows) => rows.map((x) => titleOf.get(carte.films[x].id)).join(' · ');
      console.log(`\n${profile} / ${anchor} : part du film choisi ${(100 * r.share).toFixed(0)} %, ` +
        `« Plutôt du côté de… » changerait ${r.change.toFixed(1)} films${r.change < 3 ? ' (sauté)' : ''}`);
      console.log(`  écran de départ : ${t(r.screen)}`);
      console.log(`  voisins         : ${t(r.nearScreen)}`);
      console.log(`  les cinq        : ${t(r.five)}`);
      console.log(`  goût seul       : ${t(r.durable)}`);
    }
  }
  return {share: share / EVENINGS.length, change: change / EVENINGS.length, skipped,
    common: common / EVENINGS.length};
}

const params = {...E.DEFAULT_EVENING_PARAMS};
// L'échelle de la carte : ce que vaut une note de film pour une personne.
{
  const g = galleryOf(PROFILES.polar);
  const placed = M.placePerson(carte, g.marks);
  const scores = carte.films.map((f, i) => L.dot(carte.vectors, placed.mean, carte.k, i * carte.k, 0)).sort((a, b) => b - a);
  const norms = carte.films.map((f, i) => M.norm(carte, i)).sort((a, b) => a - b);
  console.log(`Échelle : notes du goût durable, 1er ${scores[0].toFixed(3)}, 20e ${scores[19].toFixed(3)}, ` +
    `200e ${scores[199].toFixed(3)}, médiane ${scores[Math.floor(scores.length / 2)].toFixed(3)} ; ` +
    `normes des films, médiane ${norms[Math.floor(norms.length / 2)].toFixed(3)}, 90e centile ${norms[Math.floor(0.9 * norms.length)].toFixed(3)}`);
}

if (process.argv.includes('--grid')) {
  const powers = (arg('powers') ?? '0,0.5,1').split(',').map(Number);
  const explores = (arg('explores') ?? '0.15,0.2,0.3').split(',').map(Number);
  console.log('\n    α      s   part du film choisi   films changés   écrans sautés   cinq en commun sur deux tirages');
  for (const normPower of powers) {
    for (const explore of explores) {
      const r = run({...params, normPower, explore}, false);
      console.log(`${normPower.toFixed(2).padStart(6)}  ${explore.toFixed(2).padStart(5)}` +
        `${(100 * r.share).toFixed(0).padStart(14)} %${r.change.toFixed(1).padStart(16)}${String(r.skipped).padStart(12)} / ${EVENINGS.length}` +
        `${r.common.toFixed(1).padStart(16)}`);
    }
  }
}
const r = run(params, verbose);
console.log(`\nRéglages de départ (w = ${params.targetWeight}, α = ${params.normPower}, s = ${params.explore}, τ = ${params.tau}) : part du film choisi ` +
  `${(100 * r.share).toFixed(0)} %, ${r.change.toFixed(1)} films changés en moyenne, ${r.skipped} écrans sautés sur ${EVENINGS.length}`);
