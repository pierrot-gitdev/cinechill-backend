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
          poster_path: data.poster_path ?? null,
          backdrop_path: data.backdrop_path ?? null,
          vote_average: data.vote_average ?? null,
          release_date: data.release_date ?? null,
          first_air_date: data.first_air_date ?? null,
          director,
          trailer_key: trailerKey,
          genre_names: genreNames,
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

        const [exclusionSet, rawPool] = await Promise.all([
          fetchExclusionSet(db, uid),
          fetchCandidatePool(answers, {dealbreaker: true, platforms: false}, tmdbApiKey.value()),
        ]);

        let pool = filterByContentFormat(
            rawPool.filter((row) => !exclusionSet.has(row.id)), answers,
        );
        let notice: string | null = null;

        if (pool.length < POOL_HARD_FLOOR && answers.platformIds.length > 0) {
          const relaxed = await fetchCandidatePool(
              answers, {dealbreaker: true, platforms: true}, tmdbApiKey.value(),
          );
          pool = filterByContentFormat(
              relaxed.filter((row) => !exclusionSet.has(row.id)), answers,
          );
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

  const pool = new Map<number, SwipeCandidate>();
  for (const [source, rows] of groups) {
    for (const row of rows) {
      if (typeof row.id !== 'number' || pool.has(row.id)) continue;
      if (!row.poster_path) continue;
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

  return clamp01(0.65 * notoriety + 0.35 * decadeAffinity);
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

        const [exclusions, countersSnap] = await Promise.all([
          fetchSwipeExclusions(db, uid),
          db.collection('users').doc(uid)
              .collection('preferences').doc('swipeProfile').get(),
        ]);

        const profile = buildTasteProfile(
            exclusions.galleryDocs, parseSwipeCounters(countersSnap),
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
            {...counters, updatedAt: now},
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
