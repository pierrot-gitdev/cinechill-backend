// Construit la carte sur son poste, avec les vraies données TMDB, sans
// Firebase. C'est la même chaîne que la tâche du lundi (`gatherFilms`, puis
// `buildCarte`) : le banc et la production ne peuvent pas diverger.
//
// À lancer après `npm run build`, depuis `functions/` :
//   node scripts/carte/build-local.mjs --out /chemin/carte.json
//     [--galleries export.json]   galeries anonymisées (export-galleries.mjs)
//     [--previous carte.json]     carte précédente : fiches reprises, recalage
//     [--cache ~/.cache/cinechill-carte]
//     [--iterations 10] [--k 32]
//
// La clé TMDB est lue dans TMDB_API_KEY ou ~/.cinechill_tmdb_key ; elle
// n'est jamais affichée. Les fiches sont gardées dans le cache, hors du
// dépôt, réduites à ce que la carte lit (plus le titre, pour le banc des
// listes), et relues au bout de six mois comme en production.

import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

const require = createRequire(import.meta.url);
const P = require('../../lib/carte/pipeline.js');
const M = require('../../lib/carte/model.js');
const C = require('../../lib/carte/catalog.js');

function arg(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
}

const out = arg('out');
if (!out) {
  console.error('Usage : node scripts/carte/build-local.mjs --out <carte.json> ' +
    '[--galleries export.json] [--previous carte.json] [--cache dir]');
  process.exit(2);
}
const cacheDir = arg('cache', join(homedir(), '.cache', 'cinechill-carte'));
mkdirSync(join(cacheDir, 'movie'), {recursive: true});
mkdirSync(join(cacheDir, 'list'), {recursive: true});

const keyFile = join(homedir(), '.cinechill_tmdb_key');
const key = (process.env.TMDB_API_KEY ||
  (existsSync(keyFile) ? readFileSync(keyFile, 'utf8') : '')).trim();
if (!key) {
  console.error('Clé TMDB introuvable (TMDB_API_KEY ou ~/.cinechill_tmdb_key).');
  process.exit(2);
}
// Une clé v3 (32 caractères hexadécimaux) va dans l'URL, un jeton v4 dans
// l'en-tête.
const v3 = /^[0-9a-f]{32}$/.test(key);

let calls = 0;
async function tmdb(path, query) {
  const params = new URLSearchParams({language: 'en-US', ...query});
  if (v3) params.set('api_key', key);
  const url = `https://api.themoviedb.org/3${path}?${params}`;
  for (let attempt = 0; ; attempt++) {
    calls++;
    let response;
    try {
      response = await fetch(url, {
        headers: v3 ? {Accept: 'application/json'} :
          {Authorization: `Bearer ${key}`, Accept: 'application/json'},
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (response.status === 404) return null;
    if (response.ok) return response.json();
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1) * 2));
      continue;
    }
    throw new Error(`TMDB ${response.status} sur ${path}`);
  }
}

/** Une fiche réduite à ce que lisent la carte et le banc des listes. */
function slim(detail) {
  const credits = detail.credits ?? {};
  return {
    id: detail.id, title: detail.title, original_title: detail.original_title,
    release_date: detail.release_date, runtime: detail.runtime,
    genres: detail.genres, belongs_to_collection: detail.belongs_to_collection,
    vote_average: detail.vote_average, vote_count: detail.vote_count,
    keywords: detail.keywords,
    recommendations: {results: (detail.recommendations?.results ?? []).map((r) => ({id: r.id}))},
    credits: {
      cast: (credits.cast ?? []).slice(0, 8).map((c) => ({id: c.id})),
      crew: (credits.crew ?? [])
          .filter((c) => c.job === 'Director' || c.department === 'Writing')
          .map((c) => ({id: c.id, job: c.job, department: c.department})),
    },
  };
}

const DAY = 86_400_000;
const source = {
  async discover(query) {
    // Les listes changent chaque jour : gardées un jour, pour relancer vite.
    const name = createHash('sha1').update(JSON.stringify(query)).digest('hex');
    const file = join(cacheDir, 'list', `${name}.json`);
    if (existsSync(file) && Date.now() - statSync(file).mtimeMs < DAY) {
      return JSON.parse(readFileSync(file, 'utf8'));
    }
    const page = await tmdb('/discover/movie', query);
    writeFileSync(file, JSON.stringify(page));
    return page;
  },
  async providers() {
    const list = await tmdb('/watch/providers/movie', {watch_region: 'FR'});
    return list?.results ?? [];
  },
  async movie(id) {
    const file = join(cacheDir, 'movie', `${id}.json`);
    // `gatherFilms` ne demande une fiche que si la carte précédente ne
    // l'a pas, ou l'a lue il y a trop longtemps : le cache disque suit la
    // même règle, sur la date du fichier.
    if (existsSync(file) &&
        (Date.now() - statSync(file).mtimeMs) / DAY < P.staleAfterDays(id)) {
      const cached = JSON.parse(readFileSync(file, 'utf8'));
      // Une fiche lue avant l'ajout des recommandations se relit.
      if (cached.gone) return null;
      if (cached.recommendations) return cached;
    }
    const detail = await tmdb(`/movie/${id}`, {append_to_response: C.CARTE_DETAIL_APPEND});
    writeFileSync(file, JSON.stringify(detail ? slim(detail) : {gone: true}));
    return detail ? slim(detail) : null;
  },
};

function readCarte(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return M.decodeCarte({manifest: raw.manifest,
    chunks: raw.chunks.map((c) => Buffer.from(c, 'base64'))});
}

const previous = arg('previous') ? readCarte(arg('previous')) : null;
const galleries = [];
if (arg('galleries')) {
  const exported = JSON.parse(readFileSync(arg('galleries'), 'utf8'));
  for (const user of exported.users) {
    const marks = user.gallery.filter((m) => m.type === 'movie')
        .map((m) => ({id: m.id, loved: m.loved, disliked: m.disliked}));
    if (marks.length > 0) galleries.push(marks);
  }
}

const t0 = Date.now();
const {films, report} = await P.gatherFilms(source, {
  today: P.dayOf(t0), lastYear: new Date(t0).getUTCFullYear(), previous,
  budgetMs: 6 * 3600 * 1000, concurrency: 8,
});
const t1 = Date.now();
console.log(`Films : ${films.length} (${report.onPlatforms} sur les plateformes ` +
  `${report.providers.join(', ')}) ; ${calls} appels TMDB en ${((t1 - t0) / 1000).toFixed(0)} s`);
console.log(`Compte rendu : ${JSON.stringify(report)}`);

const params = {
  ...M.DEFAULT_CARTE_PARAMS,
  iterations: Number(arg('iterations', M.DEFAULT_CARTE_PARAMS.iterations)),
  k: Number(arg('k', M.DEFAULT_CARTE_PARAMS.k)),
};
const carte = M.buildCarte(films, galleries, params, previous);
const t2 = Date.now();
const encoded = M.encodeCarte(carte);
writeFileSync(out, JSON.stringify({
  manifest: encoded.manifest,
  chunks: encoded.chunks.map((c) => c.toString('base64')),
}));
const bytes = encoded.chunks.reduce((n, c) => n + c.length, 0);
console.log(`Carte : ${galleries.length} galeries, k = ${params.k}, ` +
  `${params.iterations} passes en ${((t2 - t1) / 1000).toFixed(1)} s ; ` +
  `${(bytes / 1e6).toFixed(2)} Mo compressés en ${encoded.chunks.length} morceaux → ${out}`);
