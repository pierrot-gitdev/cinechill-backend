import {setGlobalOptions} from 'firebase-functions/v2/options';
import {onRequest, Request} from 'firebase-functions/v2/https';
import {defineSecret} from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import {Response} from 'express';
import * as admin from 'firebase-admin';

function getAdmin(): typeof admin {
  if (!admin.apps.length) admin.initializeApp();
  return admin;
}

setGlobalOptions({maxInstances: 10, region: 'europe-west1'});

const tmdbApiKey = defineSecret('TMDB_API_KEY');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const DEFAULT_LANGUAGE = 'fr-FR';
const DEFAULT_REGION = 'FR';

/**
 * Error wrapper for non-2xx TMDB responses.
 */
class TMDBRequestError extends Error {
  status: number;
  details: string;

  /**
   * @param {number} status Upstream HTTP status code.
   * @param {string} details Upstream response body.
   */
  constructor(status: number, details: string) {
    super(`TMDB request failed with status ${status}`);
    this.status = status;
    this.details = details;
  }
}

/**
 * Parse and clamp a page query value.
 * @param {unknown} value Raw page query.
 * @return {number} Bounded page number.
 */
function parsePage(value: unknown): number {
  const raw = Number(value ?? 1);
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.min(500, Math.floor(raw)));
}

/**
 * Parse an optional integer query parameter.
 * @param {unknown} value Raw query value.
 * @return {?number} Integer or null when invalid/absent.
 */
function parseOptionalInt(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const raw = Number(value);
  if (!Number.isFinite(raw)) return null;
  return Math.floor(raw);
}

/**
 * Parse provider IDs from query string "1,2,3".
 * @param {unknown} value Raw provider query value.
 * @return {number[]} List of numeric provider IDs.
 */
function parseProviderIDs(value: unknown): number[] {
  if (!value) return [];
  const raw = String(value);
  if (!raw.trim()) return [];
  return raw
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((id) => Number.isFinite(id) && id > 0)
      .map((id) => Math.floor(id));
}

/**
 * Call TMDB API using bearer auth.
 * @param {string} path TMDB endpoint path.
 * @param {Record<string, string>} query Query parameters.
 * @param {string} token TMDB bearer token.
 * @return {Promise<Record<string, unknown>>} Decoded JSON payload.
 */
async function tmdbGET(
    path: string,
    query: Record<string, string>,
    token: string,
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams(query);
  const url = `${TMDB_BASE}${path}?${params.toString()}`;

  const tmdbRes = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!tmdbRes.ok) {
    const details = await tmdbRes.text();
    throw new TMDBRequestError(tmdbRes.status, details);
  }

  return await tmdbRes.json() as Record<string, unknown>;
}

/**
 * Return TMDB error to client when available.
 * @param {unknown} error Caught error.
 * @param {Object} res HTTP response object.
 * @return {boolean} True when handled as TMDB error.
 */
function sendTMDBError(
    error: unknown,
    res: {status: (code: number) =>
      {json: (payload: Record<string, unknown>) => void}},
): boolean {
  if (!(error instanceof TMDBRequestError)) {
    return false;
  }
  logger.error('TMDB upstream error', {
    status: error.status,
    details: error.details,
  });
  res.status(error.status).json({
    error: 'tmdb_error',
    details: error.details,
  });
  return true;
}

