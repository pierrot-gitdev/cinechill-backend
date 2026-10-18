/* ===================================================================== *
 *  La carte : le catalogue
 *
 *  Les films de la carte sont ceux qu'on peut proposer un soir : au moins
 *  150 votes TMDB et 70 minutes. Ils sont environ 17 500 (mesuré le 18
 *  octobre 2026), dont 5 400 sur les grandes plateformes françaises.
 *
 *  TMDB ne rend que 500 pages (10 000 films) par recherche : la liste se
 *  découpe en fenêtres de dates, coupées en deux tant qu'une fenêtre dépasse
 *  la limite. Les appels passent par une fonction fournie (`fetchPage`) :
 *  le serveur y met son client TMDB et son cache, le banc local le sien.
 *  Rien d'autre n'est appelé ici.
 * ===================================================================== */

import * as fiche from '../cinematch/fiche';
import {CarteFilm} from './model';

/** Une page de `/discover/movie`, réduite à ce qu'on lit. */
export interface DiscoverPage {
  results: {id: number; vote_count?: number; vote_average?: number}[];
  total_results: number;
  total_pages: number;
}

export type FetchPage = (query: Record<string, string>) =>
  Promise<DiscoverPage>;

/** Les seuils du catalogue : ce qu'on peut proposer un soir. */
export const CATALOGUE_MIN_VOTES = 150;
export const CATALOGUE_MIN_RUNTIME = 70;
/** Le plafond de TMDB, avec une marge. */
const MAX_RESULTS = 9800;
const FIRST_YEAR = 1900;

/**
 * Les paramètres communs de toutes les recherches du catalogue.
 * @return {Record<string, string>} Paramètres TMDB.
 */
export function catalogueQuery(): Record<string, string> {
  return {
    'include_adult': 'false',
    'include_video': 'false',
    'vote_count.gte': String(CATALOGUE_MIN_VOTES),
    'with_runtime.gte': String(CATALOGUE_MIN_RUNTIME),
    'sort_by': 'vote_count.desc',
  };
}

/** Ce que la liste dit d'un film : sa réception, relue chaque semaine. */
export interface Listed {
  voteCount: number;
  voteAverage: number;
}

/**
 * Tous les films d'une recherche, page par page.
 * @param {FetchPage} fetchPage Le client TMDB.
 * @param {Record<string, string>} query Paramètres, fenêtre comprise.
 * @param {number} pages Nombre de pages de la recherche.
 * @param {number} concurrency Pages demandées en même temps.
 * @return {Promise<Map<number, Listed>>} Films et réception.
 */
async function allPages(
    fetchPage: FetchPage, query: Record<string, string>, pages: number,
    concurrency: number,
): Promise<Map<number, Listed>> {
  const out = new Map<number, Listed>();
  for (let start = 1; start <= pages; start += concurrency) {
    const batch = [];
    for (let p = start; p < start + concurrency && p <= pages; p++) {
      batch.push(fetchPage({...query, page: String(p)}));
    }
    for (const page of await Promise.all(batch)) {
      for (const row of page.results) {
        if (!Number.isInteger(row.id)) continue;
        out.set(row.id, {
          voteCount: Number(row.vote_count) || 0,
          voteAverage: Number(row.vote_average) || 0,
        });
      }
    }
  }
  return out;
}

/**
 * Tous les films d'une recherche, coupée en fenêtres de dates tant qu'une
 * fenêtre dépasse ce que TMDB peut rendre.
 * @param {FetchPage} fetchPage Le client TMDB.
 * @param {Record<string, string>} base Paramètres de la recherche.
 * @param {number} lastYear La dernière année.
 * @param {number} concurrency Pages demandées en même temps.
 * @return {Promise<Map<number, Listed>>} Films et réception.
 */
async function listWindowed(
    fetchPage: FetchPage, base: Record<string, string>, lastYear: number,
    concurrency: number,
): Promise<Map<number, Listed>> {
  const out = new Map<number, Listed>();
  const windows: [number, number][] = [[FIRST_YEAR, lastYear]];
  while (windows.length > 0) {
    const [from, to] = windows.pop() as [number, number];
    const query = {
      ...base,
      'primary_release_date.gte': `${from}-01-01`,
      'primary_release_date.lte': `${to}-12-31`,
    };
    const first = await fetchPage({...query, page: '1'});
    if (first.total_results > MAX_RESULTS && to > from) {
      const mid = Math.floor((from + to) / 2);
      windows.push([from, mid], [mid + 1, to]);
      continue;
    }
    const pages = Math.min(500, first.total_pages);
    const listed = await allPages(fetchPage, query, pages, concurrency);
    for (const [id, row] of listed) out.set(id, row);
  }
  return out;
}

/**
 * La liste du catalogue, sans doublon.
 * @param {FetchPage} fetchPage Le client TMDB.
 * @param {number} lastYear La dernière année (l'année en cours).
 * @param {number} concurrency Pages demandées en même temps.
 * @return {Promise<Map<number, Listed>>} Films et réception.
 */
export function listCatalogue(
    fetchPage: FetchPage, lastYear: number, concurrency = 8,
): Promise<Map<number, Listed>> {
  return listWindowed(fetchPage, catalogueQuery(), lastYear, concurrency);
}

