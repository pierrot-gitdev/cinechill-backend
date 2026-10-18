// Banc de non-régression : les listes de référence.
//
// Pour chaque film de départ de `reference-lists.json`, combien des films
// qu'on accepterait comme « un film proche de » arrivent dans les 20 et 50
// plus proches, selon la fiche et selon la carte. Les films de la même saga
// que le film de départ sont écartés du classement.
//
// Ces listes ont été écrites avant tout calcul. Elles disent si une version
// de la carte casse quelque chose (`--baseline`), jamais laquelle de deux
// méthodes est la meilleure : c'est la règle de l'audit du 13 octobre, et
// c'est la mesure A, sur nos galeries, qui en décide.
//
// Depuis `functions/`, après `npm run build` et `build-local.mjs` :
//   node scripts/carte/bench-lists.mjs --carte carte.json
//     [--cache ~/.cache/cinechill-carte]  fiches TMDB (pour les titres)
//     [--save résultats.json] [--baseline résultats.json]

import {createRequire} from 'node:module';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const M = require('../../lib/carte/model.js');
const C = require('../../lib/carte/catalog.js');
const F = require('../../lib/cinematch/fiche.js');

function arg(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
}
if (!arg('carte')) {
  console.error('Usage : node scripts/carte/bench-lists.mjs --carte <carte.json> [--save f] [--baseline f]');
  process.exit(2);
}
const cacheDir = arg('cache', join(homedir(), '.cache', 'cinechill-carte'));
const here = dirname(fileURLToPath(import.meta.url));
const lists = JSON.parse(readFileSync(join(here, 'reference-lists.json'), 'utf8'));

const raw = JSON.parse(readFileSync(arg('carte'), 'utf8'));
const carte = M.decodeCarte({manifest: raw.manifest,
  chunks: raw.chunks.map((c) => Buffer.from(c, 'base64'))});

/* Les titres, lus dans les fiches du cache. */
const normalize = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
const byTitle = new Map();
const titleOf = new Map();
for (const film of carte.films) {
  const file = join(cacheDir, 'movie', `${film.id}.json`);
  if (!existsSync(file)) continue;
  const detail = JSON.parse(readFileSync(file, 'utf8'));
  titleOf.set(film.id, detail.title);
  for (const t of new Set([normalize(detail.title), normalize(detail.original_title)])) {
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(film);
  }
}
function resolve([title, year]) {
  const found = (byTitle.get(normalize(title)) ?? [])
      .filter((f) => f.year !== null && Math.abs(f.year - year) <= 1)
      .sort((a, b) => Math.abs(a.year - year) - Math.abs(b.year - year) || b.voteCount - a.voteCount);
  return found[0] ?? null;
}

const fiches = carte.films.map(C.ficheOfCarteFilm);
const comparer = new F.FicheComparer(F.buildRarity(fiches));

const results = {};
const unresolved = [];
const totals = {fiche20: 0, fiche50: 0, carte20: 0, carte50: 0, blend20: 0, blend50: 0, good: 0};
for (const anchor of lists.anchors) {
  const film = resolve([anchor.title, anchor.year]);
  if (!film) {
    unresolved.push(`${anchor.title} (${anchor.year}), film de départ`);
    continue;
  }
  const row = carte.index.get(film.id);
  const sameSaga = (f) => film.collection !== null && f.collection === film.collection;
  const good = new Set();
  for (const entry of anchor.good) {
    const g = resolve(entry);
    if (!g) unresolved.push(`${entry[0]} (${entry[1]}), pour ${anchor.title}`);
    else if (g.id !== film.id && !sameSaga(g)) good.add(g.id);
  }
  const candidates = carte.films.map((f, i) => i).filter((i) =>
    i !== row && !sameSaga(carte.films[i]));
  const rank = (score) => candidates.map((i) => ({i, s: score(i)}))
      .sort((a, b) => b.s - a.s || a.i - b.i).map((x) => carte.films[x.i].id);
  const ficheSim = new Map(candidates.map((i) => [i, comparer.similarity(fiches[row], fiches[i])]));
  const carteSim = new Map(candidates.map((i) => [i, M.proximity(carte, row, i)]));
  const z = (m) => {
    const v = [...m.values()];
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length) || 1;
    return (i) => (m.get(i) - mean) / sd;
  };
  const zf = z(ficheSim);
  const zc = z(carteSim);
  const byFiche = rank((i) => ficheSim.get(i));
  const byCarte = rank((i) => carteSim.get(i));
  // Le mélange du moteur du soir : la fiche pèse d'autant moins que les
  // galeries connaissent le film (20 / (20 + n)).
  const byBlend = rank((i) => zc(i) + (20 / (20 + carte.support[i])) * zf(i));
  const hits = (ranked, n) => ranked.slice(0, n).filter((id) => good.has(id)).length;
  const r = {
    good: good.size,
    fiche20: hits(byFiche, 20), fiche50: hits(byFiche, 50),
    carte20: hits(byCarte, 20), carte50: hits(byCarte, 50),
    blend20: hits(byBlend, 20), blend50: hits(byBlend, 50),
    blendTop: byBlend.slice(0, 10).map((id) => titleOf.get(id) ?? String(id)),
    carteTop: byCarte.slice(0, 10).map((id) => titleOf.get(id) ?? String(id)),
    ficheTop: byFiche.slice(0, 10).map((id) => titleOf.get(id) ?? String(id)),
  };
  results[anchor.title] = r;
  for (const key of Object.keys(totals)) totals[key] += r[key];
}

const baseline = arg('baseline') ? JSON.parse(readFileSync(arg('baseline'), 'utf8')).results : null;
console.log('Film de départ'.padEnd(34) + 'liste  fiche@20 fiche@50  carte@20 carte@50  mêlé@20 mêlé@50' +
  (baseline ? '  écart mêlé@50' : ''));
for (const [title, r] of Object.entries(results)) {
  const before = baseline?.[title]?.blend50;
  const delta = before === undefined ? '' : `  ${r.blend50 - before >= 0 ? '+' : ''}${r.blend50 - before}` +
    (r.blend50 - before <= -2 ? '  ← à regarder' : '');
  console.log(title.slice(0, 33).padEnd(34) + String(r.good).padStart(5) +
    String(r.fiche20).padStart(10) + String(r.fiche50).padStart(9) +
    String(r.carte20).padStart(10) + String(r.carte50).padStart(9) +
    String(r.blend20).padStart(9) + String(r.blend50).padStart(8) + delta);
}
console.log('Total'.padEnd(34) + String(totals.good).padStart(5) +
  String(totals.fiche20).padStart(10) + String(totals.fiche50).padStart(9) +
  String(totals.carte20).padStart(10) + String(totals.carte50).padStart(9) +
  String(totals.blend20).padStart(9) + String(totals.blend50).padStart(8));
if (unresolved.length > 0) {
  console.log(`\n${unresolved.length} titres hors de la carte ou introuvables :`);
  for (const u of unresolved) console.log(`  ${u}`);
}
if (process.argv.includes('--verbose')) {
  for (const [title, r] of Object.entries(results)) {
    console.log(`\n${title}\n  mêlé  : ${r.blendTop.join(' · ')}\n  carte : ${r.carteTop.join(' · ')}\n  fiche : ${r.ficheTop.join(' · ')}`);
  }
}
if (arg('save')) {
  writeFileSync(arg('save'), JSON.stringify({builtAt: carte.builtAt, totals, results}, null, 1));
}