export const getPopularMovies = onRequest(
    {secrets: [tmdbApiKey], invoker: 'public'},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'GET') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }

        const page = parsePage(req.query.page);
        const genreID = parseOptionalInt(req.query.genreId);
        const providerIDs = parseProviderIDs(req.query.providerIds);
        const watchRegion = String(req.query.watchRegion ?? DEFAULT_REGION);

        const useDiscover = genreID !== null || providerIDs.length > 0;
        const path = useDiscover ? '/discover/movie' : '/movie/popular';

        const query: Record<string, string> = {
          language: DEFAULT_LANGUAGE,
          page: String(page),
        };

        if (useDiscover) {
          query.sort_by = 'popularity.desc';
          query.include_adult = 'false';
          query.include_video = 'false';
          if (genreID !== null && genreID > 0) {
            query.with_genres = String(genreID);
          }
          if (providerIDs.length > 0) {
            query.watch_region = watchRegion;
            query.with_watch_providers = providerIDs.join('|');
            // Sans ce filtre, TMDB matche n'importe quel type d'offre de la
            // plateforme — y compris location/achat à l'unité. Un film encore
            // en salle mais déjà disponible à la location passerait le filtre
            // alors qu'il n'est pas inclus dans l'abonnement de l'utilisateur.
            query.with_watch_monetization_types = 'flatrate|free|ads';
          }
        }

        const data = await tmdbGET(path, query, tmdbApiKey.value());

        res.status(200).json({
          page: data.page ?? page,
          total_pages: data.total_pages ?? 1,
          results: data.results ?? [],
        });
      } catch (error) {
        if (sendTMDBError(error, res)) {
          return;
        }
        logger.error('getPopularMovies failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

export const getMovieDetails = onRequest(
    {secrets: [tmdbApiKey], invoker: 'public'},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'GET') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }

        const idRaw = Number(req.query.id);
        if (!Number.isFinite(idRaw) || idRaw <= 0) {
          res.status(400).json({error: 'invalid_id'});
          return;
        }

        const id = Math.floor(idRaw);
        const url =
          `https://api.themoviedb.org/3/movie/${id}` +
          '?language=fr-FR&append_to_response=credits,videos,watch%2Fproviders';

        const tmdbRes = await fetch(url, {
          headers: {
            Authorization: `Bearer ${tmdbApiKey.value()}`,
            Accept: 'application/json',
          },
        });

        if (!tmdbRes.ok) {
          const details = await tmdbRes.text();
          logger.error('TMDB detail error', {status: tmdbRes.status, details});
          res.status(tmdbRes.status).json({error: 'tmdb_error', details});
          return;
        }

        const data = await tmdbRes.json();

        const videos = Array.isArray(data.videos?.results) ? data.videos.results : [];
        const trailer = videos.find(
            (v: {type?: string; site?: string}) =>
              v.type === 'Trailer' && v.site === 'YouTube'
          ) ?? videos.find((v: {site?: string}) => v.site === 'YouTube');
        const trailerKey: string | null = (trailer as {key?: string})?.key ?? null;

        const crew = Array.isArray(data.credits?.crew) ? data.credits.crew : [];
        const director: string | null =
          (crew.find((c: {job?: string; name?: string}) =>
            c.job === 'Director') as {name?: string} | undefined)?.name ?? null;

        const cast = Array.isArray(data.credits?.cast) ?
          data.credits.cast.slice(0, 15).map((c: {
            name?: unknown; character?: unknown; profile_path?: unknown
          }) => ({
            name: typeof c.name === 'string' ? c.name : '',
            character: typeof c.character === 'string' ? c.character : null,
            profile_path: typeof c.profile_path === 'string' ? c.profile_path : null,
          })) : [];

        const genreNames: string[] = Array.isArray(data.genres) ?
          data.genres.map((g: {name?: unknown}) =>
            typeof g.name === 'string' ? g.name : ''
          ).filter(Boolean) : [];

        // La saga alimente le badge « L'Intégrale ». Le second appel n'a lieu
        // que pour les films qui appartiennent effectivement à une collection,
        // soit une minorité — le détail d'un film isolé ne coûte rien de plus.
        const collection = data.belongs_to_collection as {id?: number} | null;
        let collectionID: number | null = null;
        let collectionCount: number | null = null;
        if (collection && typeof collection.id === 'number') {
          collectionID = collection.id;
          try {
            const parts = await tmdbGET(`/collection/${collection.id}`,
                {language: DEFAULT_LANGUAGE}, tmdbApiKey.value());
            if (Array.isArray(parts.parts)) collectionCount = parts.parts.length;
          } catch {
            collectionCount = null;
          }
        }

        const frFlatrate = data['watch/providers']?.results?.FR?.flatrate;
        const watchProvidersFR = Array.isArray(frFlatrate) ?
          frFlatrate.map((p: {
            provider_id?: unknown; provider_name?: unknown; logo_path?: unknown
          }) => ({
            provider_id: p.provider_id,
            provider_name: p.provider_name,
            logo_path: p.logo_path ?? null,
          })) : [];

        res.status(200).json({
          id: data.id,
          title: data.title ?? null,
          name: data.name ?? null,
          overview: data.overview ?? null,
          // TMDB les renvoie déjà dans la même réponse — les transmettre ne
          // coûte aucun appel supplémentaire.
          tagline: typeof data.tagline === 'string' && data.tagline ?
            data.tagline : null,
          poster_path: data.poster_path ?? null,
          backdrop_path: data.backdrop_path ?? null,
          vote_average: data.vote_average ?? null,
          vote_count: data.vote_count ?? null,
          runtime: typeof data.runtime === 'number' ? data.runtime : null,
          release_date: data.release_date ?? null,
          first_air_date: data.first_air_date ?? null,
          director,
          trailer_key: trailerKey,
          genre_names: genreNames,
          collection_id: collectionID,
          collection_count: collectionCount,
          credits: {cast},
          watch_providers_fr: watchProvidersFR,
        });
      } catch (error) {
        logger.error('getMovieDetails failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

export const getMovieGenres = onRequest(
    {secrets: [tmdbApiKey], invoker: 'public'},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'GET') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }

        const data = await tmdbGET('/genre/movie/list', {
          language: DEFAULT_LANGUAGE,
        }, tmdbApiKey.value());

        const genres = Array.isArray(data.genres) ? data.genres : [];
        res.status(200).json({genres});
      } catch (error) {
        if (sendTMDBError(error, res)) {
          return;
        }
        logger.error('getMovieGenres failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

export const getMovieProviders = onRequest(
    {secrets: [tmdbApiKey], invoker: 'public'},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'GET') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }

        const watchRegion = String(req.query.watchRegion ?? DEFAULT_REGION);
        const data = await tmdbGET('/watch/providers/movie', {
          language: DEFAULT_LANGUAGE,
          watch_region: watchRegion,
        }, tmdbApiKey.value());

        const providers = Array.isArray(data.results) ? data.results : [];
        res.status(200).json({results: providers});
      } catch (error) {
        if (sendTMDBError(error, res)) {
          return;
        }
        logger.error('getMovieProviders failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

type MediaStatus = 'toWatch' | 'seen' | 'none';

interface MediaItemPayload {
  id: string;
  tmdbId: number;
  mediaType: string;
  title: string;
  posterPath?: string;
  overview?: string;
  voteAverage?: number;
  /** Renseignés depuis la fiche film, qui seule les connaît. Alimentent les
   * badges « Signature » et « L'Intégrale » ; absents ailleurs, sans gravité. */
  director?: string;
  collectionId?: number;
  collectionTotal?: number;
  genreIds: number[];
  releaseDate?: string;
}

export const setMediaStatus = onRequest(
    {invoker: 'public'},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'POST') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }

        const authHeader = req.headers.authorization ?? '';
        const token = authHeader.startsWith('Bearer ') ?
          authHeader.slice(7) : '';
        if (!token) {
          res.status(401).json({error: 'missing_token'});
          return;
        }

        let uid: string;
        try {
          const a = getAdmin();
          const decoded = await a.auth().verifyIdToken(token);
          uid = decoded.uid;
        } catch {
          res.status(401).json({error: 'invalid_token'});
          return;
        }

        const status = req.body?.status as MediaStatus | undefined;
        const item = req.body?.item as MediaItemPayload | undefined;

        if (!status || !['toWatch', 'seen', 'none'].includes(status)) {
          res.status(400).json({error: 'invalid_status'});
          return;
        }
        if (!item?.id || !item?.tmdbId || !item?.mediaType || !item?.title) {
          res.status(400).json({error: 'invalid_item'});
          return;
        }

        const a = getAdmin();
        const db = a.firestore();
        const userRef = db.collection('users').doc(uid);
        const watchlistRef = userRef.collection('watchlist').doc(item.id);
        const galleryRef = userRef.collection('gallery').doc(item.id);

        const batch = db.batch();
        batch.delete(watchlistRef);
        batch.delete(galleryRef);

        const now = a.firestore.Timestamp.now();
        const data = {
          id: item.id,
          tmdbId: item.tmdbId,
          mediaType: item.mediaType,
          title: item.title,
          posterPath: item.posterPath ?? null,
          overview: item.overview ?? null,
          voteAverage: item.voteAverage ?? null,
          director: item.director ?? null,
          collectionId: item.collectionId ?? null,
          collectionTotal: item.collectionTotal ?? null,
          genreIds: item.genreIds ?? [],
          releaseDate: item.releaseDate ?? null,
          addedAt: now,
        };

        if (status === 'toWatch') {
          batch.set(watchlistRef, data);
        } else if (status === 'seen') {
          batch.set(galleryRef, data);
        }

        await batch.commit();
        res.status(200).json({ok: true});
      } catch (error) {
        logger.error('setMediaStatus failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

// ===========================================================================
// CinéMatch — getRecommendations
//
// Filtres durs (genres, plateformes, classification, décrocheur) -> pool
// TMDB multi-tri -> exclusion des films déjà vus/recommandés -> scoring
// pondéré -> sélection avec exploration (softmax) + diversité (MMR) -> top 3.
// Voir la spec produit CinéMatch pour le détail de chaque étape.
// ===========================================================================

/** TMDB genre ids (stables, documentés) utilisés pour le mapping des genres. */
const GENRE_TMDB_IDS: Record<string, number[]> = {
  action: [28],
  comedy: [35],
  drama: [18],
  thriller: [53],
  scifiFantasy: [878, 14],
  horror: [27],
  romance: [10749],
  animation: [16],
  documentary: [99],
};

/** Genres TMDB associés à chaque ambiance (Q4), pour le score, pas le filtre. */
const MOOD_GENRES: Record<string, number[]> = {
  lightFun: [35],
  intense: [28, 53],
  emotional: [18, 10749],
  scary: [27, 53],
  escapist: [12, 14, 878, 28],
  thoughtful: [9648, 878, 18],
};

const GENRE_LABELS_FR: Record<number, string> = {
  28: 'Action',
  12: 'Aventure',
  16: 'Animation',
  35: 'Comédie',
  80: 'Policier',
  99: 'Documentaire',
  18: 'Drame',
  10751: 'Famille',
  14: 'Fantastique',
  36: 'Histoire',
  27: 'Horreur',
  10402: 'Musique',
  9648: 'Mystère',
  10749: 'Romance',
  878: 'Science-fiction',
  10770: 'Téléfilm',
  53: 'Thriller',
  10752: 'Guerre',
  37: 'Western',
};

const GENRE_HORROR = 27;
const GENRE_DRAMA = 18;
const GENRE_DOCUMENTARY = 99;
const GENRE_HISTORY = 36;
const GENRE_WAR = 10752;
const GENRE_ANIMATION = 16;

const POOL_HEALTHY_TARGET = 60;
const POOL_HARD_FLOOR = 20;
const ENRICH_BATCH_MAX = 60;
const RESULT_COUNT = 3;
const SOFTMAX_TEMPERATURE = 9;
const HISTORY_WINDOW_DAYS = 30;
const HISTORY_RUNS_CONSIDERED = 5;

interface QuestionnaireAnswersPayload {
  contentFormat: string;
  genres: string[];
  platformIds: string[];
  watchRegion: string;
  audience: string | null;
  mood: string | null;
  origin: string;
  mindset: string | null;
  dealbreaker: string | null;
  popularity: string;
  cast: string;
  runtime: string;
  era: string;
  surpriseIntensity: number;
  preferredGenreIds: number[];
  avoidedGenreIds: number[];
}

interface DiscoverRow {
  id: number;
  title?: string;
  overview?: string | null;
  poster_path?: string | null;
  vote_average?: number | null;
  vote_count?: number | null;
  popularity?: number | null;
  genre_ids?: number[];
  release_date?: string | null;
  origin_country?: string[];
}

interface EnrichedCandidate extends DiscoverRow {
  runtimeMinutes: number | null;
  belongsToCollection: boolean;
  castPopularities: number[];
  providerIds: number[];
  trailerKey: string | null;
  finalScore: number;
  reasons: string[];
}

/**
 * Parse the JSON questionnaire payload sent by the iOS client, applying safe
 * defaults so a malformed/partial body never crashes the handler.
 * @param {unknown} body Raw request body.
 * @return {QuestionnaireAnswersPayload} Normalized answers.
 */
function parseAnswers(body: unknown): QuestionnaireAnswersPayload {
  const b = (body ?? {}) as Record<string, unknown>;
  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  const strOrNull = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;
  const strOrDefault = (v: unknown, fallback: string): string =>
    typeof v === 'string' && v.length > 0 ? v : fallback;
  const numArray = (v: unknown): number[] =>
    Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
  const numOrDefault = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback;

  return {
    contentFormat: strOrDefault(b.contentFormat, 'liveAction'),
    genres: strArray(b.genres),
    platformIds: strArray(b.platformIds),
    watchRegion: strOrDefault(b.watchRegion, 'FR'),
    audience: strOrNull(b.audience),
    mood: strOrNull(b.mood),
    origin: strOrDefault(b.origin, 'any'),
    mindset: strOrNull(b.mindset),
    dealbreaker: strOrNull(b.dealbreaker),
    popularity: strOrDefault(b.popularity, 'any'),
    cast: strOrDefault(b.cast, 'any'),
    runtime: strOrDefault(b.runtime, 'any'),
    era: strOrDefault(b.era, 'any'),
    surpriseIntensity: numOrDefault(b.surpriseIntensity, 0.5),
    preferredGenreIds: numArray(b.preferredGenreIds),
    avoidedGenreIds: numArray(b.avoidedGenreIds),
  };
}

/**
 * Build the `with_genres` OR-list (TMDB pipe syntax) from the selected genre
 * slugs sent by the client.
 * @param {string[]} genreSlugs Semantic genre slugs (e.g. "action").
 * @return {number[]} Flattened, deduplicated TMDB genre ids.
 */
function genreIdsFor(genreSlugs: string[]): number[] {
  const ids = new Set<number>();
  for (const slug of genreSlugs) {
    for (const id of GENRE_TMDB_IDS[slug] ?? []) ids.add(id);
  }
  return Array.from(ids);
}

/**
 * Filtre dur "dessin animé vs film" (Q1), jamais assoupli. Le sens "liveAction"
 * est déjà exclu au niveau de la requête TMDB (without_genres) ; celui-ci
 * couvre le sens "animated", qui nécessite une vraie contrainte ET avec les
 * genres choisis par ailleurs (impossible à exprimer dans un seul with_genres
 * TMDB) — appliqué ici sur les genre_ids déjà présents dans le pool.
 * @param {DiscoverRow[]} rows Candidats à filtrer.
 * @param {QuestionnaireAnswersPayload} answers Réponses au questionnaire.
 * @return {DiscoverRow[]} Candidats respectant le format demandé.
 */
function filterByContentFormat(
    rows: DiscoverRow[], answers: QuestionnaireAnswersPayload,
): DiscoverRow[] {
  if (answers.contentFormat !== 'animated') return rows;
  return rows.filter((row) => (row.genre_ids ?? []).includes(GENRE_ANIMATION));
}

/**
 * Discover query params shared by every sort strategy — the hard filters.
 * @param {QuestionnaireAnswersPayload} answers Parsed questionnaire answers.
 * @param {Object} relax Which optional hard filters to drop (fallback).
 * @param {boolean} relax.dealbreaker Drop the décrocheur-driven filters.
 * @param {boolean} relax.platforms Drop the watch-provider filter.
 * @return {Record<string, string>} TMDB discover query parameters.
 */
function baseDiscoverParams(
    answers: QuestionnaireAnswersPayload,
    relax: {dealbreaker: boolean; platforms: boolean},
): Record<string, string> {
  const query: Record<string, string> = {
    language: DEFAULT_LANGUAGE,
    include_adult: 'false',
    include_video: 'false',
    'vote_count.gte': '20',
  };

  const genreIds = genreIdsFor(answers.genres);
  if (genreIds.length > 0) {
    query.with_genres = genreIds.join('|');
  }

  const withoutGenres = new Set<number>();
  if (answers.audience === 'family') {
    withoutGenres.add(GENRE_HORROR);
  }
  if (answers.contentFormat === 'liveAction') {
    // "Dessin animé" vs "Film" (Q1) — filtre dur, jamais assoupli. Le sens
    // "animated" est appliqué en aval sur genre_ids (voir getRecommendations),
    // TMDB ne permettant pas de combiner un with_genres en ET avec l'OR déjà
    // utilisé pour les genres choisis par l'utilisateur.
    withoutGenres.add(GENRE_ANIMATION);
  }
  if (!relax.dealbreaker && answers.dealbreaker === 'heavyMood') {
    if (!genreIds.includes(GENRE_WAR)) withoutGenres.add(GENRE_WAR);
    if (!genreIds.includes(GENRE_HISTORY)) withoutGenres.add(GENRE_HISTORY);
  }
  if (withoutGenres.size > 0) {
    query.without_genres = Array.from(withoutGenres).join(',');
  }

  if (!relax.dealbreaker && answers.dealbreaker === 'slowPace') {
    query['vote_count.gte'] = '300';
  }
  if (!relax.dealbreaker && answers.dealbreaker === 'tooLong') {
    query['with_runtime.lte'] = '110';
  }

  if (!relax.platforms && answers.platformIds.length > 0) {
    query.watch_region = answers.watchRegion ?? 'FR';
    query.with_watch_providers = answers.platformIds.join('|');
    // Même correctif que getPopularMovies : exclure location/achat pour ne
    // garder que ce que l'abonnement couvre réellement.
    query.with_watch_monetization_types = 'flatrate|free|ads';
  }

  return query;
}

/**
 * Fetch a merged, deduplicated candidate pool from TMDB discover using three
 * different sort strategies (popularity, note, date) so the pool doesn't
 * always surface the same handful of blockbusters — see the "pool fusionné"
 * requirement in the spec.
 * @param {QuestionnaireAnswersPayload} answers Parsed questionnaire answers.
 * @param {Object} relax Which hard filters to relax.
 * @param {boolean} relax.dealbreaker See baseDiscoverParams.
 * @param {boolean} relax.platforms See baseDiscoverParams.
 * @param {string} token TMDB bearer token.
 * @return {Promise<DiscoverRow[]>} Deduplicated candidate rows.
 */
async function fetchCandidatePool(
    answers: QuestionnaireAnswersPayload,
    relax: {dealbreaker: boolean; platforms: boolean},
    token: string,
): Promise<DiscoverRow[]> {
  const base = baseDiscoverParams(answers, relax);
  const sorts = ['popularity.desc', 'vote_average.desc', 'primary_release_date.desc'];
  const pagesPerSort = 2;

  const requests: Promise<Record<string, unknown>>[] = [];
  for (const sortBy of sorts) {
    for (let page = 1; page <= pagesPerSort; page++) {
      const query: Record<string, string> = {
        ...base,
        sort_by: sortBy,
        page: String(page),
      };
      if (sortBy === 'vote_average.desc' && !query['vote_count.gte']) {
        query['vote_count.gte'] = '100';
      }
      requests.push(tmdbGET('/discover/movie', query, token));
    }
  }

  const responses = await Promise.allSettled(requests);
  const byId = new Map<number, DiscoverRow>();
  for (const settled of responses) {
    if (settled.status !== 'fulfilled') continue;
    const results = Array.isArray(settled.value.results) ?
      settled.value.results as DiscoverRow[] : [];
    for (const row of results) {
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
  }
  return Array.from(byId.values());
}

/**
 * Fetch the ids of movies to exclude because the user already marked them
 * seen/to-watch, or because they were already shown in a recent CinéMatch
 * run — the anti-repetition mechanism described in the spec.
 * @param {admin.firestore.Firestore} db Firestore instance.
 * @param {string} uid Authenticated user id.
 * @return {Promise<Set<number>>} TMDB ids to exclude from the pool.
 */
async function fetchExclusionSet(
    db: admin.firestore.Firestore,
    uid: string,
): Promise<Set<number>> {
  const userRef = db.collection('users').doc(uid);
  const cutoff = admin.firestore.Timestamp.fromMillis(
      Date.now() - HISTORY_WINDOW_DAYS * 24 * 3600 * 1000,
  );

  const [watchlistSnap, gallerySnap, historySnap] = await Promise.all([
    userRef.collection('watchlist').get(),
    userRef.collection('gallery').get(),
    userRef.collection('recommendationHistory')
        .where('createdAt', '>=', cutoff)
        .orderBy('createdAt', 'desc')
        .limit(HISTORY_RUNS_CONSIDERED)
        .get(),
  ]);

  const excluded = new Set<number>();
  for (const doc of watchlistSnap.docs) {
    const id = doc.get('tmdbId');
    if (typeof id === 'number') excluded.add(id);
  }
  for (const doc of gallerySnap.docs) {
    const id = doc.get('tmdbId');
    if (typeof id === 'number') excluded.add(id);
  }
  for (const doc of historySnap.docs) {
    const ids = doc.get('tmdbIds');
    if (Array.isArray(ids)) {
      for (const id of ids) if (typeof id === 'number') excluded.add(id);
    }
  }
  return excluded;
}

/**
 * Score a single 0..1 criterion from a raw value and its ideal band, with a
 * linear falloff outside the band instead of a hard cliff.
 * @param {number} value Observed value.
 * @param {number} min Lower bound of the ideal band.
 * @param {number} max Upper bound of the ideal band.
 * @param {number} falloff Distance over which the score decays to 0.
 * @return {number} Score between 0 and 1.
 */
function bandScore(
    value: number, min: number, max: number, falloff: number,
): number {
  if (value >= min && value <= max) return 1;
  const distance = value < min ? min - value : value - max;
  return Math.max(0, 1 - distance / falloff);
}

/**
 * Ambiance — recouvrement entre les genres du film et les genres associés à
 * l'ambiance choisie, affiné par les comparaisons directes entre affiches
 * (`preferredGenreIds`/`avoidedGenreIds`, alimentées par `PairwiseComparisonView`
 * côté client) plutôt qu'un critère séparé. Poids : 30.
 * @param {number[]} genreIds Genres TMDB du film.
 * @param {string | null} mood Ambiance choisie.
 * @param {number[]} preferredGenreIds Genres des films choisis en comparaison directe.
 * @param {number[]} avoidedGenreIds Genres des films écartés en comparaison directe.
 * @return {number} Score 0..1.
 */
function ambianceScore(
    genreIds: number[],
    mood: string | null,
    preferredGenreIds: number[],
    avoidedGenreIds: number[],
): number {
  let score = 0.5;
  if (mood) {
    const moodGenres = MOOD_GENRES[mood] ?? [];
    score = genreIds.some((id) => moodGenres.includes(id)) ? 1 : 0.3;
  }
  if (preferredGenreIds.some((id) => genreIds.includes(id))) {
    score = Math.min(1, score + 0.2);
  }
  if (avoidedGenreIds.some((id) => genreIds.includes(id))) {
    score = Math.max(0, score - 0.2);
  }
  return score;
}

/**
 * Qualité (blockbuster/pépite, Q8) — combine note moyenne et popularité
 * selon la préférence exprimée. Poids : 15.
 * @param {number | null} voteAverage Note moyenne TMDB (0-10).
 * @param {number | null} voteCount Nombre de votes TMDB.
 * @param {number | null} popularity Popularité TMDB.
 * @param {string} preference Préférence blockbuster/pépite.
 * @return {number} Score 0..1.
 */
function qualityScore(
    voteAverage: number | null,
    voteCount: number | null,
    popularity: number | null,
    preference: string,
): number {
  const quality = Math.max(0, Math.min(1, (voteAverage ?? 5) / 10));
  const popNorm = Math.max(0, Math.min(1, (popularity ?? 0) / 300));
  const wellKnown = (voteCount ?? 0) >= 500;

  switch (preference) {
    case 'mainstream':
      return 0.35 * quality + 0.65 * popNorm;
    case 'wellRatedKnown':
      return wellKnown ? quality : quality * 0.6;
    case 'hiddenGem':
      return (voteCount ?? 0) >= 20 ? 0.7 * quality + 0.3 * (1 - popNorm) : quality * 0.5;
    default:
      return quality;
  }
}

/**
 * Origine (Q5) — bonus/malus selon que le film est français ou non. Neutre
 * si la donnée est absente ou si l'utilisateur a répondu "peu importe".
 * Poids : 10.
 * @param {string[] | undefined} originCountry Pays d'origine TMDB.
 * @param {string} origin Préférence exprimée (french/international/any).
 * @return {number} Score 0..1.
 */
function originScore(originCountry: string[] | undefined, origin: string): number {
  if (origin === 'any' || !originCountry || originCountry.length === 0) return 0.5;
  const isFrench = originCountry.includes('FR');
  if (origin === 'french') return isFrench ? 1 : 0.15;
  if (origin === 'international') return isFrench ? 0.15 : 1;
  return 0.5;
}

/**
 * Époque (Q9) — distance entre la date de sortie et la période demandée.
 * Poids : 10.
 * @param {string | null | undefined} releaseDate Date de sortie TMDB.
 * @param {string} era Préférence d'époque.
 * @param {number | null} voteCount Nombre de votes (pour juger un "classique").
 * @return {number} Score 0..1.
 */
function eraScore(
    releaseDate: string | null | undefined,
    era: string,
    voteCount: number | null,
): number {
  const year = releaseDate ? Number(releaseDate.slice(0, 4)) : NaN;
  if (!Number.isFinite(year) || era === 'any') return 0.5;
  const currentYear = new Date().getFullYear();
  const age = currentYear - year;

  if (era === 'thisYear') return bandScore(age, 0, 0, 4);
  if (era === 'lastFiveYears') return bandScore(age, 0, 5, 6);
  if (era === 'cultClassic') {
    const base = Math.max(0, Math.min(1, age / 40));
    return (voteCount ?? 0) >= 200 ? base : Math.min(base, 0.4);
  }
  return 0.5;
}

/**
 * État d'esprit (Q6) — la partie calculable sans le détail du film
 * (belongs_to_collection est raffiné à l'étape d'enrichissement). Poids : 15.
 * @param {number[]} genreIds Genres TMDB du film.
 * @param {number | null} popularity Popularité TMDB.
 * @param {string | null} mindset Préférence exprimée.
 * @return {number} Score 0..1.
 */
function coarseMindsetScore(
    genreIds: number[],
    popularity: number | null,
    mindset: string | null,
): number {
  if (!mindset) return 0.5;
  switch (mindset) {
    case 'noThinking':
      return Math.max(0, Math.min(1, (popularity ?? 0) / 300));
    case 'seeMyself':
      return genreIds.includes(GENRE_DRAMA) ? 0.8 : 0.3;
    case 'learnSomething':
      return genreIds.includes(GENRE_DOCUMENTARY) || genreIds.includes(GENRE_HISTORY) ?
        1 : 0.2;
    case 'beSurprised':
      return 0.5; // Raffiné une fois belongs_to_collection connu.
    default:
      return 0.5;
  }
}

/**
 * Durée (Q7) — écart entre le runtime réel et la fenêtre demandée.
 * Poids : 10. Nécessite le détail du film (non fourni par /discover).
 * @param {number | null} runtimeMinutes Durée du film en minutes.
 * @param {string} preference Préférence de durée.
 * @return {number} Score 0..1.
 */
function runtimeScore(runtimeMinutes: number | null, preference: string): number {
  if (runtimeMinutes === null || preference === 'any') return 0.5;
  if (preference === 'short') return bandScore(runtimeMinutes, 0, 95, 25);
  if (preference === 'medium') return bandScore(runtimeMinutes, 90, 125, 20);
  if (preference === 'long') return bandScore(runtimeMinutes, 120, 400, 25);
  return 0.5;
}

/**
 * Casting (Q10) — popularité moyenne des 5 premiers rôles vs. préférence
 * visages connus/découverte. Poids : 10.
 * @param {number[]} castPopularities Popularité des acteurs principaux.
 * @param {string} preference Préférence exprimée.
 * @return {number} Score 0..1.
 */
function castScore(castPopularities: number[], preference: string): number {
  if (preference === 'any' || castPopularities.length === 0) return 0.5;
  const avg = castPopularities.reduce((a, b) => a + b, 0) / castPopularities.length;
  const norm = Math.max(0, Math.min(1, avg / 20));
  return preference === 'familiarFaces' ? norm : 1 - norm;
}

/**
 * Curseur "intensité de surprise" (question adaptative indépendante de `mindset`) — ajuste
 * `mindsetSub` autour de sa valeur neutre. Le curseur au centre (0.5, valeur par défaut si jamais
 * posée) laisse `base` inchangé — comportement identique à avant l'introduction du curseur. Plus
 * l'intensité voulue est haute, plus la pénalité franchise se creuse ; en dessous de 0.5, elle
 * s'adoucit. Effet modeste (±0.15 maxi) car secondaire à `mindset`, la source de vérité.
 * @param {number} base Sous-score état d'esprit avant ajustement.
 * @param {boolean} belongsToCollection Si le film appartient à une franchise/collection.
 * @param {number} intensity Intensité de surprise voulue, 0..1 (0.5 = neutre).
 * @return {number} Sous-score ajusté, borné 0..1.
 */
function applySurpriseIntensity(
    base: number, belongsToCollection: boolean, intensity: number,
): number {
  const delta = intensity - 0.5;
  const adjustment = belongsToCollection ? -delta * 0.3 : delta * 0.1;
  return Math.max(0, Math.min(1, base + adjustment));
}

/**
 * Combine les 7 critères pondérés (section 04 de la spec) en un score final
 * sur 100, en excluant le "état d'esprit = surprise" des franchises.
 * @param {EnrichedCandidate} c Candidat enrichi (détail TMDB inclus).
 * @param {QuestionnaireAnswersPayload} answers Réponses au questionnaire.
 * @return {number} Score final 0..100.
 */
function finalWeightedScore(
    c: EnrichedCandidate, answers: QuestionnaireAnswersPayload,
): number {
  const mindset = answers.mindset;
  const mindsetSub = applySurpriseIntensity(
      mindset === 'beSurprised' ?
        (c.belongsToCollection ? 0.15 : 1) :
        coarseMindsetScore(c.genre_ids ?? [], c.popularity ?? null, mindset),
      c.belongsToCollection,
      answers.surpriseIntensity,
  );

  const weighted =
    0.30 * ambianceScore(
        c.genre_ids ?? [], answers.mood, answers.preferredGenreIds, answers.avoidedGenreIds,
    ) +
    0.15 * mindsetSub +
    0.15 * qualityScore(c.vote_average ?? null, c.vote_count ?? null, c.popularity ?? null, answers.popularity) +
    0.10 * originScore(c.origin_country, answers.origin) +
    0.10 * castScore(c.castPopularities, answers.cast) +
    0.10 * eraScore(c.release_date, answers.era, c.vote_count ?? null) +
    0.10 * runtimeScore(c.runtimeMinutes, answers.runtime);

  return Math.round(weighted * 100);
}

/**
 * Construit les tags "pourquoi ce film" affichés à l'utilisateur, à partir
 * de faits vérifiables sur le film plutôt que d'expliquer la formule.
 * @param {EnrichedCandidate} c Candidat enrichi.
 * @param {QuestionnaireAnswersPayload} answers Réponses au questionnaire.
 * @return {string[]} Jusqu'à 4 tags courts.
 */
function buildReasons(
    c: EnrichedCandidate, answers: QuestionnaireAnswersPayload,
): string[] {
  const reasons: string[] = [];
  const genreIds = c.genre_ids ?? [];
  const chosenGenreIds = genreIdsFor(answers.genres);

  for (const id of genreIds) {
    if (chosenGenreIds.includes(id) && GENRE_LABELS_FR[id]) {
      reasons.push(GENRE_LABELS_FR[id]);
    }
    if (reasons.length >= 2) break;
  }

  if (c.runtimeMinutes !== null) {
    if (c.runtimeMinutes <= 95) reasons.push('< 1h35');
    else if (c.runtimeMinutes >= 125) reasons.push('2h +');
  }

  if ((c.vote_average ?? 0) >= 7.5) reasons.push('Bien noté');

  const matchedProvider = answers.platformIds.find((id) =>
    c.providerIds.includes(Number(id)));
  if (matchedProvider) reasons.push('Disponible sur votre plateforme');

  if (reasons.length === 0) reasons.push('Sélection CinéMatch');
  return reasons.slice(0, 4);
}

/**
 * Fetch le détail TMDB (runtime, casting, collection, providers FR) pour un
 * candidat de la shortlist — une seule requête par film grâce à
 * append_to_response.
 * @param {DiscoverRow} row Ligne issue du pool /discover.
 * @param {string} token TMDB bearer token.
 * @return {Promise<EnrichedCandidate | null>} Candidat enrichi, ou null en
 *   cas d'échec (le film est alors simplement ignoré).
 */
async function enrichCandidate(
    row: DiscoverRow, token: string,
): Promise<EnrichedCandidate | null> {
  try {
    const detail = await tmdbGET(`/movie/${row.id}`, {
      language: DEFAULT_LANGUAGE,
      append_to_response: 'credits,videos,watch/providers',
    }, token);

    const creditsCast = (detail.credits as {cast?: unknown} | undefined)?.cast;
    const cast: {popularity?: number}[] = Array.isArray(creditsCast) ?
      creditsCast as {popularity?: number}[] : [];
    const castPopularities = cast
        .slice(0, 5)
        .map((member) => member.popularity)
        .filter((p): p is number => typeof p === 'number');

    const frProviders = (detail['watch/providers'] as {
      results?: {FR?: {flatrate?: {provider_id?: number}[]}}
    } | undefined)?.results?.FR?.flatrate ?? [];
    const providerIds = frProviders
        .map((p) => p.provider_id)
        .filter((id): id is number => typeof id === 'number');

    const videos = Array.isArray((detail.videos as {results?: unknown} | undefined)?.results) ?
      (detail.videos as {results: {type?: string; site?: string; key?: string}[]}).results : [];
    const trailer = videos.find((v) => v.type === 'Trailer' && v.site === 'YouTube') ??
      videos.find((v) => v.site === 'YouTube');
    const trailerKey = trailer?.key ?? null;

    return {
      ...row,
      runtimeMinutes: typeof detail.runtime === 'number' ? detail.runtime : null,
      belongsToCollection: detail.belongs_to_collection !== null &&
        detail.belongs_to_collection !== undefined,
      castPopularities,
      providerIds,
      trailerKey,
      finalScore: 0,
      reasons: [],
    };
  } catch (error) {
    logger.warn('enrichCandidate failed, skipping', {id: row.id, error});
    return null;
  }
}

/**
 * Sélectionne 3 candidats parmi la shortlist enrichie, avec exploration
 * (softmax pondéré par score plutôt qu'un argmax strict) et diversité (MMR :
 * pénalité si trop proche d'un candidat déjà retenu).
 * @param {EnrichedCandidate[]} shortlist Candidats triés par score décroissant.
 * @return {EnrichedCandidate[]} Jusqu'à 3 candidats sélectionnés.
 */
function selectWithExplorationAndDiversity(
    shortlist: EnrichedCandidate[],
): EnrichedCandidate[] {
  const picked: EnrichedCandidate[] = [];
  const remaining = [...shortlist];

  while (picked.length < RESULT_COUNT && remaining.length > 0) {
    const pool = remaining.slice(0, Math.max(8, RESULT_COUNT));
    const adjusted = pool.map((candidate) => {
      const penalty = picked.reduce((sum, p) => {
        const sharedGenres = (candidate.genre_ids ?? [])
            .filter((g) => (p.genre_ids ?? []).includes(g)).length;
        const sameDecade = candidate.release_date && p.release_date &&
          Math.floor(Number(candidate.release_date.slice(0, 4)) / 10) ===
          Math.floor(Number(p.release_date.slice(0, 4)) / 10);
        return sum + (sharedGenres >= 2 ? 15 : 0) + (sameDecade ? 5 : 0);
      }, 0);
      return {candidate, adjustedScore: Math.max(1, candidate.finalScore - penalty)};
    });

    const chosen = softmaxPick(adjusted);
    picked.push(chosen.candidate);
    const idx = remaining.findIndex((c) => c.id === chosen.candidate.id);
    if (idx >= 0) remaining.splice(idx, 1);
  }

  return picked;
}

/**
 * Weighted random pick using a softmax over the candidates' adjusted score —
 * favors high scores without being a strict, always-identical argmax.
 * @param {{candidate: EnrichedCandidate, adjustedScore: number}[]} items
 *   Candidates with their diversity-adjusted score.
 * @return {{candidate: EnrichedCandidate, adjustedScore: number}} The picked
 *   item.
 */
function softmaxPick<T extends {adjustedScore: number}>(items: T[]): T {
  const weights = items.map((i) => Math.exp(i.adjustedScore / SOFTMAX_TEMPERATURE));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * Verify the Firebase bearer token on a request, sending the appropriate
 * error response and returning null if it's missing/invalid.
 * @param {Request} req Incoming request.
 * @param {Response} res Response to write an error to on failure.
 * @return {Promise<string | null>} The authenticated uid, or null.
 */
async function verifyAuth(req: Request, res: Response): Promise<string | null> {
  const authHeader = req.headers.authorization ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    res.status(401).json({error: 'missing_token'});
    return null;
  }
  try {
    const a = getAdmin();
    return (await a.auth().verifyIdToken(token)).uid;
  } catch {
    res.status(401).json({error: 'invalid_token'});
    return null;
  }
}

/** JSON shape of a `DiscoverRow` as sent to/echoed back by the client. */
function discoverRowToJSON(row: DiscoverRow) {
  return {
    id: row.id,
    title: row.title ?? null,
    overview: row.overview ?? null,
    poster_path: row.poster_path ?? null,
    vote_average: row.vote_average ?? null,
    vote_count: row.vote_count ?? null,
    popularity: row.popularity ?? null,
    genre_ids: row.genre_ids ?? [],
    release_date: row.release_date ?? null,
    origin_country: row.origin_country ?? [],
  };
}

/**
 * Phase A (voir la spec "moteur de préférence actif") — filtres durs du
 * socle (T1-T4) uniquement : contentFormat, genres, plateformes, audience.
 * Le décrocheur (dealbreaker) n'existe pas encore à ce stade, il est posé
 * plus tard côté client — `parseAnswers` le laisse simplement à `null`, ce
 * qui désactive naturellement les branches qui en dépendent dans
 * `baseDiscoverParams`.
 */
export const getCandidatePool = onRequest(
    {secrets: [tmdbApiKey], invoker: 'public', timeoutSeconds: 30},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'POST') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const answers = parseAnswers(req.body);
        const a = getAdmin();
        const db = a.firestore();

        const [exclusionSet, declared, rawPool] = await Promise.all([
          fetchExclusionSet(db, uid),
          fetchDeclaredProfile(db, uid),
          fetchCandidatePool(answers, {dealbreaker: true, platforms: false}, tmdbApiKey.value()),
        ]);

        // Les genres bannis dans les réglages ne sont jamais assouplis, même
        // quand le vivier est trop maigre : c'est le sens de « jamais ».
        const keep = (row: DiscoverRow): boolean =>
          !exclusionSet.has(row.id) &&
          !(row.genre_ids ?? []).some((id) => declared.bannedGenreIDs.has(id));

        let pool = filterByContentFormat(rawPool.filter(keep), answers);
        let notice: string | null = null;

        if (pool.length < POOL_HARD_FLOOR && answers.platformIds.length > 0) {
          const relaxed = await fetchCandidatePool(
              answers, {dealbreaker: true, platforms: true}, tmdbApiKey.value(),
          );
          pool = filterByContentFormat(relaxed.filter(keep), answers);
          notice = 'Résultats élargis hors de vos plateformes habituelles.';
        }
        if (!notice && pool.length < POOL_HEALTHY_TARGET) {
          logger.info('getCandidatePool: below healthy pool target', {
            uid, poolSize: pool.length, target: POOL_HEALTHY_TARGET,
          });
        }

        res.status(200).json({
          candidates: pool.map(discoverRowToJSON),
          notice,
        });
      } catch (error) {
        if (sendTMDBError(error, res)) return;
        logger.error('getCandidatePool failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

/**
 * Phase B — enrichit un lot de candidats (déjà réduit côté client, voir la
 * spec) avec les champs indisponibles sur les endpoints de liste TMDB :
 * durée, casting, franchise, bande-annonce, plateformes.
 */
export const enrichCandidates = onRequest(
    {secrets: [tmdbApiKey], invoker: 'public', timeoutSeconds: 30},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'POST') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const body = (req.body ?? {}) as Record<string, unknown>;
        const rawCandidates = Array.isArray(body.candidates) ? body.candidates : [];
        const rows: DiscoverRow[] = rawCandidates
            .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
            .map((c) => ({
              id: Number(c.id),
              title: typeof c.title === 'string' ? c.title : undefined,
              overview: typeof c.overview === 'string' ? c.overview : null,
              poster_path: typeof c.poster_path === 'string' ? c.poster_path : null,
              vote_average: typeof c.vote_average === 'number' ? c.vote_average : null,
              vote_count: typeof c.vote_count === 'number' ? c.vote_count : null,
              popularity: typeof c.popularity === 'number' ? c.popularity : null,
              genre_ids: Array.isArray(c.genre_ids) ? c.genre_ids as number[] : [],
              release_date: typeof c.release_date === 'string' ? c.release_date : null,
              origin_country: Array.isArray(c.origin_country) ? c.origin_country as string[] : [],
            }))
            .filter((row) => Number.isFinite(row.id));

        if (rows.length === 0) {
          res.status(400).json({error: 'no_candidates'});
          return;
        }
        if (rows.length > ENRICH_BATCH_MAX) {
          res.status(400).json({error: 'too_many_candidates', max: ENRICH_BATCH_MAX});
          return;
        }

        const enrichedResults = await Promise.allSettled(
            rows.map((row) => enrichCandidate(row, tmdbApiKey.value())),
        );
        const enriched = enrichedResults
            .filter((r): r is PromiseFulfilledResult<EnrichedCandidate | null> =>
              r.status === 'fulfilled')
            .map((r) => r.value)
            .filter((c): c is EnrichedCandidate => c !== null);

        res.status(200).json({
          candidates: enriched.map((c) => ({
            ...discoverRowToJSON(c),
            runtime_minutes: c.runtimeMinutes,
            belongs_to_collection: c.belongsToCollection,
            cast_popularities: c.castPopularities,
            provider_ids: c.providerIds,
            trailer_key: c.trailerKey,
          })),
        });
      } catch (error) {
        if (sendTMDBError(error, res)) return;
        logger.error('enrichCandidates failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

/**
 * Phase D — reçoit le pool déjà enrichi et réduit côté client (fin du
 * parcours, par confiance ou par choix de l'utilisateur) avec l'ensemble des
 * réponses collectées, applique le scoring pondéré final, la diversité (MMR)
 * et l'exploration (softmax), persiste l'historique, renvoie le top 3.
 */
export const finalizeRecommendations = onRequest(
    {invoker: 'public', timeoutSeconds: 30},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'POST') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const body = (req.body ?? {}) as Record<string, unknown>;
        const answers = parseAnswers(body.answers);
        const rawCandidates = Array.isArray(body.candidates) ? body.candidates : [];

        let shortlist: EnrichedCandidate[] = rawCandidates
            .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
            .map((c) => ({
              id: Number(c.id),
              title: typeof c.title === 'string' ? c.title : undefined,
              overview: typeof c.overview === 'string' ? c.overview : null,
              poster_path: typeof c.poster_path === 'string' ? c.poster_path : null,
              vote_average: typeof c.vote_average === 'number' ? c.vote_average : null,
              vote_count: typeof c.vote_count === 'number' ? c.vote_count : null,
              popularity: typeof c.popularity === 'number' ? c.popularity : null,
              genre_ids: Array.isArray(c.genre_ids) ? c.genre_ids as number[] : [],
              release_date: typeof c.release_date === 'string' ? c.release_date : null,
              origin_country: Array.isArray(c.origin_country) ? c.origin_country as string[] : [],
              runtimeMinutes: typeof c.runtime_minutes === 'number' ? c.runtime_minutes : null,
              belongsToCollection: c.belongs_to_collection === true,
              castPopularities: Array.isArray(c.cast_popularities) ? c.cast_popularities as number[] : [],
              providerIds: Array.isArray(c.provider_ids) ? c.provider_ids as number[] : [],
              trailerKey: typeof c.trailer_key === 'string' ? c.trailer_key : null,
              finalScore: 0,
              reasons: [],
            }))
            .filter((row) => Number.isFinite(row.id));

        if (shortlist.length === 0) {
          res.status(400).json({error: 'no_candidates'});
          return;
        }

        // "predictablePlot" est un filtre dur : on retire les suites/sagas,
        // sauf si ça viderait la shortlist (jamais de résultat vide).
        if (answers.dealbreaker === 'predictablePlot') {
          const withoutFranchises = shortlist.filter((c) => !c.belongsToCollection);
          if (withoutFranchises.length >= RESULT_COUNT) {
            shortlist = withoutFranchises;
          }
        }

        shortlist = shortlist
            .map((c) => ({...c, finalScore: finalWeightedScore(c, answers)}))
            .sort((a, b) => b.finalScore - a.finalScore);

        // L'exploration (softmax) choisit délibérément les 3 films dans un ordre
        // non strictement trié — on re-trie par score pour l'affichage (#1/#2/#3)
        // sans changer *lesquels* des 3 films ont été sélectionnés.
        const selected = selectWithExplorationAndDiversity(shortlist)
            .sort((a, b) => b.finalScore - a.finalScore)
            .map((c) => ({...c, reasons: buildReasons(c, answers)}));

        const a = getAdmin();
        await a.firestore().collection('users').doc(uid)
            .collection('recommendationHistory').add({
              createdAt: a.firestore.Timestamp.now(),
              tmdbIds: selected.map((c) => c.id),
              answers,
            });

        res.status(200).json({
          results: selected.map((c) => ({
            id: c.id,
            title: c.title ?? 'Sans titre',
            poster_path: c.poster_path ?? null,
            overview: c.overview ?? null,
            vote_average: c.vote_average ?? null,
            genre_ids: c.genre_ids ?? [],
            release_date: c.release_date ?? null,
            match_score: c.finalScore,
            reasons: c.reasons,
            trailer_key: c.trailerKey,
            provider_ids: c.providerIds,
          })),
        });
      } catch (error) {
        logger.error('finalizeRecommendations failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

// ===========================================================================
// Swipe — getSwipeFeed / recordSwipes
//
// Alimente le deck de swipe. Construit un profil de goût à partir de la
// galerie et des compteurs de swipe, tire des candidats sur cinq sources TMDB
// complémentaires, exclut ce que l'utilisateur a déjà classé ou écarté
// récemment, puis ordonne par « probabilité qu'il l'ait vu » × « correspond à
// son style ». Voir le plan produit Swipe pour le détail de chaque étape.
// ===========================================================================

/** Nombre de cartes renvoyées par lot. */
const SWIPE_FEED_SIZE = 25;
/** Films de la galerie utilisés comme graines de `/recommendations`. */
const SWIPE_SEEDS_RECOMMENDATIONS = 4;
/** Films de la galerie utilisés comme graines de `/similar`. */
const SWIPE_SEEDS_SIMILAR = 2;
/** Films dont on charge le détail (franchise + casting, un seul appel). */
const SWIPE_SEEDS_DETAILS = 2;
/** Plancher de notoriété quand le profil est déjà nourri. */
const SWIPE_VOTE_COUNT_FLOOR = 500;
/** Plancher de notoriété à froid — on ne propose que du très vu. */
const SWIPE_COLD_VOTE_COUNT_FLOOR = 3000;
/** Taille de galerie à partir de laquelle le profil est jugé mature. */
const SWIPE_PROFILE_MATURE_SIZE = 30;
/** Galerie en-dessous de laquelle les poids de genre restent neutres. */
const SWIPE_PROFILE_MIN_SIZE = 8;
/** Cooldown de base d'un film écarté, doublé à chaque nouveau skip. */
const SWIPE_SKIP_BASE_COOLDOWN_DAYS = 14;
/** Plafond du cooldown — au-delà le film ne revient plus en pratique. */
const SWIPE_SKIP_MAX_COOLDOWN_DAYS = 180;
/** Nombre max d'exclusions « skip » chargées par appel. */
const SWIPE_MAX_ACTIVE_SKIPS = 1000;
/** Cartes précédentes prises en compte par la pénalité de diversité. */
const SWIPE_DIVERSITY_WINDOW = 3;
/** Décisions acceptées en un seul appel à `recordSwipes`. */
const SWIPE_MAX_DECISIONS = 40;
/** Graines de galerie parmi lesquelles on tire (biais vers les récents). */
const SWIPE_SEED_POOL_RECENT = 25;
const SWIPE_SEED_POOL_OLDER = 10;

/** D'où vient un candidat — sert aux quotas de mix et au debug. */
type SwipeSource =
  | 'neighbors'
  | 'profile'
  | 'pillars'
  | 'franchise'
  | 'people'
  | 'exploration';

interface SwipeCandidate extends DiscoverRow {
  source: SwipeSource;
  score: number;
}

/**
 * Profil de goût dérivé de la galerie (ce que l'utilisateur a vu) et des
 * compteurs de swipe (ce qu'il reconnaît ou pas). Les deux se complètent : la
 * galerie dit le style, les compteurs disent où il a réellement du vécu.
 */
interface TasteProfile {
  gallerySize: number;
  /** Poids 0..1 par genre TMDB, normalisés sur le genre dominant. */
  genreWeights: Map<number, number>;
  /** Poids 0..1 par décennie (1990, 2000, ...). */
  decadeWeights: Map<number, number>;
  /** Note TMDB moyenne des films de la galerie. */
  meanRating: number;
  /** log10 du vote_count médian de la galerie — le niveau de « niche ». */
  medianLogVoteCount: number | null;
  /** ids TMDB tirés de la galerie pour servir de graines. */
  seedIds: number[];
  /** Ratio lissé vu/(vu+écarté) par genre — module le goût. */
  genreLikeRatio: Map<number, number>;
  /** Ratio lissé vu/(vu+écarté) par décennie — module la probabilité de vu. */
  decadeSeenRatio: Map<number, number>;
  /** Ce que l'utilisateur a déclaré dans les réglages. */
  declared: DeclaredProfile;
}

/** Compteurs agrégés persistés dans `preferences/swipeProfile`. */
interface SwipeCounters {
  genreSeen: Record<string, number>;
  genreWanted: Record<string, number>;
  genreSkipped: Record<string, number>;
  decadeSeen: Record<string, number>;
  decadeSkipped: Record<string, number>;
}

/**
 * Ce que l'utilisateur a déclaré lui-même dans les réglages, par opposition à
 * ce que l'app déduit de ses swipes. Lu côté serveur plutôt que transmis par le
 * client : une règle « jamais d'horreur » ne doit pas pouvoir être contournée
 * selon l'écran d'où part la requête.
 */
interface DeclaredProfile {
  bannedGenreIDs: Set<number>;
  /** Décennie de naissance (1970, 1980, …), ou null si non renseignée. */
  birthDecade: number | null;
}

const EMPTY_DECLARED_PROFILE: DeclaredProfile = {
  bannedGenreIDs: new Set<number>(),
  birthDecade: null,
};

/**
 * Lit `users/{uid}/preferences/profile`, en tolérant son absence — la grande
 * majorité des comptes n'aura jamais ouvert les réglages.
 * @param {admin.firestore.Firestore} db Firestore.
 * @param {string} uid Utilisateur authentifié.
 * @return {Promise<DeclaredProfile>} Profil déclaré, vide par défaut.
 */
async function fetchDeclaredProfile(
    db: admin.firestore.Firestore,
    uid: string,
): Promise<DeclaredProfile> {
  const snap = await db.collection('users').doc(uid)
      .collection('preferences').doc('profile').get();
  if (!snap.exists) return EMPTY_DECLARED_PROFILE;

  const rawGenres = snap.get('bannedGenreIds');
  const bannedGenreIDs = new Set<number>();
  if (Array.isArray(rawGenres)) {
    for (const value of rawGenres) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        bannedGenreIDs.add(Math.floor(value));
      }
    }
  }

  const rawDecade = snap.get('birthDecade');
  const birthDecade = typeof rawDecade === 'number' && rawDecade >= 1930 &&
    rawDecade <= 2020 ? Math.floor(rawDecade / 10) * 10 : null;

  return {bannedGenreIDs, birthDecade};
}

/**
 * Pondère la probabilité d'avoir vu un film selon l'âge de l'utilisateur.
 *
 * Asymétrique à dessein : tout ce qui sort après votre naissance vous reste
 * accessible en salle, à la télé ou en streaming, alors qu'un film antérieur
 * demande une démarche. À 25 ans, on n'a pas la même probabilité d'avoir vu un
 * film de 1975 qu'à 55 ans.
 * @param {?number} decade Décennie du film.
 * @param {?number} birthDecade Décennie de naissance déclarée.
 * @return {number} Multiplicateur entre 0.45 et 1.
 */
function generationFactor(
    decade: number | null, birthDecade: number | null,
): number {
  if (decade === null || birthDecade === null) return 1;
  if (decade >= birthDecade) return 1;
  const decadesBefore = (birthDecade - decade) / 10;
  return Math.max(0.45, 1 - 0.14 * decadesBefore);
}

/**
 * Décennie d'un film à partir de sa date de sortie TMDB.
 * @param {?string} releaseDate Date `YYYY-MM-DD` ou null.
 * @return {?number} Décennie (1990, 2000, ...) ou null.
 */
function decadeOf(releaseDate: string | null | undefined): number | null {
  if (!releaseDate || releaseDate.length < 4) return null;
  const year = Number(releaseDate.slice(0, 4));
  if (!Number.isFinite(year) || year < 1900) return null;
  return Math.floor(year / 10) * 10;
}

/**
 * Ratio lissé (Laplace) entre signaux positifs et négatifs — vaut 0.5 tant
 * qu'on n'a pas de données, et bouge d'autant plus vite qu'elles s'accumulent.
 * @param {number} positive Compteur positif.
 * @param {number} negative Compteur négatif.
 * @return {number} Ratio entre 0 et 1.
 */
function smoothedRatio(positive: number, negative: number): number {
  return (positive + 2) / (positive + negative + 4);
}

/** Borne une valeur dans [0, 1]. */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Normalise une table de poids bruts sur son maximum, pour que le critère
 * dominant vaille 1 quelle que soit la taille de la galerie.
 * @param {Map<K, number>} raw Poids bruts accumulés.
 * @return {Map<K, number>} Poids normalisés entre 0 et 1.
 */
function normalizeWeights<K>(raw: Map<K, number>): Map<K, number> {
  let max = 0;
  for (const value of raw.values()) max = Math.max(max, value);
  if (max <= 0) return new Map<K, number>();
  const normalized = new Map<K, number>();
  for (const [key, value] of raw) normalized.set(key, value / max);
  return normalized;
}

/**
 * Lit les compteurs de swipe, en tolérant un document absent ou partiel.
 * @param {admin.firestore.DocumentSnapshot} snap Snapshot du document.
 * @return {SwipeCounters} Compteurs normalisés.
 */
function parseSwipeCounters(
    snap: admin.firestore.DocumentSnapshot,
): SwipeCounters {
  const data = (snap.exists ? snap.data() : {}) ?? {};
  const asRecord = (value: unknown): Record<string, number> => {
    if (!value || typeof value !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
    }
    return out;
  };
  return {
    genreSeen: asRecord(data.genreSeen),
    genreWanted: asRecord(data.genreWanted),
    genreSkipped: asRecord(data.genreSkipped),
    decadeSeen: asRecord(data.decadeSeen),
    decadeSkipped: asRecord(data.decadeSkipped),
  };
}

/**
 * Construit le profil de goût. Les entrées de galerie récentes pèsent jusqu'à
 * deux fois plus que les anciennes : le feed suit la période que l'utilisateur
 * est en train d'explorer plutôt que la moyenne de toute sa vie de spectateur.
 * @param {admin.firestore.QueryDocumentSnapshot[]} galleryDocs Docs galerie.
 * @param {SwipeCounters} counters Compteurs de swipe agrégés.
 * @return {TasteProfile} Profil prêt pour le scoring.
 */
function buildTasteProfile(
    galleryDocs: admin.firestore.QueryDocumentSnapshot[],
    counters: SwipeCounters,
    declared: DeclaredProfile,
): TasteProfile {
  const entries = galleryDocs
      .map((doc) => ({
        tmdbId: doc.get('tmdbId') as number | undefined,
        genreIds: (doc.get('genreIds') as number[] | undefined) ?? [],
        releaseDate: doc.get('releaseDate') as string | null | undefined,
        voteAverage: doc.get('voteAverage') as number | null | undefined,
        voteCount: doc.get('voteCount') as number | null | undefined,
        addedAt: doc.get('addedAt') as admin.firestore.Timestamp | undefined,
      }))
      .filter((entry) => typeof entry.tmdbId === 'number')
      .sort((a, b) =>
        (b.addedAt?.toMillis() ?? 0) - (a.addedAt?.toMillis() ?? 0));

  const rawGenres = new Map<number, number>();
  const rawDecades = new Map<number, number>();
  const ratings: number[] = [];
  const logVoteCounts: number[] = [];

  entries.forEach((entry, index) => {
    // Les 20 ajouts les plus récents pèsent de 2x (le dernier) à 1x.
    const weight = 1 + Math.max(0, (20 - index) / 20);
    for (const genreId of entry.genreIds) {
      rawGenres.set(genreId, (rawGenres.get(genreId) ?? 0) + weight);
    }
    const decade = decadeOf(entry.releaseDate);
    if (decade !== null) {
      rawDecades.set(decade, (rawDecades.get(decade) ?? 0) + weight);
    }
    if (typeof entry.voteAverage === 'number' && entry.voteAverage > 0) {
      ratings.push(entry.voteAverage);
    }
    if (typeof entry.voteCount === 'number' && entry.voteCount > 0) {
      logVoteCounts.push(Math.log10(entry.voteCount));
    }
  });

  // `voteCount` n'est écrit que par les entrées ajoutées au swipe : le niveau
  // de « niche » se construit tout seul et reste neutre tant qu'il manque des
  // échantillons, plutôt que d'être deviné sur trop peu de films.
  let medianLogVoteCount: number | null = null;
  if (logVoteCounts.length >= 5) {
    const sorted = [...logVoteCounts].sort((a, b) => a - b);
    medianLogVoteCount = sorted[Math.floor(sorted.length / 2)];
  }

  const genreLikeRatio = new Map<number, number>();
  const genreKeys = new Set([
    ...Object.keys(counters.genreSeen),
    ...Object.keys(counters.genreWanted),
    ...Object.keys(counters.genreSkipped),
  ]);
  for (const key of genreKeys) {
    const positive = (counters.genreSeen[key] ?? 0) +
      (counters.genreWanted[key] ?? 0);
    genreLikeRatio.set(
        Number(key), smoothedRatio(positive, counters.genreSkipped[key] ?? 0),
    );
  }

  const decadeSeenRatio = new Map<number, number>();
  const decadeKeys = new Set([
    ...Object.keys(counters.decadeSeen),
    ...Object.keys(counters.decadeSkipped),
  ]);
  for (const key of decadeKeys) {
    decadeSeenRatio.set(
        Number(key),
        smoothedRatio(
            counters.decadeSeen[key] ?? 0, counters.decadeSkipped[key] ?? 0,
        ),
    );
  }

  return {
    gallerySize: entries.length,
    genreWeights: normalizeWeights(rawGenres),
    decadeWeights: normalizeWeights(rawDecades),
    meanRating: ratings.length > 0 ?
      ratings.reduce((a, b) => a + b, 0) / ratings.length : 7,
    medianLogVoteCount,
    seedIds: pickSeedIds(entries.map((entry) => entry.tmdbId as number)),
    genreLikeRatio,
    decadeSeenRatio,
    declared,
  };
}

/**
 * Tire les graines de galerie : majoritairement parmi les ajouts récents, avec
 * quelques anciens pour que le feed ne se referme pas sur la dernière lubie.
 * @param {number[]} orderedIds ids galerie, du plus récent au plus ancien.
 * @return {number[]} ids mélangés servant de graines TMDB.
 */
function pickSeedIds(orderedIds: number[]): number[] {
  const recent = orderedIds.slice(0, SWIPE_SEED_POOL_RECENT);
  const older = shuffled(orderedIds.slice(SWIPE_SEED_POOL_RECENT))
      .slice(0, SWIPE_SEED_POOL_OLDER);
  return shuffled([...recent, ...older]);
}

/** Copie mélangée (Fisher-Yates). */
function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Les genres les plus présents dans la galerie, pour le discover profilé.
 * @param {TasteProfile} profile Profil de goût.
 * @param {number} count Nombre de genres voulus.
 * @return {number[]} ids de genres TMDB, du plus fort au plus faible.
 */
function topGenreIds(profile: TasteProfile, count: number): number[] {
  return Array.from(profile.genreWeights.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, count)
      .map(([genreId]) => genreId);
}

/**
 * Les décennies dominantes de la galerie, ou un éventail large à froid.
 * @param {TasteProfile} profile Profil de goût.
 * @return {number[]} Décennies à interroger.
 */
function targetDecades(profile: TasteProfile): number[] {
  const known = Array.from(profile.decadeWeights.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([decade]) => decade);
  if (known.length > 0) return known;
  return shuffled([1990, 2000, 2010, 2020]).slice(0, 2);
}

/**
 * Extrait les lignes exploitables d'une réponse de liste TMDB.
 * @param {PromiseSettledResult<Record<string, unknown>>} settled Réponse.
 * @param {string} key Clé du tableau (`results` ou `parts`).
 * @return {DiscoverRow[]} Lignes brutes.
 */
function rowsFrom(
    settled: PromiseSettledResult<Record<string, unknown>>,
    key: 'results' | 'parts',
): DiscoverRow[] {
  if (settled.status !== 'fulfilled') return [];
  const raw = settled.value[key];
  return Array.isArray(raw) ? raw as DiscoverRow[] : [];
}

/**
 * Source A — le voisinage de la galerie. `/recommendations` donne le « les
 * gens qui ont aimé ça ont aussi vu ça », `/similar` est plus littéral et
 * ramène beaucoup d'épisodes de la même saga : les deux se complètent.
 * @param {TasteProfile} profile Profil de goût.
 * @param {string} token Jeton TMDB.
 * @return {Promise<DiscoverRow[]>} Candidats du voisinage.
 */
async function fetchNeighborCandidates(
    profile: TasteProfile, token: string,
): Promise<DiscoverRow[]> {
  const seeds = profile.seedIds;
  if (seeds.length === 0) return [];

  const recommendationSeeds = seeds.slice(0, SWIPE_SEEDS_RECOMMENDATIONS);
  const similarSeeds = seeds.slice(
      SWIPE_SEEDS_RECOMMENDATIONS,
      SWIPE_SEEDS_RECOMMENDATIONS + SWIPE_SEEDS_SIMILAR,
  );

  const requests = [
    ...recommendationSeeds.map((id) =>
      tmdbGET(`/movie/${id}/recommendations`, {
        language: DEFAULT_LANGUAGE, page: '1',
      }, token)),
    ...similarSeeds.map((id) =>
      tmdbGET(`/movie/${id}/similar`, {
        language: DEFAULT_LANGUAGE, page: '1',
      }, token)),
  ];

  const settled = await Promise.allSettled(requests);
  return settled.flatMap((result) => rowsFrom(result, 'results'));
}

/**
 * Source B — discover cadré sur le profil : genres dominants, bande de
 * décennies habituelle, tri par `vote_count.desc`. Ce tri est volontaire :
 * `popularity.desc` est un score de buzz du jour, qui fait remonter des
 * nouveautés que personne n'a encore vues — l'inverse de ce qu'on cherche.
 * @param {TasteProfile} profile Profil de goût.
 * @param {number} voteCountFloor Plancher de notoriété.
 * @param {string} token Jeton TMDB.
 * @return {Promise<DiscoverRow[]>} Candidats profilés.
 */
async function fetchProfiledCandidates(
    profile: TasteProfile, voteCountFloor: number, token: string,
): Promise<DiscoverRow[]> {
  const genreIds = topGenreIds(profile, 3);
  if (genreIds.length === 0) return [];

  const decades = targetDecades(profile);
  const requests = decades.map((decade) => tmdbGET('/discover/movie', {
    language: DEFAULT_LANGUAGE,
    region: DEFAULT_REGION,
    include_adult: 'false',
    include_video: 'false',
    with_genres: genreIds.join('|'),
    'primary_release_date.gte': `${decade}-01-01`,
    'primary_release_date.lte': `${decade + 9}-12-31`,
    'vote_count.gte': String(voteCountFloor),
    sort_by: 'vote_count.desc',
    page: String(1 + Math.floor(Math.random() * 3)),
  }, token));

  const settled = await Promise.allSettled(requests);
  return settled.flatMap((result) => rowsFrom(result, 'results'));
}

/**
 * Source C — les piliers de notoriété d'une décennie, sans filtre de genre.
 * C'est ce qui fait tourner le feed à froid, et ce qui rattrape les
 * blockbusters que tout le monde a vus en dehors de son genre de prédilection.
 * @param {TasteProfile} profile Profil de goût.
 * @param {string} token Jeton TMDB.
 * @return {Promise<DiscoverRow[]>} Candidats grand public.
 */
async function fetchPillarCandidates(
    profile: TasteProfile, token: string,
): Promise<DiscoverRow[]> {
  const decades = profile.gallerySize >= SWIPE_PROFILE_MIN_SIZE ?
    targetDecades(profile) :
    shuffled([1990, 2000, 2010, 2020]);

  const requests = decades.map((decade) => tmdbGET('/discover/movie', {
    language: DEFAULT_LANGUAGE,
    region: DEFAULT_REGION,
    include_adult: 'false',
    include_video: 'false',
    'primary_release_date.gte': `${decade}-01-01`,
    'primary_release_date.lte': `${decade + 9}-12-31`,
    'vote_count.gte': String(SWIPE_COLD_VOTE_COUNT_FLOOR),
    sort_by: 'vote_count.desc',
    page: String(1 + Math.floor(Math.random() * 3)),
  }, token));

  const settled = await Promise.allSettled(requests);
  return settled.flatMap((result) => rowsFrom(result, 'results'));
}

/**
 * Sources D et E — franchises et têtes d'affiche récurrentes. Les deux
 * partagent les mêmes appels de détail (`append_to_response=credits`) : une
 * seule requête par graine sert à la fois à trouver la saga et le casting.
 * @param {TasteProfile} profile Profil de goût.
 * @param {string} token Jeton TMDB.
 * @return {Promise<{franchise: DiscoverRow[], people: DiscoverRow[]}>}
 *   Candidats des deux sources.
 */
async function fetchFranchiseAndPeopleCandidates(
    profile: TasteProfile, token: string,
): Promise<{franchise: DiscoverRow[]; people: DiscoverRow[]}> {
  const seeds = profile.seedIds.slice(0, SWIPE_SEEDS_DETAILS);
  if (seeds.length === 0) return {franchise: [], people: []};

  const detailSettled = await Promise.allSettled(
      seeds.map((id) => tmdbGET(`/movie/${id}`, {
        language: DEFAULT_LANGUAGE,
        append_to_response: 'credits',
      }, token)),
  );

  const collectionIds = new Set<number>();
  const personIds = new Set<number>();

  for (const settled of detailSettled) {
    if (settled.status !== 'fulfilled') continue;
    const detail = settled.value;

    const collection = detail.belongs_to_collection as
      {id?: number} | null | undefined;
    if (collection && typeof collection.id === 'number') {
      collectionIds.add(collection.id);
    }

    const credits = detail.credits as Record<string, unknown> | undefined;
    const cast = Array.isArray(credits?.cast) ?
      credits?.cast as {id?: number; order?: number}[] : [];
    for (const member of cast.slice(0, 2)) {
      if (typeof member.id === 'number') personIds.add(member.id);
    }
    const crew = Array.isArray(credits?.crew) ?
      credits?.crew as {id?: number; job?: string}[] : [];
    const director = crew.find((member) => member.job === 'Director');
    if (director && typeof director.id === 'number') {
      personIds.add(director.id);
    }
  }

  const [collectionSettled, peopleSettled] = await Promise.all([
    Promise.allSettled(
        Array.from(collectionIds).map((id) => tmdbGET(`/collection/${id}`, {
          language: DEFAULT_LANGUAGE,
        }, token)),
    ),
    Promise.allSettled(
        Array.from(personIds).slice(0, 2).map((id) =>
          tmdbGET('/discover/movie', {
            language: DEFAULT_LANGUAGE,
            include_adult: 'false',
            include_video: 'false',
            with_cast: String(id),
            'vote_count.gte': String(SWIPE_VOTE_COUNT_FLOOR),
            sort_by: 'vote_count.desc',
            page: '1',
          }, token)),
    ),
  ]);

  return {
    franchise: collectionSettled.flatMap((result) => rowsFrom(result, 'parts')),
    people: peopleSettled.flatMap((result) => rowsFrom(result, 'results')),
  };
}

/**
 * Assemble le vivier complet en marquant la provenance de chaque film. Un film
 * ramené par plusieurs sources garde la première rencontrée, dans l'ordre de
 * fiabilité décroissante du signal « il l'a probablement vu ».
 * @param {TasteProfile} profile Profil de goût.
 * @param {string} token Jeton TMDB.
 * @return {Promise<Map<number, SwipeCandidate>>} Vivier dédoublonné.
 */
async function fetchSwipePool(
    profile: TasteProfile, token: string,
): Promise<Map<number, SwipeCandidate>> {
  const voteCountFloor = profile.gallerySize >= SWIPE_PROFILE_MATURE_SIZE ?
    SWIPE_VOTE_COUNT_FLOOR : SWIPE_COLD_VOTE_COUNT_FLOOR;

  const [neighbors, profiled, pillars, franchiseAndPeople] = await Promise.all([
    fetchNeighborCandidates(profile, token),
    fetchProfiledCandidates(profile, voteCountFloor, token),
    fetchPillarCandidates(profile, token),
    fetchFranchiseAndPeopleCandidates(profile, token),
  ]);

  const groups: [SwipeSource, DiscoverRow[]][] = [
    ['franchise', franchiseAndPeople.franchise],
    ['neighbors', neighbors],
    ['people', franchiseAndPeople.people],
    ['profile', profiled],
    ['pillars', pillars],
  ];

  const banned = profile.declared.bannedGenreIDs;
  const pool = new Map<number, SwipeCandidate>();
  for (const [source, rows] of groups) {
    for (const row of rows) {
      if (typeof row.id !== 'number' || pool.has(row.id)) continue;
      if (!row.poster_path) continue;
      // « Jamais de… » est un filtre dur : contrairement aux rejets appris au
      // swipe, ce n'est pas une préférence à sous-pondérer mais une règle.
      if ((row.genre_ids ?? []).some((id) => banned.has(id))) continue;
      pool.set(row.id, {...row, source, score: 0});
    }
  }
  return pool;
}

/**
 * Probabilité que l'utilisateur ait vu le film, entre 0 et 1.
 *
 * Le poids principal est le `vote_count` : c'est le meilleur proxy disponible
 * de « combien de gens ont réellement vu ce film », très au-dessus de
 * `popularity`. L'échelle est logarithmique — 200 votes et 2 000 votes sont
 * deux inconnus, 20 000 et 60 000 sont deux évidences.
 * @param {SwipeCandidate} row Candidat.
 * @param {TasteProfile} profile Profil de goût.
 * @return {number} Score entre 0 et 1.
 */
function seenLikelihood(row: SwipeCandidate, profile: TasteProfile): number {
  const voteCount = Math.max(1, row.vote_count ?? 0);
  const notoriety = clamp01((Math.log10(voteCount) - 2.3) / (4.8 - 2.3));

  const decade = decadeOf(row.release_date);
  const decadeWeight = decade === null ? 0.4 :
    profile.gallerySize >= SWIPE_PROFILE_MIN_SIZE ?
      profile.decadeWeights.get(decade) ?? 0.15 : 0.4;
  const decadeRatio = decade === null ? 0.5 :
    profile.decadeSeenRatio.get(decade) ?? 0.5;
  const decadeAffinity = 0.5 * decadeWeight + 0.5 * decadeRatio;

  // La génération déclarée calibre dès le premier lot ce que les compteurs de
  // swipe mettraient des dizaines de cartes à découvrir.
  const generation = generationFactor(decade, profile.declared.birthDecade);

  return clamp01((0.65 * notoriety + 0.35 * decadeAffinity) * generation);
}

/**
 * Correspondance avec le style de l'utilisateur, entre 0 et 1.
 * @param {SwipeCandidate} row Candidat.
 * @param {TasteProfile} profile Profil de goût.
 * @return {number} Score entre 0 et 1.
 */
function tasteMatch(row: SwipeCandidate, profile: TasteProfile): number {
  const genreIds = row.genre_ids ?? [];
  let genreAffinity = 0.4;
  if (genreIds.length > 0) {
    const scores = genreIds.map((genreId) => {
      const weight = profile.gallerySize >= SWIPE_PROFILE_MIN_SIZE ?
        profile.genreWeights.get(genreId) ?? 0.1 : 0.4;
      const ratio = profile.genreLikeRatio.get(genreId) ?? 0.5;
      return 0.6 * weight + 0.4 * ratio;
    });
    // Le meilleur genre compte plus que la moyenne : un film d'action teinté
    // de romance reste un film d'action pour qui aime l'action.
    genreAffinity = 0.6 * Math.max(...scores) +
      0.4 * (scores.reduce((a, b) => a + b, 0) / scores.length);
  }

  const rating = row.vote_average ?? profile.meanRating;
  const ratingProximity = bandScore(
      rating, profile.meanRating - 0.5, profile.meanRating + 0.5, 2.5,
  );

  let nicheProximity = 0.6;
  if (profile.medianLogVoteCount !== null) {
    const logVoteCount = Math.log10(Math.max(1, row.vote_count ?? 1));
    nicheProximity = bandScore(
        logVoteCount,
        profile.medianLogVoteCount - 0.4,
        profile.medianLogVoteCount + 0.4,
        1.2,
    );
  }

  return clamp01(
      0.55 * genreAffinity + 0.25 * ratingProximity + 0.20 * nicheProximity,
  );
}

/** Bonus de score par source, reflétant la force du signal « déjà vu ». */
const SWIPE_SOURCE_BONUS: Record<SwipeSource, number> = {
  franchise: 6,
  neighbors: 4,
  people: 3,
  pillars: 2,
  profile: 0,
  exploration: 0,
};

/**
 * Score final d'un candidat, sur une échelle 0..100 plus bonus de source et
 * une pincée d'aléatoire pour que deux lots consécutifs ne soient jamais
 * strictement identiques.
 * @param {SwipeCandidate} row Candidat.
 * @param {TasteProfile} profile Profil de goût.
 * @return {number} Score final.
 */
function swipeScore(row: SwipeCandidate, profile: TasteProfile): number {
  const base = 100 * (
    0.55 * seenLikelihood(row, profile) + 0.45 * tasteMatch(row, profile)
  );
  return base + SWIPE_SOURCE_BONUS[row.source] + Math.random() * 4;
}

/**
 * Quotas de mix par source, adaptés à la maturité du profil. À froid la
 * galerie ne dit rien : on s'appuie presque uniquement sur la notoriété brute,
 * la seule chose qui rende un film probablement vu par n'importe qui.
 * @param {TasteProfile} profile Profil de goût.
 * @return {[SwipeSource, number][]} Quotas, source par source.
 */
function sourceQuotas(profile: TasteProfile): [SwipeSource, number][] {
  const size = SWIPE_FEED_SIZE;
  const share = (fraction: number) => Math.round(size * fraction);

  if (profile.gallerySize < SWIPE_PROFILE_MIN_SIZE) {
    return [
      ['pillars', share(0.7)],
      ['profile', share(0.2)],
      ['neighbors', share(0.1)],
      ['franchise', 0],
      ['people', 0],
    ];
  }
  if (profile.gallerySize < SWIPE_PROFILE_MATURE_SIZE) {
    return [
      ['neighbors', share(0.3)],
      ['pillars', share(0.3)],
      ['profile', share(0.25)],
      ['franchise', share(0.1)],
      ['people', share(0.05)],
    ];
  }
  return [
    ['neighbors', share(0.35)],
    ['profile', share(0.25)],
    ['pillars', share(0.15)],
    ['franchise', share(0.1)],
    ['people', share(0.1)],
  ];
}

/**
 * Compose le lot final : quotas par source, complément par score global, puis
 * une part d'exploration tirée au hasard dans le reste du vivier pour que le
 * feed ne se referme pas sur ce que l'algo croit déjà savoir.
 * @param {SwipeCandidate[]} scored Vivier scoré, trié par score décroissant.
 * @param {TasteProfile} profile Profil de goût.
 * @return {SwipeCandidate[]} Cartes sélectionnées.
 */
function selectSwipeDeck(
    scored: SwipeCandidate[], profile: TasteProfile,
): SwipeCandidate[] {
  const picked: SwipeCandidate[] = [];
  const used = new Set<number>();

  const explorationSlots = profile.gallerySize < SWIPE_PROFILE_MIN_SIZE ?
    0 : Math.max(1, Math.round(SWIPE_FEED_SIZE * 0.05));

  for (const [source, quota] of sourceQuotas(profile)) {
    if (quota <= 0) continue;
    for (const candidate of scored) {
      if (picked.length >= SWIPE_FEED_SIZE - explorationSlots) break;
      if (candidate.source !== source || used.has(candidate.id)) continue;
      picked.push(candidate);
      used.add(candidate.id);
      if (picked.filter((c) => c.source === source).length >= quota) break;
    }
  }

  // Une source peut être à sec (galerie sans franchise, TMDB qui renvoie peu) :
  // on complète au score global plutôt que de rendre un lot incomplet.
  for (const candidate of scored) {
    if (picked.length >= SWIPE_FEED_SIZE - explorationSlots) break;
    if (used.has(candidate.id)) continue;
    picked.push(candidate);
    used.add(candidate.id);
  }

  const leftovers = shuffled(scored.filter((c) => !used.has(c.id)));
  for (const candidate of leftovers.slice(0, explorationSlots)) {
    picked.push({...candidate, source: 'exploration'});
    used.add(candidate.id);
  }

  return orderForDeck(picked);
}

/**
 * Ordonne les cartes pour l'affichage en pénalisant la ressemblance avec les
 * dernières servies — sans ça, les quotas produisent des séries de huit films
 * du même genre d'affilée, et le deck devient monotone à swiper.
 * @param {SwipeCandidate[]} cards Cartes sélectionnées.
 * @return {SwipeCandidate[]} Cartes réordonnées.
 */
function orderForDeck(cards: SwipeCandidate[]): SwipeCandidate[] {
  const remaining = [...cards].sort((a, b) => b.score - a.score);
  const ordered: SwipeCandidate[] = [];

  while (remaining.length > 0) {
    const window = ordered.slice(-SWIPE_DIVERSITY_WINDOW);
    let bestIndex = 0;
    let bestScore = -Infinity;

    remaining.forEach((candidate, index) => {
      const penalty = window.reduce((sum, previous) => {
        const shared = (candidate.genre_ids ?? [])
            .filter((g) => (previous.genre_ids ?? []).includes(g)).length;
        const sameDecade = decadeOf(candidate.release_date) !== null &&
          decadeOf(candidate.release_date) === decadeOf(previous.release_date);
        const sameSource = candidate.source === previous.source;
        return sum + (shared >= 2 ? 10 : shared === 1 ? 4 : 0) +
          (sameDecade ? 4 : 0) + (sameSource ? 3 : 0);
      }, 0);
      const adjusted = candidate.score - penalty;
      if (adjusted > bestScore) {
        bestScore = adjusted;
        bestIndex = index;
      }
    });

    ordered.push(remaining[bestIndex]);
    remaining.splice(bestIndex, 1);
  }

  return ordered;
}

/**
 * Charge les ids à exclure : galerie, watchlist, et films écartés dont le
 * cooldown court encore. `resurfaceAt` étant calculé à l'écriture, l'exclusion
 * tient en une seule requête indexée.
 * @param {admin.firestore.Firestore} db Firestore.
 * @param {string} uid Utilisateur authentifié.
 * @return {Promise<{excluded: Set<number>,
 *   galleryDocs: admin.firestore.QueryDocumentSnapshot[]}>} Exclusions et
 *   documents de galerie (réutilisés pour bâtir le profil).
 */
async function fetchSwipeExclusions(
    db: admin.firestore.Firestore,
    uid: string,
): Promise<{
  excluded: Set<number>;
  galleryDocs: admin.firestore.QueryDocumentSnapshot[];
}> {
  const userRef = db.collection('users').doc(uid);
  const now = admin.firestore.Timestamp.now();

  const [gallerySnap, watchlistSnap, skipsSnap] = await Promise.all([
    userRef.collection('gallery').get(),
    userRef.collection('watchlist').get(),
    userRef.collection('swipeSkips')
        .where('resurfaceAt', '>', now)
        .limit(SWIPE_MAX_ACTIVE_SKIPS)
        .get(),
  ]);

  const excluded = new Set<number>();
  for (const snap of [gallerySnap, watchlistSnap, skipsSnap]) {
    for (const doc of snap.docs) {
      const id = doc.get('tmdbId');
      if (typeof id === 'number') excluded.add(id);
    }
  }

  return {excluded, galleryDocs: gallerySnap.docs};
}

/** Ids déjà servis dans la session courante, envoyés par le client. */
function parseExcludeIds(value: unknown): Set<number> {
  const ids = new Set<number>();
  if (!Array.isArray(value)) return ids;
  for (const raw of value) {
    const id = Number(raw);
    if (Number.isFinite(id) && id > 0) ids.add(Math.floor(id));
  }
  return ids;
}

/**
 * Renvoie un lot de cartes à swiper, personnalisé et déjà purgé de tout ce que
 * l'utilisateur a classé ou écarté récemment.
 */
export const getSwipeFeed = onRequest(
    {secrets: [tmdbApiKey], invoker: 'public', timeoutSeconds: 60},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'POST') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const a = getAdmin();
        const db = a.firestore();
        const sessionExcluded = parseExcludeIds(
            (req.body as Record<string, unknown> | undefined)?.excludeIds,
        );

        const [exclusions, countersSnap, declared] = await Promise.all([
          fetchSwipeExclusions(db, uid),
          db.collection('users').doc(uid)
              .collection('preferences').doc('swipeProfile').get(),
          fetchDeclaredProfile(db, uid),
        ]);

        const profile = buildTasteProfile(
            exclusions.galleryDocs, parseSwipeCounters(countersSnap), declared,
        );

        const pool = await fetchSwipePool(profile, tmdbApiKey.value());
        const scored = Array.from(pool.values())
            .filter((candidate) =>
              !exclusions.excluded.has(candidate.id) &&
              !sessionExcluded.has(candidate.id))
            .map((candidate) => ({
              ...candidate, score: swipeScore(candidate, profile),
            }))
            .sort((a, b) => b.score - a.score);

        const deck = selectSwipeDeck(scored, profile);

        if (deck.length === 0) {
          logger.info('getSwipeFeed: empty deck', {
            uid,
            poolSize: pool.size,
            gallerySize: profile.gallerySize,
            sessionExcluded: sessionExcluded.size,
          });
        }

        res.status(200).json({
          cards: deck.map((candidate) => ({
            ...discoverRowToJSON(candidate),
            source: candidate.source,
          })),
          gallery_size: profile.gallerySize,
          exhausted: deck.length === 0,
        });
      } catch (error) {
        if (sendTMDBError(error, res)) return;
        logger.error('getSwipeFeed failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

/** Une décision de swipe telle qu'envoyée par le client. */
interface SwipeDecisionPayload {
  decision: 'seen' | 'skipped' | 'watchlist';
  item: MediaItemPayload & {voteCount?: number | null};
}

/**
 * Valide et normalise le lot de décisions envoyé par le client, en ignorant
 * silencieusement les entrées malformées plutôt que de rejeter tout le lot —
 * une décision perdue vaut mieux qu'un lot entier rejeté côté deck.
 * @param {unknown} value Corps brut de la requête.
 * @return {SwipeDecisionPayload[]} Décisions exploitables.
 */
function parseSwipeDecisions(value: unknown): SwipeDecisionPayload[] {
  if (!Array.isArray(value)) return [];
  const decisions: SwipeDecisionPayload[] = [];
  for (const raw of value.slice(0, SWIPE_MAX_DECISIONS)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const decision = entry.decision;
    if (decision !== 'seen' && decision !== 'skipped' &&
      decision !== 'watchlist') continue;
    const item = entry.item as SwipeDecisionPayload['item'] | undefined;
    if (!item?.id || !item?.tmdbId || !item?.mediaType || !item?.title) continue;
    decisions.push({decision, item});
  }
  return decisions;
}

/**
 * Cooldown avant qu'un film écarté puisse revenir : 14 jours, doublés à chaque
 * nouveau skip, plafonnés à 180. Un film écarté une fois revient dans deux
 * semaines ; au quatrième ou cinquième skip il sort de fait du feed.
 * @param {number} skipCount Nombre total de skips après celui-ci.
 * @return {number} Cooldown en millisecondes.
 */
function skipCooldownMillis(skipCount: number): number {
  const days = Math.min(
      SWIPE_SKIP_MAX_COOLDOWN_DAYS,
      SWIPE_SKIP_BASE_COOLDOWN_DAYS * Math.pow(2, Math.max(0, skipCount - 1)),
  );
  return days * 24 * 3600 * 1000;
}

/**
 * Enregistre un lot de décisions de swipe. Le client swipe plus vite qu'un
 * aller-retour réseau : il accumule localement et flushe par paquets, l'UI
 * n'attend jamais cette écriture.
 */
export const recordSwipes = onRequest(
    {invoker: 'public', timeoutSeconds: 30},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'POST') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const decisions = parseSwipeDecisions(
            (req.body as Record<string, unknown> | undefined)?.decisions,
        );
        if (decisions.length === 0) {
          res.status(200).json({ok: true, recorded: 0});
          return;
        }

        const a = getAdmin();
        const db = a.firestore();
        const userRef = db.collection('users').doc(uid);
        const now = a.firestore.Timestamp.now();

        // Le cooldown dépend du nombre de skips déjà encaissés : une lecture
        // groupée en amont évite une transaction par film.
        const skippedIds = decisions
            .filter((d) => d.decision === 'skipped')
            .map((d) => d.item.id);
        const previousSkipCounts = new Map<string, number>();
        if (skippedIds.length > 0) {
          const refs = Array.from(new Set(skippedIds))
              .map((id) => userRef.collection('swipeSkips').doc(id));
          const snaps = await db.getAll(...refs);
          for (const snap of snaps) {
            const count = snap.get('skipCount');
            previousSkipCounts.set(
                snap.id, typeof count === 'number' ? count : 0,
            );
          }
        }

        const counters = {
          genreSeen: {} as Record<string, admin.firestore.FieldValue>,
          genreWanted: {} as Record<string, admin.firestore.FieldValue>,
          genreSkipped: {} as Record<string, admin.firestore.FieldValue>,
          decadeSeen: {} as Record<string, admin.firestore.FieldValue>,
          decadeSkipped: {} as Record<string, admin.firestore.FieldValue>,
        };
        const increments = new Map<string, Map<string, number>>();
        const bump = (bucket: keyof typeof counters, key: string) => {
          const inner = increments.get(bucket) ?? new Map<string, number>();
          inner.set(key, (inner.get(key) ?? 0) + 1);
          increments.set(bucket, inner);
        };

        const batch = db.batch();

        for (const {decision, item} of decisions) {
          const galleryRef = userRef.collection('gallery').doc(item.id);
          const watchlistRef = userRef.collection('watchlist').doc(item.id);
          const skipRef = userRef.collection('swipeSkips').doc(item.id);
          const decade = decadeOf(item.releaseDate);
          const genreIds = item.genreIds ?? [];

          if (decision === 'skipped') {
            const skipCount = (previousSkipCounts.get(item.id) ?? 0) + 1;
            batch.set(skipRef, {
              tmdbId: item.tmdbId,
              skipCount,
              lastSkippedAt: now,
              resurfaceAt: a.firestore.Timestamp.fromMillis(
                  now.toMillis() + skipCooldownMillis(skipCount),
              ),
            }, {merge: true});
            for (const genreId of genreIds) {
              bump('genreSkipped', String(genreId));
            }
            if (decade !== null) bump('decadeSkipped', String(decade));
            continue;
          }

          const data = {
            id: item.id,
            tmdbId: item.tmdbId,
            mediaType: item.mediaType,
            title: item.title,
            posterPath: item.posterPath ?? null,
            overview: item.overview ?? null,
            voteAverage: item.voteAverage ?? null,
            // Absent des entrées ajoutées ailleurs dans l'app : c'est ce qui
            // permet au profil d'apprendre le niveau de « niche » de
            // l'utilisateur, sans jamais bloquer sur son absence.
            voteCount: item.voteCount ?? null,
            genreIds,
            releaseDate: item.releaseDate ?? null,
            addedAt: now,
          };

          // Un film ne peut pas être à la fois vu et à voir : le classement
          // le plus récent remplace le précédent, comme dans setMediaStatus.
          batch.delete(skipRef);
          if (decision === 'seen') {
            batch.delete(watchlistRef);
            batch.set(galleryRef, data);
            for (const genreId of genreIds) bump('genreSeen', String(genreId));
            if (decade !== null) bump('decadeSeen', String(decade));
          } else {
            batch.delete(galleryRef);
            batch.set(watchlistRef, data);
            for (const genreId of genreIds) {
              bump('genreWanted', String(genreId));
            }
          }
        }

        for (const [bucket, inner] of increments) {
          for (const [key, amount] of inner) {
            counters[bucket as keyof typeof counters][key] =
              a.firestore.FieldValue.increment(amount);
          }
        }

        batch.set(
            userRef.collection('preferences').doc('swipeProfile'),
            {
              ...counters,
              // Total exact des cartes tranchées : les compteurs par genre
              // sur-comptent (un film porte plusieurs genres) et ceux par
              // décennie ratent les mises en watchlist.
              totalDecisions: a.firestore.FieldValue.increment(decisions.length),
              updatedAt: now,
            },
            {merge: true},
        );

        await batch.commit();
        res.status(200).json({ok: true, recorded: decisions.length});
      } catch (error) {
        logger.error('recordSwipes failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

// ===========================================================================
// Compte — resetSwipeSkips / deleteAccount
// ===========================================================================

/** Documents supprimés par lot, sous la limite de 500 d'un batch Firestore. */
const DELETE_BATCH_SIZE = 400;

/**
 * Supprime tous les documents d'une collection, par lots.
 * @param {admin.firestore.Firestore} db Firestore.
 * @param {admin.firestore.CollectionReference} ref Collection à vider.
 * @return {Promise<number>} Nombre de documents supprimés.
 */
async function deleteCollection(
    db: admin.firestore.Firestore,
    ref: admin.firestore.CollectionReference,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const snap = await ref.limit(DELETE_BATCH_SIZE).get();
    if (snap.empty) return deleted;

    const batch = db.batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
    deleted += snap.size;

    if (snap.size < DELETE_BATCH_SIZE) return deleted;
  }
}

/**
 * Remet en jeu tous les films écartés au swipe.
 *
 * Le cooldown peut enterrer un film jusqu'à 180 jours et rien, côté client, ne
 * permettait de revenir dessus — un aller sans retour qu'on ne peut pas
 * laisser sans issue.
 */
export const resetSwipeSkips = onRequest(
    {invoker: 'public', timeoutSeconds: 60},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'POST') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const a = getAdmin();
        const db = a.firestore();
        const deleted = await deleteCollection(
            db, db.collection('users').doc(uid).collection('swipeSkips'),
        );

        res.status(200).json({ok: true, deleted});
      } catch (error) {
        logger.error('resetSwipeSkips failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

/**
 * Referme le lien de suivi des deux côtés avant la suppression d'un compte.
 *
 * `recursiveDelete` n'efface que l'arbre du compte supprimé : les entrées
 * `following`/`followers` que d'autres comptes pointent vers lui — et leurs
 * compteurs — resteraient sinon orphelines. Traité par lots de 200 entrées
 * (deux écritures chacune) pour rester loin de la limite de 500 opérations
 * d'un batch, même pour un compte à des milliers d'abonnés.
 * @param {admin.firestore.Firestore} db Firestore.
 * @param {string} uid Compte sur le point d'être supprimé.
 * @return {Promise<void>}
 */
async function detachFromFollowGraph(
    db: admin.firestore.Firestore, uid: string,
): Promise<void> {
  const a = getAdmin();
  const userRef = db.collection('users').doc(uid);

  const [followersSnap, followingSnap] = await Promise.all([
    userRef.collection('followers').get(),
    userRef.collection('following').get(),
  ]);

  const writes: Array<(batch: admin.firestore.WriteBatch) => void> = [];

  for (const doc of followersSnap.docs) {
    // doc.id est quelqu'un qui suit le compte supprimé : chez lui,
    // following/{uid} doit disparaître, et son compteur diminuer.
    const followerUid = doc.id;
    const linkRef = db.collection('users').doc(followerUid)
        .collection('following').doc(uid);
    const profileRef = db.collection('publicProfiles').doc(followerUid);
    writes.push((batch) => {
      batch.delete(linkRef);
      batch.update(profileRef, {
        followingCount: a.firestore.FieldValue.increment(-1),
      });
    });
  }

  for (const doc of followingSnap.docs) {
    // doc.id est quelqu'un que le compte supprimé suivait : chez lui,
    // followers/{uid} doit disparaître, et son compteur diminuer.
    const targetUid = doc.id;
    const linkRef = db.collection('users').doc(targetUid)
        .collection('followers').doc(uid);
    const profileRef = db.collection('publicProfiles').doc(targetUid);
    writes.push((batch) => {
      batch.delete(linkRef);
      batch.update(profileRef, {
        followerCount: a.firestore.FieldValue.increment(-1),
      });
    });
  }

  const CHUNK = 200;
  for (let i = 0; i < writes.length; i += CHUNK) {
    const batch = db.batch();
    for (const write of writes.slice(i, i + CHUNK)) write(batch);
    await batch.commit();
  }
}

/**
 * Libère le pseudo et efface le profil public d'un compte.
 * @param {admin.firestore.Firestore} db Firestore.
 * @param {string} uid Compte sur le point d'être supprimé.
 * @return {Promise<void>}
 */
async function deletePublicIdentity(
    db: admin.firestore.Firestore, uid: string,
): Promise<void> {
  const profileRef = db.collection('publicProfiles').doc(uid);
  const profileSnap = await profileRef.get();
  if (!profileSnap.exists) return;

  const batch = db.batch();
  const handleNormalized = profileSnap.get('handleNormalized') as
    string | undefined;
  if (handleNormalized) {
    batch.delete(db.collection('usernames').doc(handleNormalized));
  }
  batch.delete(profileRef);
  await batch.commit();
}

/**
 * Efface le compte et tout ce qui s'y rattache.
 *
 * Obligation App Store pour toute app permettant de créer un compte. L'ordre
 * compte : le graphe social d'abord (il a besoin des sous-collections que
 * `recursiveDelete` s'apprête à effacer), puis l'identité publique, puis les
 * données propres au compte, le compte Auth en dernier — l'inverse
 * laisserait des documents orphelins qu'aucun jeton ne permettrait plus
 * d'atteindre.
 */
export const deleteAccount = onRequest(
    {invoker: 'public', timeoutSeconds: 120},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'POST') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const a = getAdmin();
        const db = a.firestore();
        const userRef = db.collection('users').doc(uid);

        await detachFromFollowGraph(db, uid);
        await deletePublicIdentity(db, uid);

        // `recursiveDelete` descend dans toutes les sous-collections, y compris
        // celles ajoutées plus tard : rien à maintenir ici quand le schéma
        // évolue.
        await db.recursiveDelete(userRef);
        await a.auth().deleteUser(uid);

        res.status(200).json({ok: true});
      } catch (error) {
        logger.error('deleteAccount failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

// ===========================================================================
// Accueil — getHomeRows
//
// Les trois rangées personnalisées de l'accueil en un seul appel authentifié :
// le serveur a déjà la galerie et le profil déclaré en main, les découper en
// trois requêtes ferait payer trois fois la même lecture Firestore.
// ===========================================================================

/** Fenêtre considérée comme « encore à l'affiche », en jours. */
const THEATERS_WINDOW_DAYS = 56;
/** Films renvoyés par rangée. */
const HOME_ROW_SIZE = 20;

/** Date au format `YYYY-MM-DD` attendu par TMDB. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Les films sortis en salle en France sur la fenêtre récente.
 *
 * `/discover` plutôt que `/movie/now_playing` : la fenêtre, le tri et le
 * filtrage restent sous contrôle, ce qui permet ensuite de classer selon les
 * goûts — impossible avec `now_playing`, qui renvoie une liste figée.
 * @param {string} token Jeton TMDB.
 * @return {Promise<DiscoverRow[]>} Films à l'affiche.
 */
async function fetchInTheaters(token: string): Promise<DiscoverRow[]> {
  const now = new Date();
  const from = new Date(now.getTime() - THEATERS_WINDOW_DAYS * 24 * 3600 * 1000);

  const requests = [1, 2].map((page) => tmdbGET('/discover/movie', {
    language: DEFAULT_LANGUAGE,
    region: DEFAULT_REGION,
    include_adult: 'false',
    include_video: 'false',
    // 3 = sortie en salle, 2 = première limitée.
    with_release_type: '3|2',
    'primary_release_date.gte': isoDate(from),
    'primary_release_date.lte': isoDate(now),
    sort_by: 'popularity.desc',
    page: String(page),
  }, token));

  const settled = await Promise.allSettled(requests);
  return settled.flatMap((result) => rowsFrom(result, 'results'));
}

/** Nombre de tendances garanties après filtrage — jamais moins. */
const TRENDING_MIN_SIZE = 10;
/** Pages initiales, récupérées en parallèle. */
const TRENDING_INITIAL_PAGES = 3;
/** Plafond de pages en cas de repli : borne le pire cas en latence. */
const TRENDING_MAX_PAGES = 6;

/**
 * Un lot de pages de `/trending/movie/week`, récupérées en parallèle.
 * @param {number[]} pages Pages à récupérer.
 * @param {string} token Jeton TMDB.
 * @return {Promise<DiscoverRow[]>} Lignes brutes, non filtrées.
 */
async function fetchTrendingPages(pages: number[], token: string): Promise<DiscoverRow[]> {
  const settled = await Promise.allSettled(pages.map((page) => tmdbGET(
      '/trending/movie/week', {language: DEFAULT_LANGUAGE, page: String(page)}, token,
  )));
  return settled.flatMap((result) => rowsFrom(result, 'results'));
}

/**
 * Complète une liste de tendances jusqu'au plancher garanti, si besoin.
 *
 * Les plus gros cartons du box-office trustent souvent le haut du classement
 * brut — exactement ceux qu'exclut `theatricalExclusion`. Le chargement
 * initial (3 pages) suffit presque toujours après ce filtrage ; cette boucle
 * ne paie le coût d'un aller-retour de plus que dans le cas contraire, plutôt
 * que d'espérer que 3 pages suffisent toujours.
 * @param {DiscoverRow[]} initial Lignes déjà récupérées.
 * @param {DeclaredProfile} declared Profil déclaré, pour le même filtrage
 *   que la réponse finale.
 * @param {Set<number>} theatricalExclusion Films encore à l'affiche.
 * @param {string} token Jeton TMDB.
 * @return {Promise<DiscoverRow[]>} Lignes brutes, assez nombreuses pour
 *   couvrir `TRENDING_MIN_SIZE` une fois nettoyées par l'appelant.
 */
async function backfillTrending(
    initial: DiscoverRow[],
    declared: DeclaredProfile,
    theatricalExclusion: Set<number>,
    token: string,
): Promise<DiscoverRow[]> {
  let rows = initial;
  let nextPage = TRENDING_INITIAL_PAGES + 1;
  while (
    cleanHomeRow(rows, declared, theatricalExclusion).length < TRENDING_MIN_SIZE &&
    nextPage <= TRENDING_MAX_PAGES
  ) {
    rows = rows.concat(await fetchTrendingPages([nextPage], token));
    nextPage++;
  }
  return rows;
}

/**
 * Assainit une rangée : affiche obligatoire, genres bannis écartés, doublons
 * et identifiants exclus retirés, taille plafonnée.
 * @param {DiscoverRow[]} rows Lignes brutes.
 * @param {DeclaredProfile} declared Profil déclaré.
 * @param {Set<number>} excluded Identifiants à retirer.
 * @return {DiscoverRow[]} Rangée propre.
 */
function cleanHomeRow(
    rows: DiscoverRow[],
    declared: DeclaredProfile,
    excluded: Set<number>,
): DiscoverRow[] {
  const seen = new Set<number>();
  const out: DiscoverRow[] = [];
  for (const row of rows) {
    if (typeof row.id !== 'number' || seen.has(row.id)) continue;
    if (!row.poster_path) continue;
    if (excluded.has(row.id)) continue;
    if ((row.genre_ids ?? []).some((id) => declared.bannedGenreIDs.has(id))) continue;
    seen.add(row.id);
    out.push(row);
    if (out.length >= HOME_ROW_SIZE) break;
  }
  return out;
}

/**
 * Renvoie les rangées personnalisées de l'accueil : à l'affiche, semée par la
 * galerie, et tendances.
 */
export const getHomeRows = onRequest(
    {secrets: [tmdbApiKey], invoker: 'public', timeoutSeconds: 60},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'POST') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const a = getAdmin();
        const db = a.firestore();
        const userRef = db.collection('users').doc(uid);

        const [gallerySnap, countersSnap, declared] = await Promise.all([
          userRef.collection('gallery').get(),
          userRef.collection('preferences').doc('swipeProfile').get(),
          fetchDeclaredProfile(db, uid),
        ]);

        const profile = buildTasteProfile(
            gallerySnap.docs, parseSwipeCounters(countersSnap), declared,
        );

        const titleById = new Map<number, string>();
        for (const doc of gallerySnap.docs) {
          const id = doc.get('tmdbId');
          const title = doc.get('title');
          if (typeof id === 'number' && typeof title === 'string') {
            titleById.set(id, title);
          }
        }

        const seedId = profile.seedIds[0] ?? null;
        const [theaters, trendingInitial, seededRaw] = await Promise.all([
          fetchInTheaters(tmdbApiKey.value()),
          fetchTrendingPages(
              Array.from({length: TRENDING_INITIAL_PAGES}, (_, i) => i + 1),
              tmdbApiKey.value(),
          ),
          seedId === null ? Promise.resolve([]) :
            tmdbGET(`/movie/${seedId}/recommendations`, {
              language: DEFAULT_LANGUAGE, page: '1',
            }, tmdbApiKey.value())
                .then((data) => Array.isArray(data.results) ?
                  data.results as DiscoverRow[] : [])
                .catch(() => [] as DiscoverRow[]),
        ]);

        // Le classement par correspondance est ce qui distingue « au cinéma »
        // de « pour vous au cinéma ». La popularité ne sert qu'à départager :
        // en tête de tri elle ramènerait les mêmes blockbusters en permanence.
        const rankedTheaters = [...theaters].sort((left, right) => {
          const leftScore = tasteMatch({...left, source: 'profile', score: 0}, profile);
          const rightScore = tasteMatch({...right, source: 'profile', score: 0}, profile);
          if (Math.abs(leftScore - rightScore) > 0.02) return rightScore - leftScore;
          return (right.popularity ?? 0) - (left.popularity ?? 0);
        });

        const noExclusion = new Set<number>();
        const seededExclusion = seedId === null ?
          noExclusion : new Set<number>([seedId]);
        // Un film encore en salle a déjà sa rangée dédiée : le retrouver aussi
        // dans les tendances ferait doublon et brouillerait la distinction
        // entre « au cinéma » et « disponible ailleurs en ce moment ».
        const theatricalExclusion = new Set(
            theaters.filter((row) => typeof row.id === 'number').map((row) => row.id),
        );
        const trending = await backfillTrending(
            trendingInitial, declared, theatricalExclusion, tmdbApiKey.value(),
        );

        res.status(200).json({
          in_theaters: cleanHomeRow(rankedTheaters, declared, noExclusion)
              .map(discoverRowToJSON),
          trending: cleanHomeRow(trending, declared, theatricalExclusion)
              .map(discoverRowToJSON),
          because_you_watched: seedId === null ? null : {
            seed_id: seedId,
            seed_title: titleById.get(seedId) ?? null,
            items: cleanHomeRow(seededRaw, declared, seededExclusion)
                .map(discoverRowToJSON),
          },
        });
      } catch (error) {
        if (sendTMDBError(error, res)) return;
        logger.error('getHomeRows failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

// ===========================================================================
// Badges — evaluateBadges
//
// Évalué côté serveur, jamais côté client : un badge qu'on peut s'attribuer
// soi-même ne vaut rien. La fonction renvoie l'état des quinze badges avec
// leur progression, et persiste ceux qui viennent d'être obtenus — une fois
// débloqué, un badge le reste, même si la galerie rétrécit ensuite.
// ===========================================================================

/** Fuseau de référence pour les séries de jours et les heures nocturnes. */
const BADGE_TIMEZONE = 'Europe/Paris';

/** Genres TMDB utilisés par les badges de genre. */
const GENRE_ACTION = 28;

interface BadgeState {
  id: string;
  unlocked: boolean;
  unlockedAt: string | null;
  current: number;
  target: number;
  /** Détail lisible de ce qui manque, quand on peut le dire précisément. */
  detail: string | null;
}

interface GalleryFact {
  tmdbId: number;
  genreIds: number[];
  year: number | null;
  decade: number | null;
  director: string | null;
  collectionId: number | null;
  collectionTotal: number | null;
  addedAt: Date | null;
}

/**
 * Jour civil `YYYY-MM-DD` dans le fuseau de référence — et non en UTC : un
 * ajout à 1 h du matin appartient à la nuit précédente pour l'utilisateur.
 * @param {Date} date Instant à convertir.
 * @return {string} Jour civil.
 */
function parisDay(date: Date): string {
  return date.toLocaleDateString('en-CA', {timeZone: BADGE_TIMEZONE});
}

/**
 * Heure locale (0-23) dans le fuseau de référence.
 * @param {Date} date Instant à convertir.
 * @return {number} Heure locale.
 */
function parisHour(date: Date): number {
  const raw = date.toLocaleString('en-GB', {
    timeZone: BADGE_TIMEZONE, hour: '2-digit', hour12: false,
  });
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Plus longue série de jours consécutifs ayant reçu au moins un ajout.
 *
 * On mesure la plus longue série *jamais* atteinte, pas celle en cours : un
 * accomplissement ne se reperd pas parce qu'on a sauté un jour.
 * @param {string[]} days Jours civils, doublons autorisés.
 * @return {number} Longueur de la plus longue série.
 */
function longestDayStreak(days: string[]): number {
  const unique = Array.from(new Set(days)).sort();
  if (unique.length === 0) return 0;

  let best = 1;
  let run = 1;
  for (let i = 1; i < unique.length; i++) {
    const previous = new Date(`${unique[i - 1]}T00:00:00Z`).getTime();
    const current = new Date(`${unique[i]}T00:00:00Z`).getTime();
    const gapDays = Math.round((current - previous) / 86400000);
    run = gapDays === 1 ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

/**
 * Transforme les documents de galerie en faits exploitables par les règles.
 * @param {admin.firestore.QueryDocumentSnapshot[]} docs Documents de galerie.
 * @return {GalleryFact[]} Faits normalisés.
 */
function toGalleryFacts(
    docs: admin.firestore.QueryDocumentSnapshot[],
): GalleryFact[] {
  return docs.map((doc) => {
    const releaseDate = doc.get('releaseDate');
    const year = typeof releaseDate === 'string' && releaseDate.length >= 4 ?
      Number(releaseDate.slice(0, 4)) : null;
    const addedAt = doc.get('addedAt');

    return {
      tmdbId: typeof doc.get('tmdbId') === 'number' ? doc.get('tmdbId') : 0,
      genreIds: Array.isArray(doc.get('genreIds')) ? doc.get('genreIds') : [],
      year: year !== null && Number.isFinite(year) ? year : null,
      decade: year !== null && Number.isFinite(year) ?
        Math.floor(year / 10) * 10 : null,
      director: typeof doc.get('director') === 'string' ? doc.get('director') : null,
      collectionId: typeof doc.get('collectionId') === 'number' ?
        doc.get('collectionId') : null,
      collectionTotal: typeof doc.get('collectionTotal') === 'number' ?
        doc.get('collectionTotal') : null,
      addedAt: addedAt instanceof admin.firestore.Timestamp ?
        addedAt.toDate() : null,
    };
  });
}

/** Compte les valeurs distinctes d'une clé, en ignorant les nulls. */
function countBy<T>(items: T[], key: (item: T) => string | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/**
 * Applique les quinze règles.
 * @param {GalleryFact[]} facts Galerie normalisée.
 * @param {number} watchlistSize Taille actuelle de la watchlist.
 * @param {number} watchlistPeak Plus grande taille jamais atteinte.
 * @param {number} totalDecisions Nombre de cartes tranchées au swipe.
 * @param {Map<string, string>} genreNames Noms de genres, pour les détails.
 * @return {BadgeState[]} État des quinze badges, sans les dates d'obtention.
 */
function computeBadgeStates(
    facts: GalleryFact[],
    watchlistSize: number,
    watchlistPeak: number,
    totalDecisions: number,
    genreNames: Map<string, string>,
): BadgeState[] {
  const size = facts.length;

  const decades = new Set<number>();
  for (const fact of facts) if (fact.decade !== null) decades.add(fact.decade);

  const genreCounts = new Map<number, number>();
  for (const fact of facts) {
    for (const genreId of fact.genreIds) {
      genreCounts.set(genreId, (genreCounts.get(genreId) ?? 0) + 1);
    }
  }
  const genresWithTen = Array.from(genreCounts.values())
      .filter((n) => n >= 10).length;

  const streak = longestDayStreak(
      facts.map((f) => f.addedAt).filter((d): d is Date => d !== null).map(parisDay),
  );

  const directorCounts = countBy(facts, (f) => f.director);
  const topDirector = Math.max(0, ...Array.from(directorCounts.values()));

  // Une saga est complète quand le nombre d'épisodes possédés atteint le
  // nombre total d'épisodes que TMDB lui connaît.
  const collectionOwned = new Map<number, number>();
  const collectionTotal = new Map<number, number>();
  for (const fact of facts) {
    if (fact.collectionId === null) continue;
    collectionOwned.set(fact.collectionId, (collectionOwned.get(fact.collectionId) ?? 0) + 1);
    if (fact.collectionTotal !== null) {
      collectionTotal.set(fact.collectionId, fact.collectionTotal);
    }
  }
  let bestCollectionRatio = 0;
  let completedCollections = 0;
  for (const [id, owned] of collectionOwned) {
    const total = collectionTotal.get(id);
    if (!total || total < 2) continue;
    if (owned >= total) completedCollections++;
    bestCollectionRatio = Math.max(bestCollectionRatio, owned / total);
  }

  const nightAdds = facts.filter((f) => {
    if (f.addedAt === null) return false;
    const hour = parisHour(f.addedAt);
    return hour >= 2 && hour < 5;
  }).length;

  const preSeventies = facts.filter((f) => f.year !== null && f.year < 1970).length;

  const missingDecades = [1930, 1940, 1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020]
      .filter((d) => !decades.has(d));

  const actionName = genreNames.get(String(GENRE_ACTION)) ?? 'action';

  const rule = (
    id: string, current: number, target: number, detail: string | null = null,
  ): BadgeState => ({
    id,
    unlocked: current >= target,
    unlockedAt: null,
    current: Math.min(current, target),
    target,
    detail,
  });

  return [
    rule('first_reel', size, 1),
    rule('centenary', size, 100),
    rule('cinematheque', size, 500),
    rule('archaeologist', preSeventies, 25),
    rule('traveler', decades.size, 8,
      missingDecades.length > 0 && decades.size < 8 ?
        `Il vous manque les années ${missingDecades.slice(0, 3).join(', ')}.` : null),
    rule('steel_heart', genreCounts.get(GENRE_ACTION) ?? 0, 75,
      `Films d'${actionName.toLowerCase()} dans votre galerie.`),
    rule('sleepless', genreCounts.get(27) ?? 0, 40),
    rule('panoramic', genresWithTen, 8,
      `${genresWithTen} genres comptent déjà au moins 10 films.`),
    rule('marathon', streak, 7),
    rule('ritual', streak, 60),
    rule('clean_list',
      watchlistPeak >= 15 && watchlistSize === 0 ? 1 : 0, 1,
      watchlistPeak < 15 ?
        `Votre watchlist doit d'abord atteindre 15 films (record : ${watchlistPeak}).` :
        `Il reste ${watchlistSize} film${watchlistSize > 1 ? 's' : ''} à voir.`),
    rule('sorter', totalDecisions, 500),
    rule('signature', topDirector, 8),
    rule('integral', completedCollections > 0 ? 1 : 0, 1,
      bestCollectionRatio > 0 ?
        `Votre saga la plus avancée est complétée à ${Math.round(bestCollectionRatio * 100)} %.` : null),
    rule('night_owl', nightAdds, 15),
  ];
}

/**
 * Renvoie l'état complet des badges et persiste les nouvelles obtentions.
 */
export const evaluateBadges = onRequest(
    {invoker: 'public', timeoutSeconds: 60},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'POST') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const a = getAdmin();
        const db = a.firestore();
        const userRef = db.collection('users').doc(uid);

        const [gallerySnap, watchlistSnap, swipeSnap, badgesSnap, stateSnap] =
          await Promise.all([
            userRef.collection('gallery').get(),
            userRef.collection('watchlist').get(),
            userRef.collection('preferences').doc('swipeProfile').get(),
            userRef.collection('badges').get(),
            userRef.collection('preferences').doc('badgeState').get(),
          ]);

        const counters = parseSwipeCounters(swipeSnap);
        const sumValues = (record: Record<string, number>): number =>
          Object.values(record).reduce((total, n) => total + n, 0);
        // `totalDecisions` n'existe que pour les comptes récents : on retombe
        // sur les compteurs par décennie, qui valent un par film tranché.
        const storedTotal = swipeSnap.get('totalDecisions');
        const totalDecisions = typeof storedTotal === 'number' ? storedTotal :
          sumValues(counters.decadeSeen) + sumValues(counters.decadeSkipped);

        const previousPeak = stateSnap.get('watchlistPeak');
        const watchlistPeak = Math.max(
            typeof previousPeak === 'number' ? previousPeak : 0,
            watchlistSnap.size,
        );

        const genreNames = new Map<string, string>();
        const states = computeBadgeStates(
            toGalleryFacts(gallerySnap.docs),
            watchlistSnap.size,
            watchlistPeak,
            totalDecisions,
            genreNames,
        );

        const alreadyUnlocked = new Map<string, admin.firestore.Timestamp>();
        for (const doc of badgesSnap.docs) {
          const at = doc.get('unlockedAt');
          if (at instanceof admin.firestore.Timestamp) alreadyUnlocked.set(doc.id, at);
        }

        const now = a.firestore.Timestamp.now();
        const batch = db.batch();
        let writes = 0;

        const payload = states.map((state) => {
          const existing = alreadyUnlocked.get(state.id);
          if (existing) {
            // Déjà obtenu : il le reste, quoi qu'il arrive à la galerie.
            return {...state, unlocked: true, unlockedAt: existing.toDate().toISOString(),
              current: state.target};
          }
          if (state.unlocked) {
            batch.set(userRef.collection('badges').doc(state.id), {
              id: state.id, unlockedAt: now,
            });
            writes++;
            return {...state, unlockedAt: now.toDate().toISOString()};
          }
          return state;
        });

        if (watchlistPeak !== previousPeak) {
          batch.set(
              userRef.collection('preferences').doc('badgeState'),
              {watchlistPeak, updatedAt: now},
              {merge: true},
          );
          writes++;
        }
        if (writes > 0) await batch.commit();

        res.status(200).json({badges: payload});
      } catch (error) {
        logger.error('evaluateBadges failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

// ===========================================================================
// Le Hall — dimension sociale
//
// `claimHandle` est la brique de base : sans pseudo unique, ni la recherche
// ni le profil public n'ont de quoi exister. `usernames/{handle}` sert
// uniquement de garde-fou d'unicité — jamais lu par le client, voir
// firestore.rules — et n'est modifié qu'à l'intérieur de la transaction
// ci-dessous, seule façon d'empêcher deux comptes de réserver le même
// pseudo en même temps.
// ===========================================================================

const HANDLE_MIN_LENGTH = 3;
const HANDLE_MAX_LENGTH = 20;
/**
 * Minuscules, chiffres, point, tiret et tiret bas — rien d'ambigu à l'oral.
 * Le tiret est en fin de classe : ailleurs, il y désignerait un intervalle.
 */
const HANDLE_PATTERN = /^[a-z0-9_.-]+$/;

/**
 * Normalise un pseudo pour comparaison/stockage : espaces retirés, minuscules.
 * @param {string} raw Pseudo tel que saisi.
 * @return {string} Pseudo normalisé.
 */
function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Normalise un nom pour la recherche par préfixe — mêmes règles que
 * `SocialStore.normalize` côté client : « Léa » doit trouver « lea ».
 * @param {string} raw Nom tel qu'affiché.
 * @return {string} Nom normalisé, sans accents ni casse.
 */
function normalizeSearchText(raw: string): string {
  return raw
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
}

/**
 * Un pseudo utilisable : longueur et alphabet, une fois normalisé.
 * @param {string} normalized Pseudo déjà normalisé.
 * @return {boolean} Vrai si le pseudo respecte le format attendu.
 */
function isValidHandle(normalized: string): boolean {
  return (
    normalized.length >= HANDLE_MIN_LENGTH &&
    normalized.length <= HANDLE_MAX_LENGTH &&
    HANDLE_PATTERN.test(normalized)
  );
}

/**
 * Réserve un pseudo pour l'utilisateur authentifié, et crée ou met à jour
 * son profil public en conséquence.
 *
 * Un changement de pseudo est autorisé une fois : au-delà,
 * `handle_change_limit`. Resoumettre le pseudo déjà actif est sans effet
 * (`ok: true`, sans écriture).
 */
export const claimHandle = onRequest(
    {invoker: 'public'},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'POST') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const rawHandle = req.body?.handle;
        if (typeof rawHandle !== 'string') {
          res.status(400).json({error: 'invalid_handle'});
          return;
        }
        const handleNormalized = normalizeHandle(rawHandle);
        if (!isValidHandle(handleNormalized)) {
          res.status(400).json({error: 'invalid_handle'});
          return;
        }

        const a = getAdmin();
        const db = a.firestore();
        const usernameRef = db.collection('usernames').doc(handleNormalized);
        const profileRef = db.collection('publicProfiles').doc(uid);
        // Lu une seule fois, hors transaction : une lecture Auth n'a rien à
        // faire dans un bloc que Firestore peut rejouer plusieurs fois.
        const authUser = await a.auth().getUser(uid);

        const outcome = await db.runTransaction(async (tx) => {
          const [usernameSnap, profileSnap] = await Promise.all([
            tx.get(usernameRef),
            tx.get(profileRef),
          ]);

          if (usernameSnap.exists && usernameSnap.get('uid') !== uid) {
            return {status: 409 as const, error: 'handle_taken' as const};
          }

          const previousHandleNormalized =
            profileSnap.get('handleNormalized') as string | undefined;
          if (previousHandleNormalized === handleNormalized) {
            // Même pseudo qu'aujourd'hui : idempotent, rien à écrire.
            return {status: 200 as const};
          }

          const changeCount =
            (profileSnap.get('handleChangeCount') as number | undefined) ?? 0;
          if (profileSnap.exists && changeCount >= 1) {
            return {
              status: 409 as const,
              error: 'handle_change_limit' as const,
            };
          }

          const now = a.firestore.Timestamp.now();

          if (profileSnap.exists && previousHandleNormalized) {
            tx.delete(db.collection('usernames').doc(previousHandleNormalized));
          }
          tx.set(usernameRef, {uid, createdAt: now});

          if (profileSnap.exists) {
            tx.update(profileRef, {
              handle: rawHandle.trim(),
              handleNormalized,
              handleChangeCount: a.firestore.FieldValue.increment(1),
              updatedAt: now,
            });
          } else {
            const displayName = authUser.displayName ?? handleNormalized;
            tx.set(profileRef, {
              handle: rawHandle.trim(),
              handleNormalized,
              displayName,
              // Sans ce champ, la recherche ne trouverait un profil que par
              // pseudo — jamais par prénom ou nom.
              displayNameNormalized: normalizeSearchText(displayName),
              avatarURL: null,
              badgeSignature: null,
              followerCount: 0,
              followingCount: 0,
              galleryCount: 0,
              handleChangeCount: 0,
              createdAt: now,
              updatedAt: now,
            });
          }

          return {status: 200 as const};
        });

        if (outcome.status !== 200) {
          res.status(outcome.status).json({error: outcome.error});
          return;
        }
        res.status(200).json({ok: true, handle: rawHandle.trim()});
      } catch (error) {
        logger.error('claimHandle failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

/**
 * Dit si un pseudo est libre, sans le réserver.
 *
 * Public et non authentifiée : à l'inscription, ce contrôle a lieu *avant*
 * la création du compte, donc avant qu'un jeton Firebase n'existe. Le seul
 * renseignement exposé est un booléen sur un format déjà normalisé — la
 * collection `usernames` reste par ailleurs fermée en lecture
 * (voir firestore.rules), et cette route ne l'ouvre pas davantage : elle ne
 * renvoie jamais l'`uid` associé, seulement l'existence du document.
 *
 * `claimHandle` reste la seule source de vérité : un pseudo dit « libre »
 * ici peut être pris entretemps par un autre compte, et c'est la réponse de
 * `claimHandle` à l'inscription qui tranche pour de bon.
 */
export const handleAvailable = onRequest(
    {invoker: 'public'},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'GET') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }

        const raw = req.query.handle;
        if (typeof raw !== 'string') {
          res.status(400).json({error: 'invalid_handle'});
          return;
        }
        const handleNormalized = normalizeHandle(raw);
        if (!isValidHandle(handleNormalized)) {
          res.status(400).json({error: 'invalid_handle'});
          return;
        }

        const db = getAdmin().firestore();
        const usernameRef = db.collection('usernames').doc(handleNormalized);
        const snap = await usernameRef.get();

        res.status(200).json({available: !snap.exists});
      } catch (error) {
        logger.error('handleAvailable failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

// ---------------------------------------------------------------------------
// Le graphe de suivi.
//
// `following` et `followers` sont deux vues du même lien, sur deux comptes
// différents : le client ne peut jamais écrire les deux à la fois, et
// firestore.rules le lui interdit. `applyFollowChange` les tient en
// transaction, compteurs de `publicProfiles` inclus — sans elle, un compteur
// pourrait dériver de la liste réelle au moindre écrit partiel.
// ---------------------------------------------------------------------------

/** Résultat d'un changement de suivi, prêt à devenir une réponse HTTP. */
interface FollowChangeOutcome {
  status: number;
  error?: string;
}

/**
 * Applique ou retire le lien de suivi entre deux comptes, compteurs compris.
 * Idempotente : suivre deux fois, ou se désabonner sans être abonné, réussit
 * sans rien réécrire.
 * @param {admin.firestore.Firestore} db Firestore.
 * @param {string} followerUid Celui qui suit.
 * @param {string} targetUid Celui qui est suivi.
 * @param {boolean} follow Vrai pour suivre, faux pour se désabonner.
 * @return {Promise<FollowChangeOutcome>} Résultat à renvoyer au client.
 */
async function applyFollowChange(
    db: admin.firestore.Firestore,
    followerUid: string,
    targetUid: string,
    follow: boolean,
): Promise<FollowChangeOutcome> {
  const a = getAdmin();
  const followingRef = db.collection('users').doc(followerUid)
      .collection('following').doc(targetUid);
  const followerRef = db.collection('users').doc(targetUid)
      .collection('followers').doc(followerUid);
  const ownProfileRef = db.collection('publicProfiles').doc(followerUid);
  const targetProfileRef = db.collection('publicProfiles').doc(targetUid);

  return db.runTransaction(async (tx) => {
    const [linkSnap, ownProfileSnap, targetProfileSnap] = await Promise.all([
      tx.get(followingRef),
      tx.get(ownProfileRef),
      tx.get(targetProfileRef),
    ]);

    if (!ownProfileSnap.exists) {
      return {status: 404, error: 'own_profile_missing'};
    }
    if (follow && !targetProfileSnap.exists) {
      return {status: 404, error: 'target_not_found'};
    }
    if (linkSnap.exists === follow) {
      // Déjà dans l'état demandé : idempotent, rien à écrire.
      return {status: 200};
    }

    const now = a.firestore.Timestamp.now();
    const delta = follow ? 1 : -1;

    if (follow) {
      tx.set(followingRef, {since: now});
      tx.set(followerRef, {since: now});
    } else {
      tx.delete(followingRef);
      tx.delete(followerRef);
    }
    tx.update(ownProfileRef, {
      followingCount: a.firestore.FieldValue.increment(delta),
    });
    if (targetProfileSnap.exists) {
      tx.update(targetProfileRef, {
        followerCount: a.firestore.FieldValue.increment(delta),
      });
    }

    return {status: 200};
  });
}

/**
 * Lit et valide le `targetUid` d'une requête de suivi.
 * @param {Request} req Requête entrante.
 * @param {Response} res Réponse, pour l'erreur en cas de payload invalide.
 * @param {string} followerUid Compte à l'origine de la requête.
 * @return {string | null} L'identifiant cible, ou `null` si déjà répondu.
 */
function readTargetUid(
    req: Request, res: Response, followerUid: string,
): string | null {
  const targetUid = req.body?.targetUid;
  if (typeof targetUid !== 'string' || !targetUid) {
    res.status(400).json({error: 'invalid_target'});
    return null;
  }
  if (targetUid === followerUid) {
    res.status(400).json({error: 'cannot_follow_self'});
    return null;
  }
  return targetUid;
}

/** Suit le profil `targetUid` depuis le compte authentifié. */
export const followUser = onRequest(
    {invoker: 'public'},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'POST') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const targetUid = readTargetUid(req, res, uid);
        if (!targetUid) return;

        const db = getAdmin().firestore();
        const outcome = await applyFollowChange(db, uid, targetUid, true);
        res.status(outcome.status).json(
            outcome.status === 200 ? {ok: true} : {error: outcome.error},
        );
      } catch (error) {
        logger.error('followUser failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

/** Se désabonne du profil `targetUid` depuis le compte authentifié. */
export const unfollowUser = onRequest(
    {invoker: 'public'},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'POST') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const targetUid = readTargetUid(req, res, uid);
        if (!targetUid) return;

        const db = getAdmin().firestore();
        const outcome = await applyFollowChange(db, uid, targetUid, false);
        res.status(outcome.status).json(
            outcome.status === 200 ? {ok: true} : {error: outcome.error},
        );
      } catch (error) {
        logger.error('unfollowUser failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

// ---------------------------------------------------------------------------
// Recommander un film — sendSuggestion / respondToSuggestion.
//
// Les trois vérifications d'envoi (lien de suivi, film vu par l'expéditeur,
// pas encore vu par le destinataire) croisent des documents dans deux arbres
// différents : aucune règle Firestore déclarative ne peut les exprimer. La
// suggestion est stockée sous un identifiant déterministe
// `{fromUid}_{itemId}`, ce qui rend « déjà recommandé, en attente » gratuit
// à vérifier — c'est la même existence de document que la transaction
// regarde de toute façon.
// ---------------------------------------------------------------------------

/** Le film stocké sur une suggestion, réinjecté ensuite dans la watchlist. */
interface SuggestionItem {
  id: string;
  tmdbId: number;
  mediaType: string;
  title: string;
  posterPath: string | null;
  overview: string | null;
  voteAverage: number | null;
  genreIds: number[];
  releaseDate: string | null;
}

/**
 * Lit et valide l'item film d'une requête, avec la même règle que
 * `setMediaStatus` — c'est le format que le client envoie déjà partout.
 * @param {Request} req Requête entrante.
 * @param {Response} res Réponse, pour l'erreur en cas de payload invalide.
 * @return {MediaItemPayload | null} L'item, ou `null` si déjà répondu.
 */
function readMediaItem(req: Request, res: Response): MediaItemPayload | null {
  const item = req.body?.item as MediaItemPayload | undefined;
  if (!item?.id || !item?.tmdbId || !item?.mediaType || !item?.title) {
    res.status(400).json({error: 'invalid_item'});
    return null;
  }
  return item;
}

/**
 * Recommande un film déjà vu par l'expéditeur à quelqu'un qu'il suit, qui ne
 * l'a pas encore vu.
 */
export const sendSuggestion = onRequest(
    {invoker: 'public'},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'POST') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }
        const fromUid = await verifyAuth(req, res);
        if (!fromUid) return;

        const targetUid = readTargetUid(req, res, fromUid);
        if (!targetUid) return;

        const item = readMediaItem(req, res);
        if (!item) return;

        const a = getAdmin();
        const db = a.firestore();
        const followingRef = db.collection('users').doc(fromUid)
            .collection('following').doc(targetUid);
        const senderGalleryRef = db.collection('users').doc(fromUid)
            .collection('gallery').doc(item.id);
        const targetGalleryRef = db.collection('users').doc(targetUid)
            .collection('gallery').doc(item.id);
        const senderProfileRef = db.collection('publicProfiles').doc(fromUid);
        const suggestionRef = db.collection('users').doc(targetUid)
            .collection('suggestions').doc(`${fromUid}_${item.id}`);

        const outcome = await db.runTransaction(async (tx) => {
          const [
            followingSnap, senderGallerySnap, targetGallerySnap,
            senderProfileSnap, existingSnap,
          ] = await Promise.all([
            tx.get(followingRef),
            tx.get(senderGalleryRef),
            tx.get(targetGalleryRef),
            tx.get(senderProfileRef),
            tx.get(suggestionRef),
          ]);

          if (!senderProfileSnap.exists) {
            return {
              status: 404 as const,
              error: 'own_profile_missing' as const,
            };
          }
          if (!followingSnap.exists) {
            return {status: 403 as const, error: 'not_following' as const};
          }
          if (!senderGallerySnap.exists) {
            return {status: 400 as const, error: 'not_in_gallery' as const};
          }
          if (targetGallerySnap.exists) {
            return {
              status: 409 as const,
              error: 'target_already_seen' as const,
            };
          }
          if (existingSnap.exists) {
            return {status: 409 as const, error: 'already_suggested' as const};
          }

          tx.set(suggestionRef, {
            fromUid,
            fromHandle: senderProfileSnap.get('handle') ?? null,
            fromDisplayName: senderProfileSnap.get('displayName') ?? null,
            fromAvatarURL: senderProfileSnap.get('avatarURL') ?? null,
            item: {
              id: item.id,
              tmdbId: item.tmdbId,
              mediaType: item.mediaType,
              title: item.title,
              posterPath: item.posterPath ?? null,
              overview: item.overview ?? null,
              voteAverage: item.voteAverage ?? null,
              genreIds: item.genreIds ?? [],
              releaseDate: item.releaseDate ?? null,
            },
            createdAt: a.firestore.Timestamp.now(),
          });

          return {status: 200 as const};
        });

        res.status(outcome.status).json(
            outcome.status === 200 ? {ok: true} : {error: outcome.error},
        );
      } catch (error) {
        logger.error('sendSuggestion failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

/**
 * Accepte ou refuse une recommandation reçue.
 *
 * Refuser supprime la suggestion, sans plus de trace. Accepter l'ajoute à la
 * watchlist — ou, si le film y est déjà, ajoute simplement ce recommandeur à
 * `recommendedBy` plutôt que de dupliquer l'entrée : l'identifiant du
 * document watchlist est déjà celui du film, pas d'un événement.
 *
 * Le cas « vu entretemps » (course entre l'envoi et la réponse) se résout
 * sans erreur : la suggestion disparaît, rien n'est ajouté, et
 * `alreadySeen: true` le dit au client.
 */
export const respondToSuggestion = onRequest(
    {invoker: 'public'},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'POST') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const suggestionId = req.body?.suggestionId;
        const accept = req.body?.accept;
        if (typeof suggestionId !== 'string' || !suggestionId) {
          res.status(400).json({error: 'invalid_suggestion'});
          return;
        }
        if (typeof accept !== 'boolean') {
          res.status(400).json({error: 'invalid_accept'});
          return;
        }

        const a = getAdmin();
        const db = a.firestore();
        const userRef = db.collection('users').doc(uid);
        const suggestionRef =
          userRef.collection('suggestions').doc(suggestionId);

        const outcome = await db.runTransaction(async (tx) => {
          const suggestionSnap = await tx.get(suggestionRef);
          if (!suggestionSnap.exists) {
            return {
              status: 404 as const,
              error: 'suggestion_not_found' as const,
            };
          }

          if (!accept) {
            tx.delete(suggestionRef);
            return {status: 200 as const, alreadySeen: false};
          }

          const item = suggestionSnap.get('item') as SuggestionItem;
          const galleryRef = userRef.collection('gallery').doc(item.id);
          const watchlistRef = userRef.collection('watchlist').doc(item.id);
          const [gallerySnap, watchlistSnap] = await Promise.all([
            tx.get(galleryRef),
            tx.get(watchlistRef),
          ]);

          if (gallerySnap.exists) {
            // Vu entretemps, par un autre chemin : la recommandation n'a
            // simplement plus d'objet.
            tx.delete(suggestionRef);
            return {status: 200 as const, alreadySeen: true};
          }

          const now = a.firestore.Timestamp.now();
          const recommender = {
            uid: suggestionSnap.get('fromUid') ?? null,
            displayName: suggestionSnap.get('fromDisplayName') ?? null,
            avatarURL: suggestionSnap.get('fromAvatarURL') ?? null,
            at: now,
          };

          if (watchlistSnap.exists) {
            tx.update(watchlistRef, {
              recommendedBy: a.firestore.FieldValue.arrayUnion(recommender),
            });
          } else {
            tx.set(watchlistRef, {
              id: item.id,
              tmdbId: item.tmdbId,
              mediaType: item.mediaType,
              title: item.title,
              posterPath: item.posterPath,
              overview: item.overview,
              voteAverage: item.voteAverage,
              genreIds: item.genreIds ?? [],
              releaseDate: item.releaseDate,
              addedAt: now,
              recommendedBy: [recommender],
            });
          }

          tx.delete(suggestionRef);
          return {status: 200 as const, alreadySeen: false};
        });

        if (outcome.status !== 200) {
          res.status(outcome.status).json({error: outcome.error});
          return;
        }
        res.status(200).json({ok: true, alreadySeen: outcome.alreadySeen});
      } catch (error) {
        logger.error('respondToSuggestion failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

/**
 * Les abonnements du compte, chacun avec son état vis-à-vis d'un film donné.
 *
 * C'est cette fonction qui permet au sélecteur d'ami de n'offrir que ce qui
 * est possible : sans elle, le client devrait lire la galerie d'autrui pour
 * savoir qui a déjà vu le film — ce que les règles Firestore interdisent, et
 * à raison. Le serveur croise ici trois arbres et ne renvoie qu'un booléen
 * par personne, jamais le contenu d'une galerie.
 */
export const getSuggestionTargets = onRequest(
    {invoker: 'public', timeoutSeconds: 60},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'POST') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const itemId = req.body?.itemId;
        if (typeof itemId !== 'string' || !itemId) {
          res.status(400).json({error: 'invalid_item'});
          return;
        }

        const db = getAdmin().firestore();
        const followingSnap = await db.collection('users').doc(uid)
            .collection('following').get();
        const targetUids = followingSnap.docs.map((doc) => doc.id);
        if (targetUids.length === 0) {
          res.status(200).json({targets: []});
          return;
        }

        // Trois lectures par abonnement, toutes ponctuelles et parallèles :
        // le profil public (affichage), sa galerie pour ce film (déjà vu ?)
        // et la suggestion éventuellement déjà en attente. Aucune requête
        // ne dépend du résultat d'une autre.
        const targets = await Promise.all(targetUids.map(async (targetUid) => {
          const [profileSnap, gallerySnap, suggestionSnap] = await Promise.all([
            db.collection('publicProfiles').doc(targetUid).get(),
            db.collection('users').doc(targetUid)
                .collection('gallery').doc(itemId).get(),
            db.collection('users').doc(targetUid)
                .collection('suggestions').doc(`${uid}_${itemId}`).get(),
          ]);

          if (!profileSnap.exists) return null;

          const suggestedAt = suggestionSnap.get('createdAt');
          return {
            uid: targetUid,
            handle: profileSnap.get('handle') ?? null,
            displayName: profileSnap.get('displayName') ?? null,
            avatarURL: profileSnap.get('avatarURL') ?? null,
            alreadySeen: gallerySnap.exists,
            alreadySuggested: suggestionSnap.exists,
            suggestedAt: suggestedAt instanceof admin.firestore.Timestamp ?
              suggestedAt.toDate().toISOString() : null,
          };
        }));

        type Target = NonNullable<(typeof targets)[number]>;
        const clean = targets.filter((t): t is Target => t !== null);
        // Ceux à qui on peut réellement envoyer remontent en tête : la liste
        // se lit alors de haut en bas sans avoir à sauter les lignes mortes.
        clean.sort((a, b) => {
          const blockedA = a.alreadySeen || a.alreadySuggested ? 1 : 0;
          const blockedB = b.alreadySeen || b.alreadySuggested ? 1 : 0;
          if (blockedA !== blockedB) return blockedA - blockedB;
          return (a.displayName ?? '').localeCompare(b.displayName ?? '');
        });

        res.status(200).json({targets: clean});
      } catch (error) {
        logger.error('getSuggestionTargets failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

/** Affiches renvoyées avec un profil public — un aperçu, pas la galerie. */
const PUBLIC_PROFILE_POSTERS = 12;
/** Genres détaillés sur l'ADN cinéphile ; le reste tombe dans « Autres ». */
const PUBLIC_PROFILE_GENRES = 5;

/**
 * Le profil public d'un utilisateur, enrichi de quoi décider de le suivre.
 *
 * La galerie d'autrui n'est jamais exposée telle quelle — les règles
 * Firestore l'interdisent au client, et c'est volontaire. Le serveur en
 * dérive ici deux agrégats : la répartition par genre (l'information qui
 * décide réellement d'un abonnement) et une poignée d'affiches récentes.
 * La watchlist, elle, ne sort pas : une intention de voir est une note à
 * soi-même, pas une déclaration publique.
 */
export const getPublicProfile = onRequest(
    {invoker: 'public', timeoutSeconds: 60},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'POST') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const targetUid = req.body?.targetUid;
        if (typeof targetUid !== 'string' || !targetUid) {
          res.status(400).json({error: 'invalid_target'});
          return;
        }

        const db = getAdmin().firestore();
        const [profileSnap, gallerySnap] = await Promise.all([
          db.collection('publicProfiles').doc(targetUid).get(),
          db.collection('users').doc(targetUid).collection('gallery').get(),
        ]);

        if (!profileSnap.exists) {
          res.status(404).json({error: 'target_not_found'});
          return;
        }

        const docs = gallerySnap.docs;

        // Répartition par genre, sur le premier genre de chaque film — le
        // même choix que la galerie côté client, pour que les deux écrans
        // racontent la même chose.
        const counts = new Map<number, number>();
        for (const doc of docs) {
          const ids = doc.get('genreIds');
          if (!Array.isArray(ids) || ids.length === 0) continue;
          const primary = ids[0];
          if (typeof primary !== 'number') continue;
          counts.set(primary, (counts.get(primary) ?? 0) + 1);
        }
        const total = [...counts.values()].reduce((a, b) => a + b, 0);
        const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        const top = ranked.slice(0, PUBLIC_PROFILE_GENRES);
        const genres = top.map(([id, n]) => ({
          id,
          name: GENRE_LABELS_FR[id] ?? `Genre ${id}`,
          share: total > 0 ? n / total : 0,
        }));
        const remainder = ranked.slice(PUBLIC_PROFILE_GENRES)
            .reduce((sum, [, n]) => sum + n, 0);
        if (remainder > 0 && total > 0) {
          genres.push({id: -1, name: 'Autres', share: remainder / total});
        }

        // Les plus récemment ajoutés, affiche obligatoire.
        const posters = docs
            .map((doc) => ({
              posterPath: doc.get('posterPath') as string | null,
              title: doc.get('title') as string | null,
              addedAt: doc.get('addedAt'),
            }))
            .filter((row) => !!row.posterPath)
            .sort((a, b) => {
              const ta = a.addedAt instanceof admin.firestore.Timestamp ?
                a.addedAt.toMillis() : 0;
              const tb = b.addedAt instanceof admin.firestore.Timestamp ?
                b.addedAt.toMillis() : 0;
              return tb - ta;
            })
            .slice(0, PUBLIC_PROFILE_POSTERS)
            .map((row) => ({posterPath: row.posterPath, title: row.title}));

        res.status(200).json({
          uid: targetUid,
          handle: profileSnap.get('handle') ?? null,
          displayName: profileSnap.get('displayName') ?? null,
          avatarURL: profileSnap.get('avatarURL') ?? null,
          badgeSignature: profileSnap.get('badgeSignature') ?? null,
          followerCount: profileSnap.get('followerCount') ?? 0,
          followingCount: profileSnap.get('followingCount') ?? 0,
          galleryCount: docs.length,
          genres,
          posters,
        });
      } catch (error) {
        logger.error('getPublicProfile failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);