/**
 * Les films de chaque plateforme, inclus dans l'abonnement en France.
 * @param {FetchPage} fetchPage Le client TMDB.
 * @param {number[]} providerIds Les plateformes.
 * @param {number} lastYear La dernière année.
 * @param {number} concurrency Pages demandées en même temps.
 * @return {Promise<Map<number, number[]>>} Film → plateformes.
 */
export async function listProviderFilms(
    fetchPage: FetchPage, providerIds: number[], lastYear: number,
    concurrency = 8,
): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  for (const provider of providerIds) {
    const query = {
      ...catalogueQuery(),
      'watch_region': 'FR',
      'with_watch_providers': String(provider),
      'with_watch_monetization_types': 'flatrate|free|ads',
    };
    const listed = await listWindowed(fetchPage, query, lastYear, concurrency);
    for (const id of listed.keys()) {
      const list = out.get(id) ?? [];
      if (!list.includes(provider)) list.push(provider);
      out.set(id, list);
    }
  }
  return out;
}

/** Ce que la tâche ajoute à chaque fiche TMDB. */
export const CARTE_DETAIL_APPEND = 'keywords,credits,recommendations';

/**
 * Un film de la carte, depuis sa fiche TMDB (`/movie/{id}` avec
 * `CARTE_DETAIL_APPEND`).
 * @param {Record<string, unknown>} detail La fiche TMDB.
 * @param {number[]} providers Ses plateformes françaises.
 * @param {number} fetchedDay Le jour de lecture de la fiche.
 * @return {CarteFilm} Le film.
 */
export function carteFilmFromDetail(
    detail: Record<string, unknown>, providers: number[], fetchedDay: number,
): CarteFilm {
  const sheet = fiche.ficheFromMovieDetail(detail);
  const year = Number(String(detail.release_date ?? '').slice(0, 4));
  const recommended = (detail.recommendations ?? {}) as {results?: unknown};
  const related = Array.isArray(recommended.results) ?
    (recommended.results as {id?: unknown}[])
        .map((r) => r.id)
        .filter((id): id is number => typeof id === 'number' &&
          Number.isInteger(id)) : [];
  const runtime = Number(detail.runtime);
  return {
    id: sheet.id,
    genres: sheet.genres,
    keywords: sheet.keywords,
    makers: sheet.makers,
    sources: sheet.sources ?? [],
    cast: sheet.cast,
    collection: sheet.collection,
    year: Number.isInteger(year) && year > 1800 ? year : null,
    releaseDate: typeof detail.release_date === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(detail.release_date) ?
      detail.release_date : null,
    runtime: Number.isFinite(runtime) && runtime > 0 ? runtime : null,
    voteCount: sheet.voteCount ?? 0,
    voteAverage: sheet.voteAverage ?? 0,
    providers,
    related,
    fetchedDay,
  };
}

/**
 * La fiche Cinechill d'un film de la carte, pour les comparaisons et les
 * règles qui la lisent (rareté, retouches, remakes).
 * @param {CarteFilm} film Le film.
 * @return {fiche.Fiche} Sa fiche.
 */
export function ficheOfCarteFilm(film: CarteFilm): fiche.Fiche {
  return {
    id: film.id,
    genres: film.genres,
    keywords: film.keywords,
    makers: film.makers,
    sources: film.sources,
    cast: film.cast,
    collection: film.collection,
    decade: film.year === null ? null : Math.floor(film.year / 10) * 10,
    voteAverage: film.voteAverage || null,
    voteCount: film.voteCount || null,
  };
}

/**
 * Les plateformes que l'app propose, par nom TMDB. Ce sont les règles de
 * `StreamingPlatform.curated` côté app ; les identifiants se lisent dans la
 * liste française de TMDB, qui les change parfois.
 */
export const APP_PLATFORM_ALIASES: string[][] = [
  ['netflix'], ['primevideo', 'amazonprimevideo'], ['disneyplus', 'disney+'],
  ['pathehome', 'pathéhome'], ['canal+', 'canalplus'],
  ['appletv', 'appletvplus'], ['hbomax', 'max'],
  ['paramount+', 'paramountplus'], ['arte'], ['tf1plus', 'tf1+'],
  ['molotovtv', 'molotov'],
];

/**
 * Le nom d'une plateforme ramené à sa forme de comparaison, comme dans l'app.
 * @param {string} name Nom TMDB.
 * @return {string} Nom normalisé.
 */
export function normalizeProviderName(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9+]/g, '');
}

/**
 * Les identifiants des plateformes de l'app, lus dans la liste TMDB.
 * @param {Array<{provider_id: number, provider_name: string}>} providers
 *   La liste `/watch/providers/movie` pour la France.
 * @return {number[]} Identifiants retenus.
 */
export function appProviderIds(
    providers: {provider_id: number; provider_name: string}[],
): number[] {
  const out: number[] = [];
  for (const aliases of APP_PLATFORM_ALIASES) {
    const wanted = new Set(aliases.map(normalizeProviderName));
    const match = providers.find((p) =>
      wanted.has(normalizeProviderName(p.provider_name)));
    if (match && !out.includes(match.provider_id)) out.push(match.provider_id);
  }
  return out;
}
