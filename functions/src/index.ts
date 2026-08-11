import {setGlobalOptions} from 'firebase-functions/v2/options';
import {onRequest, Request} from 'firebase-functions/v2/https';
import {defineSecret, defineString} from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import {Response} from 'express';
import * as admin from 'firebase-admin';

/**
 * Initialise l'Admin SDK une seule fois, quel que soit le nombre de fonctions
 * qui l'utilisent dans cette invocation.
 * @return {admin} L'Admin SDK, prêt à l'emploi.
 */
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
 * Ce qu'il faut connaître pour interroger TMDB : de quoi s'authentifier, et
 * dans quelle langue répondre.
 *
 * Les deux voyagent ensemble parce qu'ils ont la même portée — celle d'une
 * requête entrante — et parce que les laisser séparés a une conséquence
 * concrète : on oublie la langue. Elle était jusqu'ici écrite en dur à
 * vingt-cinq endroits, et il suffisait d'en manquer un pour renvoyer un
 * synopsis français à une application en anglais.
 */
interface TMDBContext {
  token: string;
  language: string;
}

/** Les langues traduites. Toute autre demande retombe sur le français. */
const SUPPORTED_LANGUAGES = ['fr-FR', 'en-US'] as const;

/**
 * Lit la langue demandée dans l'en-tête `Accept-Language`, et déclare que la
 * réponse en dépend.
 *
 * On ne fait pas de négociation de contenu complète : le client est notre
 * application, elle envoie une étiquette qu'elle a choisie dans ses réglages.
 * On se contente donc de reconnaître la famille de langue et de retomber sur
 * le français pour tout le reste — mieux vaut une langue par défaut qu'une
 * réponse vide de TMDB pour un code exotique.
 *
 * Le `Vary` est posé ici plutôt que dans chaque point d'entrée, pour la même
 * raison que la langue est posée dans `tmdbGET` : lire l'en-tête et oublier de
 * déclarer qu'on en dépend est précisément l'erreur qu'on ne veut pas pouvoir
 * commettre. Rien ne met ces réponses en cache aujourd'hui — c'est le jour où
 * elles passeront derrière un CDN que l'oubli coûterait cher, en servant à
 * tout le monde la langue du premier arrivé.
 * @param {Request} req Requête entrante.
 * @param {Response} res Réponse en cours, pour y déclarer la variation.
 * @return {string} Étiquette de langue supportée par TMDB.
 */
function requestedLanguage(req: Request, res: Response): string {
  // `vary` plutôt que `set` : il complète l'en-tête au lieu de l'écraser.
  res.vary('Accept-Language');
  const header = String(req.get('accept-language') ?? '').toLowerCase();
  const exact = SUPPORTED_LANGUAGES.find((tag) =>
    header.startsWith(tag.toLowerCase()));
  if (exact) return exact;
  if (header.startsWith('en')) return 'en-US';
  return DEFAULT_LANGUAGE;
}

/**
 * Assemble le contexte TMDB d'une requête entrante.
 * @param {Request} req Requête entrante.
 * @param {Response} res Réponse en cours.
 * @return {TMDBContext} Contexte prêt pour `tmdbGET`.
 */
function tmdb(req: Request, res: Response): TMDBContext {
  return {
    token: tmdbApiKey.value(),
    language: requestedLanguage(req, res),
  };
}

/**
 * Call TMDB API using bearer auth.
 *
 * La langue est posée ici, une fois pour toutes : aucun appelant n'a plus à y
 * penser, et aucun ne peut l'oublier. Un appelant qui aurait une raison de la
 * forcer peut toujours la mettre dans `query`, qui a le dernier mot.
 *
 * La mise en cache est posée ici pour exactement la même raison, et c'est ce
 * qui la rend sûre : la clé est l'URL finale, celle que TMDB verra. Elle porte
 * donc par construction la langue, la page, la région et tout paramètre qu'un
 * appelant pourrait ajouter demain. Un cache posé chez les appelants aurait
 * demandé de recomposer cette clé à la main partout, et il aurait suffi d'en
 * oublier un pour servir à quelqu'un la réponse destinée à un autre.
 *
 * Toutes les réponses de TMDB sont publiques et sans utilisateur : il n'existe
 * pas d'appel qu'il faudrait exclure.
 * @param {string} path TMDB endpoint path.
 * @param {Record<string, string>} query Query parameters.
 * @param {TMDBContext} ctx Jeton et langue de la requête en cours.
 * @return {Promise<Record<string, unknown>>} Decoded JSON payload.
 */
async function tmdbGET(
    path: string,
    query: Record<string, string>,
    ctx: TMDBContext,
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({language: ctx.language, ...query});
  const url = `${TMDB_BASE}${path}?${params.toString()}`;

  // Le jeton ne fait pas partie de la clé : il est le même pour tout le monde,
  // et l'y mettre n'aurait fait que dupliquer chaque entrée à sa rotation.
  return cached(url, cacheTTLFor(path), async () => {
    const tmdbRes = await fetch(url, {
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        Accept: 'application/json',
      },
    });

    if (!tmdbRes.ok) {
      const details = await tmdbRes.text();
      throw new TMDBRequestError(tmdbRes.status, details);
    }

    return await tmdbRes.json() as Record<string, unknown>;
  });
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

/* ===================================================================== *
 *  App Check : distinguer notre application d'un client fabriqué
 * ===================================================================== */

/**
 * Le degré d'exigence sur l'attestation, réglable sans changer le code.
 *
 * Trois valeurs, et l'ordre dans lequel on les traverse est la seule façon
 * sûre d'activer App Check sur une application déjà distribuée :
 *
 * - `off` : rien n'est vérifié.
 * - `monitor` (défaut) : on vérifie et on journalise, mais on laisse passer.
 *   C'est l'état dans lequel il faut déployer, puis observer les journaux
 *   quelques jours.
 * - `enforce` : un jeton absent ou invalide fait un 401.
 *
 * Le défaut est `monitor` et non `enforce` à dessein : un déploiement ne doit
 * jamais pouvoir couper le service à des binaires déjà installés qui n'ont pas
 * encore la version cliente capable d'attester.
 */
const appCheckMode = defineString('APP_CHECK_MODE', {default: 'monitor'});

/**
 * Vérifie l'attestation de l'application appelante.
 *
 * C'est la seule protection qui vaille pour les points d'entrée ouverts : ils
 * n'ont pas d'utilisateur à authentifier, et leur URL est extractible du
 * binaire. L'authentification Firebase ne les couvrirait pas davantage, un
 * compte étant gratuit et illimité à créer.
 * @param {Request} req Requête entrante.
 * @param {Response} res Réponse, pour le refus en mode `enforce`.
 * @return {Promise<boolean>} Faux quand la requête a déjà reçu son refus.
 */
async function passesAppCheck(
    req: Request, res: Response,
): Promise<boolean> {
  const mode = appCheckMode.value();
  if (mode === 'off') return true;

  const token = req.header('X-Firebase-AppCheck') ?? '';
  if (!token) {
    if (mode !== 'enforce') {
      logger.warn('app check: jeton absent', {path: req.path});
      return true;
    }
    res.status(401).json({error: 'missing_app_check'});
    return false;
  }

  try {
    await getAdmin().appCheck().verifyToken(token);
    return true;
  } catch (error) {
    if (mode !== 'enforce') {
      logger.warn('app check: jeton refusé', {path: req.path, error});
      return true;
    }
    res.status(401).json({error: 'invalid_app_check'});
    return false;
  }
}

/* ===================================================================== *
 *  Le cache TMDB : ce qui est identique pour tout le monde
 * ===================================================================== */

/**
 * Un cache en mémoire d'instance, volontairement sans stockage partagé.
 *
 * Les instances Cloud Run restent chaudes plusieurs minutes sous charge, ce
 * qui suffit largement pour ce qu'on met dedans : des réponses TMDB qui ne
 * dépendent d'aucun utilisateur et changent au mieux une fois par jour. Un
 * cache partagé (Redis, Firestore) coûterait une dépendance et un aller-retour
 * réseau pour économiser un aller-retour réseau.
 *
 * On stocke la *promesse* et non la valeur : deux requêtes simultanées sur la
 * même clé partagent alors un seul appel TMDB au lieu d'en lancer deux. C'est
 * exactement le cas de l'enrichissement, qui part à soixante requêtes de
 * front, et de l'accueil, que tout le monde ouvre en même temps.
 */
interface CacheEntry {
  expiresAt: number;
  value: Promise<unknown>;
}

const tmdbCache = new Map<string, CacheEntry>();

/**
 * Au-delà, on évince la plus ancienne entrée insérée.
 *
 * Le chiffre borne la mémoire, et c'est le seul réglage à surveiller ici : une
 * réponse de liste pèse quelques dizaines de kilo-octets, une fiche détaillée
 * environ le double. Trois cents entrées représentent donc de l'ordre de 15 à
 * 20 Mo par instance, un coût fixe qui ne dépend pas du trafic — à la
 * différence de la mémoire consommée par les requêtes en vol.
 */
const TMDB_CACHE_MAX_ENTRIES = 300;

/** Genres, plateformes, sagas : des tables de référence, stables. */
const CACHE_TTL_REFERENCE = 24 * 3600 * 1000;
/** Le voisinage d'un film : TMDB le recalcule lentement. */
const CACHE_TTL_NEIGHBORS = 12 * 3600 * 1000;
/** Listes et fiches : réévaluées dans la journée. */
const CACHE_TTL_LISTING = 6 * 3600 * 1000;

/**
 * Combien de temps retenir la réponse d'un chemin TMDB.
 *
 * Le classement suit une seule question : au bout de combien de temps la
 * réponse cesse-t-elle d'être vraie ? Le nombre de parties d'une saga ne bouge
 * pas d'une année sur l'autre ; les tendances de la semaine, si, mais pas dans
 * l'heure.
 * @param {string} path Chemin TMDB appelé.
 * @return {number} Durée de validité en millisecondes.
 */
function cacheTTLFor(path: string): number {
  if (path.startsWith('/genre/') || path.startsWith('/watch/providers') ||
      path.startsWith('/collection/')) {
    return CACHE_TTL_REFERENCE;
  }
  if (path.includes('/recommendations') || path.includes('/similar')) {
    return CACHE_TTL_NEIGHBORS;
  }
  return CACHE_TTL_LISTING;
}

/**
 * Sert une valeur depuis le cache, ou la charge et la retient.
 *
 * Un échec n'est jamais mis en cache : l'entrée est retirée dès que la
 * promesse est rejetée, pour que l'appel suivant retente au lieu de servir
 * l'erreur pendant six heures.
 * @param {string} key Clé de cache. Doit porter tout ce qui fait varier la
 *   réponse, la langue en premier lieu.
 * @param {number} ttlMillis Durée de validité.
 * @param {function(): Promise<T>} load Comment obtenir la valeur.
 * @return {Promise<T>} La valeur, fraîche ou retenue.
 */
async function cached<T>(
    key: string, ttlMillis: number, load: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = tmdbCache.get(key);
  if (hit && hit.expiresAt > now) return hit.value as Promise<T>;

  const value = load();
  // Le `catch` est posé tout de suite, et non au moment de la lecture : sans
  // lui, un rejet sur une entrée que personne n'attend encore remonterait en
  // « unhandled rejection » et tuerait le processus.
  value.catch(() => {
    if (tmdbCache.get(key)?.value === value) tmdbCache.delete(key);
  });

  // `Map` conserve l'ordre d'insertion : la première clé est la plus ancienne.
  if (!tmdbCache.has(key) && tmdbCache.size >= TMDB_CACHE_MAX_ENTRIES) {
    const oldest = tmdbCache.keys().next();
    if (!oldest.done) tmdbCache.delete(oldest.value);
  }
  tmdbCache.set(key, {expiresAt: now + ttlMillis, value});
  return value;
}

export const getPopularMovies = onRequest(
    {secrets: [tmdbApiKey], invoker: 'public'},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'GET') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }

        if (!await passesAppCheck(req, res)) return;

        const page = parsePage(req.query.page);
        const genreID = parseOptionalInt(req.query.genreId);
        const providerIDs = parseProviderIDs(req.query.providerIds);
        const watchRegion = String(req.query.watchRegion ?? DEFAULT_REGION);

        const useDiscover = genreID !== null || providerIDs.length > 0;
        const path = useDiscover ? '/discover/movie' : '/movie/popular';

        const query: Record<string, string> = {
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

        const data = await tmdbGET(path, query, tmdb(req, res));

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

        if (!await passesAppCheck(req, res)) return;

        const idRaw = Number(req.query.id);
        if (!Number.isFinite(idRaw) || idRaw <= 0) {
          res.status(400).json({error: 'invalid_id'});
          return;
        }

        const id = Math.floor(idRaw);
        // Seul appel qui n'emprunte pas `tmdbGET` : la lecture qui suit est
        // écrite contre le JSON brut. La langue, elle, ne peut plus être
        // gravée dans l'URL — c'est la requête entrante qui la porte.
        const language = requestedLanguage(req, res);
        const url =
          `https://api.themoviedb.org/3/movie/${id}` +
          `?language=${encodeURIComponent(language)}` +
          '&append_to_response=credits,videos,watch%2Fproviders';

        // La fiche d'un film ouverte par quelqu'un le sera par d'autres :
        // c'est la page la plus partagée de l'app. L'erreur est levée plutôt
        // que renvoyée sur place, pour qu'un échec ne soit jamais mis en cache.
        // Le seul appel qui garde son enveloppe explicite, faute de passer par
        // `tmdbGET`. La clé reste l'URL, comme partout ailleurs.
        const data = await cached(
            url, CACHE_TTL_LISTING,
            async () => {
              const tmdbRes = await fetch(url, {
                headers: {
                  Authorization: `Bearer ${tmdbApiKey.value()}`,
                  Accept: 'application/json',
                },
              });
              if (!tmdbRes.ok) {
                throw new TMDBRequestError(
                    tmdbRes.status, await tmdbRes.text(),
                );
              }
              return await tmdbRes.json();
            },
        );

        const videos = Array.isArray(data.videos?.results) ?
          data.videos.results : [];
        const trailer = videos.find(
            (v: {type?: string; site?: string}) =>
              v.type === 'Trailer' && v.site === 'YouTube'
        ) ?? videos.find((v: {site?: string}) => v.site === 'YouTube');
        const trailerKey: string | null =
          (trailer as {key?: string})?.key ?? null;

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
            profile_path:
              typeof c.profile_path === 'string' ? c.profile_path : null,
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
                {}, tmdb(req, res));
            if (Array.isArray(parts.parts)) {
              collectionCount = parts.parts.length;
            }
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
        if (sendTMDBError(error, res)) return;
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

        if (!await passesAppCheck(req, res)) return;

        const data = await tmdbGET('/genre/movie/list', {}, tmdb(req, res));

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

        if (!await passesAppCheck(req, res)) return;

        const watchRegion = String(req.query.watchRegion ?? DEFAULT_REGION);
        const data = await tmdbGET('/watch/providers/movie', {
          watch_region: watchRegion,
        }, tmdb(req, res));

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
   * badges « Signature » et « L'Intégrale » ; absents ailleurs, sans
   * gravité. */
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

        const uid = await verifyAuth(req, res);
        if (!uid) return;

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

/** Genres TMDB associés à chaque ambiance (Q4), pour le score, pas le
 * filtre. */
const MOOD_GENRES: Record<string, number[]> = {
  lightFun: [35],
  intense: [28, 53],
  emotional: [18, 10749],
  scary: [27, 53],
  escapist: [12, 14, 878, 28],
  thoughtful: [9648, 878, 18],
};

/**
 * Les noms de genres affichés dans les « raisons » d'une recommandation.
 *
 * Ils ne viennent pas de TMDB — ils sont écrits ici parce que la raison se
 * compose côté serveur, sans second appel réseau. Ils suivent donc la langue
 * de la requête comme le reste, table par table.
 */
const GENRE_LABELS: Record<string, Record<number, string>> = {
  'en-US': {
    28: 'Action',
    12: 'Adventure',
    16: 'Animation',
    35: 'Comedy',
    80: 'Crime',
    99: 'Documentary',
    18: 'Drama',
    10751: 'Family',
    14: 'Fantasy',
    36: 'History',
    27: 'Horror',
    10402: 'Music',
    9648: 'Mystery',
    10749: 'Romance',
    878: 'Science fiction',
    10770: 'TV movie',
    53: 'Thriller',
    10752: 'War',
    37: 'Western',
  },
  'fr-FR': {
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
  },
};

/** Les autres tags de « raison », qui ne dépendent d'aucun genre. */
const REASON_LABELS: Record<string, Record<string, string>> = {
  'en-US': {
    short: 'Under 1h35',
    long: '2h +',
    wellRated: 'Well rated',
    onYourPlatform: 'On your platform',
    fallback: 'CinéMatch pick',
    otherGenres: 'Other',
  },
  'fr-FR': {
    short: '< 1h35',
    long: '2h +',
    wellRated: 'Bien noté',
    onYourPlatform: 'Disponible sur votre plateforme',
    fallback: 'Sélection CinéMatch',
    otherGenres: 'Autres',
  },
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
  /** Les pays d'origine demandés — slugs du client, jamais des codes ISO. */
  originCountries: string[];
  surpriseIntensity: number;
  preferredGenreIds: number[];
  avoidedGenreIds: number[];
  /** Les réponses de goût durable. Elles ne pèsent pas dans le score du soir —
   * la croyance envoyée par le client les porte déjà — mais elles doivent
   * atteindre l'historique pour nourrir le trait d'une séance à l'autre. */
  cognitiveMode: string | null;
  storyOrigin: string | null;
  attachment: string | null;
  creditsMoment: string | null;
  lastingTrace: string | null;
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
  /** Budget TMDB en dollars, 0 ou null quand la fiche ne le renseigne pas.
   * Sert uniquement à situer l'échelle (intime ↔ épique). */
  budget: number | null;
  /** Noms des mots-clés TMDB, seule source exploitable pour le ton. Renseignés
   * par l'enrichissement seul : à la finalisation, ils ont déjà produit leur
   * effet dans les axes, qui voyagent avec le candidat. */
  keywordNames?: string[];
  /** Position du film dans l'espace commun, et incertitude sur cette position.
   * Renseignées seulement à la finalisation, où le client les renvoie. */
  axes?: AxisVector;
  axisSigma?: AxisVector;
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
    Array.isArray(v) ?
      v.filter((x): x is number => typeof x === 'number') : [];
  const numOrDefault = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ?
      Math.max(0, Math.min(1, v)) : fallback;

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
    originCountries: strArray(b.originCountries),
    surpriseIntensity: numOrDefault(b.surpriseIntensity, 0.5),
    preferredGenreIds: numArray(b.preferredGenreIds),
    avoidedGenreIds: numArray(b.avoidedGenreIds),
    cognitiveMode: strOrNull(b.cognitiveMode),
    storyOrigin: strOrNull(b.storyOrigin),
    attachment: strOrNull(b.attachment),
    creditsMoment: strOrNull(b.creditsMoment),
    lastingTrace: strOrNull(b.lastingTrace),
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

/** Le code ISO 3166-1 derrière chaque origine nommée par le client. */
const ORIGIN_COUNTRY_CODES: Record<string, string> = {
  france: 'FR',
  unitedKingdom: 'GB',
  unitedStates: 'US',
  japan: 'JP',
};

/** Le slug qui ne désigne pas un pays mais tous les autres. */
const ORIGIN_ELSEWHERE = 'elsewhere';

/**
 * Les quatre pays nommés. « Ailleurs », c'est tout ce qui n'est pas là-dedans.
 */
const NAMED_ORIGIN_CODES = Object.values(ORIGIN_COUNTRY_CODES);

/**
 * Les pays interrogés quand « Autre » est demandé.
 *
 * TMDB ne sait pas exprimer « tous les pays sauf ceux-là » : il n'existe pas de
 * `without_origin_country`. Interroger sans contrainte remplirait le vivier de
 * films américains qu'on jetterait ensuite. On amorce donc avec les grandes
 * cinématographies hors des quatre nommées — l'exactitude, elle, ne dépend pas
 * de cette liste : `matchesRequestedOrigins` accepte n'importe quel pays non
 * nommé, y compris ceux qui manquent ici.
 */
const ELSEWHERE_SEED_CODES = [
  'KR', 'IN', 'IT', 'ES', 'DE', 'CN', 'HK', 'TW', 'CA', 'AU',
  'SE', 'DK', 'NO', 'BE', 'NL', 'BR', 'MX', 'AR', 'RU', 'PL',
  'IR', 'TH', 'TR', 'IE', 'NZ',
];

/**
 * Les codes pays à passer à TMDB, ou une liste vide quand rien n'est demandé.
 * @param {QuestionnaireAnswersPayload} answers Réponses au questionnaire.
 * @return {string[]} Codes ISO à interroger.
 */
function discoverOriginCodes(answers: QuestionnaireAnswersPayload): string[] {
  const slugs = answers.originCountries;
  if (slugs.length === 0) return [];
  const codes = new Set<string>();
  for (const slug of slugs) {
    const code = ORIGIN_COUNTRY_CODES[slug];
    if (code) codes.add(code);
  }
  if (slugs.includes(ORIGIN_ELSEWHERE)) {
    for (const code of ELSEWHERE_SEED_CODES) codes.add(code);
  }
  return Array.from(codes);
}

/**
 * L'origine demandée est un filtre dur, jamais assouplie.
 *
 * Même raisonnement que pour le genre : la requête cadre, ce filtre garantit.
 * Il porte en plus la seule chose que la requête ne sait pas dire — « un pays
 * qui n'est aucun des quatre nommés ».
 *
 * Un film dont le pays n'est pas renseigné passe. C'est délibéré et vérifié :
 * les endpoints de liste de TMDB ne renvoient pas `origin_country` du tout, si
 * bien qu'un filtre strict rejetterait l'intégralité du vivier. Le tri par pays
 * est fait par la requête elle-même (`with_origin_country`), que TMDB accepte
 * en paramètre même s'il ne réémet pas le champ ; ce filtre-ci garantit ce que
 * la requête ne sait pas dire, sur des candidats enrichis qui, eux, portent
 * l'information.
 *
 * @param {string[] | undefined} originCountry Pays du film, codes ISO.
 * @param {QuestionnaireAnswersPayload} answers Réponses au questionnaire.
 * @return {boolean} Vrai si le film vient d'une origine demandée.
 */
function matchesRequestedOrigins(
    originCountry: string[] | undefined,
    answers: QuestionnaireAnswersPayload,
): boolean {
  const slugs = answers.originCountries;
  if (slugs.length === 0) return true;

  const origins = originCountry ?? [];
  if (origins.length === 0) return true;

  const wanted = new Set(
      slugs.map((slug) => ORIGIN_COUNTRY_CODES[slug]).filter(Boolean),
  );
  if (origins.some((code) => wanted.has(code))) return true;

  return slugs.includes(ORIGIN_ELSEWHERE) &&
    origins.some((code) => !NAMED_ORIGIN_CODES.includes(code));
}

/**
 * Le genre demandé est un filtre dur, jamais assoupli.
 *
 * `with_genres` le fait déjà appliquer par TMDB à la requête, mais la garantie
 * ne peut pas reposer sur ça seul : le vivier traverse le client, revient à la
 * finalisation, et rien n'oblige ce qui revient à être ce qui était parti. Le
 * filtre est donc réappliqué au dernier moment, là où le trio se décide.
 *
 * Aucun genre choisi vaut « ouvert à tout » — la question est facultative — et
 * ne filtre alors rien du tout.
 *
 * @param {number[] | undefined} genreIds Genres TMDB du film.
 * @param {QuestionnaireAnswersPayload} answers Réponses au questionnaire.
 * @return {boolean} Vrai si le film relève d'au moins un genre demandé.
 */
function matchesRequestedGenres(
    genreIds: number[] | undefined, answers: QuestionnaireAnswersPayload,
): boolean {
  const wanted = genreIdsFor(answers.genres);
  if (wanted.length === 0) return true;
  return (genreIds ?? []).some((id) => wanted.includes(id));
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
    'include_adult': 'false',
    'include_video': 'false',
    'vote_count.gte': '20',
  };

  const genreIds = genreIdsFor(answers.genres);
  if (genreIds.length > 0) {
    query.with_genres = genreIds.join('|');
  }

  const originCodes = discoverOriginCodes(answers);
  if (originCodes.length > 0) {
    query.with_origin_country = originCodes.join('|');
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
 * @param {TMDBContext} ctx Jeton et langue de la requête en cours.
 * @return {Promise<DiscoverRow[]>} Deduplicated candidate rows.
 */
async function fetchCandidatePool(
    answers: QuestionnaireAnswersPayload,
    relax: {dealbreaker: boolean; platforms: boolean},
    ctx: TMDBContext,
): Promise<DiscoverRow[]> {
  const base = baseDiscoverParams(answers, relax);
  const sorts = [
    'popularity.desc', 'vote_average.desc', 'primary_release_date.desc',
  ];
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
      requests.push(tmdbGET('/discover/movie', query, ctx));
    }
  }

  // Il y avait ici une tranche qui retirait `with_genres` pour élargir le
  // vivier au-delà des genres demandés. Elle se justifiait quand les genres
  // étaient *déduits* d'un trajet d'humeur : une déduction fausse enfermait la
  // recherche sans recours. Les genres sont maintenant choisis explicitement,
  // et un choix explicite ne se contourne pas — élargir au-delà reviendrait à
  // proposer autre chose que ce qui a été demandé.

  // La tranche basse notoriété : bien notés mais peu vus. Sans elle, un vivier
  // trié par popularité rend « familiarité : inconnu » structurellement
  // insatisfiable — le film « confidentiel » du lot resterait un film connu.
  for (let page = 1; page <= pagesPerSort; page++) {
    requests.push(tmdbGET('/discover/movie', {
      ...base,
      'sort_by': 'vote_average.desc',
      'vote_count.gte': '100',
      'vote_count.lte': '2000',
      'page': String(page),
    }, ctx));
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
 * (`preferredGenreIds`/`avoidedGenreIds`, alimentées par
 * `PairwiseComparisonView` côté client) plutôt qu'un critère séparé.
 * Poids : 30.
 * @param {number[]} genreIds Genres TMDB du film.
 * @param {string | null} mood Ambiance choisie.
 * @param {number[]} preferredGenreIds Genres des films choisis en
 *   comparaison directe.
 * @param {number[]} avoidedGenreIds Genres des films écartés en comparaison
 *   directe.
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
      return (voteCount ?? 0) >= 20 ?
        0.7 * quality + 0.3 * (1 - popNorm) : quality * 0.5;
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
function originScore(
    originCountry: string[] | undefined, origin: string,
): number {
  if (origin === 'any' || !originCountry || originCountry.length === 0) {
    return 0.5;
  }
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
      return genreIds.includes(GENRE_DOCUMENTARY) ||
        genreIds.includes(GENRE_HISTORY) ? 1 : 0.2;
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
function runtimeScore(
    runtimeMinutes: number | null, preference: string,
): number {
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
  const avg =
    castPopularities.reduce((a, b) => a + b, 0) / castPopularities.length;
  const norm = Math.max(0, Math.min(1, avg / 20));
  return preference === 'familiarFaces' ? norm : 1 - norm;
}

/**
 * Curseur "intensité de surprise" (question adaptative indépendante de
 * `mindset`) — ajuste `mindsetSub` autour de sa valeur neutre. Le curseur au
 * centre (0.5, valeur par défaut si jamais posée) laisse `base` inchangé —
 * comportement identique à avant l'introduction du curseur. Plus l'intensité
 * voulue est haute, plus la pénalité franchise se creuse ; en dessous de 0.5,
 * elle s'adoucit. Effet modeste (±0.15 maxi) car secondaire à `mindset`, la
 * source de vérité.
 * @param {number} base Sous-score état d'esprit avant ajustement.
 * @param {boolean} belongsToCollection Si le film appartient à une
 *   franchise/collection.
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
        c.genre_ids ?? [], answers.mood,
        answers.preferredGenreIds, answers.avoidedGenreIds,
    ) +
    0.15 * mindsetSub +
    0.15 * qualityScore(
        c.vote_average ?? null, c.vote_count ?? null,
        c.popularity ?? null, answers.popularity,
    ) +
    0.10 * originScore(c.origin_country, answers.origin) +
    0.10 * castScore(c.castPopularities, answers.cast) +
    0.10 * eraScore(c.release_date, answers.era, c.vote_count ?? null) +
    0.10 * runtimeScore(c.runtimeMinutes, answers.runtime);

  return Math.round(weighted * 100);
}

/* ===================================================================== *
 *  L'espace commun : où se situe un film, et à quel point on en est sûr
 * ===================================================================== */

/** Les huit axes. L'ordre est celui de la spec, il ne sert qu'à itérer. */
const AXIS_KEYS = ['ch', 'ry', 'fa', 'de', 'an', 'to', 'ec', 'in'] as const;
type AxisKey = typeof AXIS_KEYS[number];
type AxisVector = Record<AxisKey, number>;

/**
 * Poids par genre TMDB pour chaque axe, sur −1..+1. Un film prend la moyenne
 * des poids de ses genres présents dans la table (0 s'il n'en a aucun) : la
 * moyenne, et non la somme, pour qu'un film à quatre genres ne sature pas
 * mécaniquement l'axe.
 *
 * `fa` et `in` n'y figurent pas — le genre ne dit rien de la notoriété ni de la
 * durée, qui se mesurent ailleurs.
 */
const GENRE_AXIS_WEIGHTS: Record<
  Exclude<AxisKey, 'fa' | 'in'>, Record<number, number>
> = {
  // Charge : léger ↔ éprouvant.
  ch: {
    10752: 0.9, 36: 0.6, 18: 0.6, 27: 0.5, 80: 0.4, 53: 0.3, 99: 0.2,
    37: 0.2, 9648: 0.1, 10749: 0, 28: -0.1, 878: -0.1, 14: -0.3, 12: -0.3,
    10402: -0.3, 16: -0.5, 35: -0.7, 10751: -0.8,
  },
  // Rythme : contemplatif ↔ haletant.
  ry: {
    28: 0.8, 53: 0.7, 12: 0.6, 27: 0.4, 80: 0.3, 37: 0.2, 878: 0.1, 14: 0.1,
    35: 0.1, 16: 0, 10751: 0, 9648: -0.1, 10402: -0.2, 10749: -0.3,
    36: -0.5, 18: -0.5, 99: -0.7,
  },
  // Densité : limpide ↔ exigeant.
  de: {
    99: 0.7, 9648: 0.6, 36: 0.5, 18: 0.4, 878: 0.4, 10752: 0.3, 80: 0.2,
    53: 0.1, 37: 0, 10749: -0.2, 14: -0.2, 10402: -0.2, 12: -0.4, 16: -0.4,
    28: -0.5, 35: -0.6, 10751: -0.7,
  },
  // Ancrage : réel ↔ imaginaire.
  an: {
    14: 0.9, 878: 0.9, 16: 0.7, 12: 0.4, 27: 0.3, 28: 0.2, 10402: 0, 35: 0,
    9648: 0, 53: -0.1, 10749: -0.2, 80: -0.3, 37: -0.4, 18: -0.5,
    10752: -0.6, 36: -0.8, 99: -0.9,
  },
  // Ton : distancié ↔ chaleureux. L'axe le plus pauvre — les genres n'en
  // disent presque rien, et c'est pourquoi son incertitude reste élevée.
  to: {
    10751: 0.7, 16: 0.5, 10402: 0.4, 10749: 0.4, 35: 0.3, 12: 0.2, 14: 0.2,
    18: 0, 99: -0.1, 9648: -0.2, 878: -0.2, 28: -0.2, 37: -0.2, 80: -0.5,
    53: -0.5, 10752: -0.6, 27: -0.7,
  },
  // Échelle : intime ↔ épique.
  ec: {
    12: 0.8, 28: 0.7, 878: 0.7, 14: 0.7, 10752: 0.6, 37: 0.3, 36: 0.3,
    16: 0.2, 53: 0, 80: -0.1, 10751: -0.1, 27: -0.2, 35: -0.2, 9648: -0.2,
    10402: -0.3, 99: -0.4, 18: -0.5, 10749: -0.6,
  },
};

/**
 * L'incertitude d'estimation avant enrichissement, par axe. Ces valeurs disent
 * ce que les champs de liste TMDB permettent honnêtement d'affirmer : l'ancrage
 * se lit presque directement dans les genres, le ton ne s'y lit quasiment pas,
 * et la durée ne s'y lit pas du tout.
 */
const COARSE_SIGMA: AxisVector = {
  ch: 0.45, ry: 0.45, fa: 0.30, de: 0.50,
  an: 0.30, to: 0.85, ec: 0.55, in: 1.0,
};

/** L'incertitude une fois le détail du film récupéré. */
const ENRICHED_SIGMA: Partial<AxisVector> = {
  in: 0.20, fa: 0.22, ec: 0.35, ry: 0.40, de: 0.45,
};

/**
 * Lexique de ton, appliqué aux **noms** de mots-clés que TMDB renvoie.
 *
 * On travaille sur les libellés et non sur des identifiants : les identifiants
 * de mots-clés TMDB existent, mais les inventer de mémoire produirait des
 * tables fausses et silencieusement inefficaces. Les noms, eux, arrivent dans
 * la réponse et se lisent tels quels.
 *
 * Couverture inégale et assumée — beaucoup de films n'ont aucun de ces
 * mots-clés. C'est pourquoi l'incertitude du ton ne se resserre que lorsqu'un
 * mot est effectivement reconnu : sans correspondance, on en reste à ce que
 * disent les genres, c'est-à-dire pas grand-chose.
 */
const TONE_KEYWORDS: Record<string, number> = {
  'feel good': 0.9, 'friendship': 0.6, 'family relationships': 0.6,
  'coming of age': 0.5, 'love': 0.5, 'hope': 0.7, 'christmas': 0.6,
  'redemption': 0.5, 'heartwarming': 0.9, 'tenderness': 0.8,
  'nihilism': -0.9, 'cynicism': -0.8, 'black comedy': -0.6, 'satire': -0.5,
  'dystopia': -0.6, 'brutality': -0.8, 'revenge': -0.6, 'bleak': -0.8,
  'cruelty': -0.9, 'despair': -0.8, 'paranoia': -0.6, 'betrayal': -0.5,
};

/**
 * La position de ton lue dans les mots-clés, ou `null` si aucun n'est reconnu.
 * @param {string[]} names Noms de mots-clés renvoyés par TMDB.
 * @return {number | null} Position −1..+1, ou null.
 */
function toneFromKeywords(names: string[]): number | null {
  const hits = names
      .map((name) => TONE_KEYWORDS[name.toLowerCase()])
      .filter((value): value is number => typeof value === 'number');
  if (hits.length === 0) return null;
  const sum = hits.reduce((acc, value) => acc + value, 0);
  return Math.max(-1, Math.min(1, sum / hits.length));
}

/** Distribution du vivier, pour situer un film *parmi les autres*. */
interface PoolStats {
  popularities: number[];
  voteCounts: number[];
}

/**
 * Rang normalisé d'une valeur dans une distribution triée (0 = plus petit).
 * @param {number} value Valeur à situer.
 * @param {number[]} sorted Distribution triée croissante.
 * @return {number} Position entre 0 et 1.
 */
function percentileRank(value: number, sorted: number[]): number {
  if (sorted.length <= 1) return 0.5;
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low / (sorted.length - 1);
}

/**
 * Prépare les distributions du vivier une fois pour toutes.
 * @param {DiscoverRow[]} rows Le vivier complet.
 * @return {PoolStats} Distributions triées.
 */
function poolStatsFor(rows: DiscoverRow[]): PoolStats {
  return {
    popularities: rows.map((r) => r.popularity ?? 0).sort((a, b) => a - b),
    voteCounts: rows.map((r) => r.vote_count ?? 0).sort((a, b) => a - b),
  };
}

/**
 * Moyenne des poids de genre d'un film sur un axe donné.
 * @param {number[]} genreIds Genres TMDB du film.
 * @param {Record<number, number>} table Table de poids de l'axe.
 * @return {number} Position sur l'axe, −1..+1.
 */
function genreAxisValue(
    genreIds: number[], table: Record<number, number>,
): number {
  const known = genreIds.filter((id) => table[id] !== undefined);
  if (known.length === 0) return 0;
  const sum = known.reduce((acc, id) => acc + table[id], 0);
  return Math.max(-1, Math.min(1, sum / known.length));
}

/**
 * Positionne un film sur les huit axes à partir des seuls champs de liste.
 *
 * `fa` est la seule mesure vraiment solide de cette étape : elle repose sur des
 * nombres (popularité, votes) et non sur une lecture des genres. `in` est
 * laissé à zéro, avec une incertitude maximale — la durée n'existe pas avant
 * l'appel de détail, et prétendre l'estimer fausserait le classement au lieu de
 * l'aider.
 *
 * @param {DiscoverRow} row Le film.
 * @param {PoolStats} stats Distributions du vivier.
 * @return {AxisVector} Position sur les huit axes.
 */
function coarseAxesFor(row: DiscoverRow, stats: PoolStats): AxisVector {
  const genreIds = row.genre_ids ?? [];

  // Notoriété : 0 = inconnu de tous, 1 = en tête du vivier.
  const reach =
    0.6 * percentileRank(row.popularity ?? 0, stats.popularities) +
    0.4 * percentileRank(row.vote_count ?? 0, stats.voteCounts);
  const origins = row.origin_country ?? [];
  const isFamiliarOrigin = origins.length === 0 ||
    origins.some((c) => c === 'FR' || c === 'US' || c === 'GB');

  const familiarity = 1 - 2 * reach + (isFamiliarOrigin ? 0 : 0.15);

  return {
    ch: genreAxisValue(genreIds, GENRE_AXIS_WEIGHTS.ch),
    ry: genreAxisValue(genreIds, GENRE_AXIS_WEIGHTS.ry),
    fa: Math.max(-1, Math.min(1, familiarity)),
    de: genreAxisValue(genreIds, GENRE_AXIS_WEIGHTS.de),
    an: genreAxisValue(genreIds, GENRE_AXIS_WEIGHTS.an),
    to: genreAxisValue(genreIds, GENRE_AXIS_WEIGHTS.to),
    ec: genreAxisValue(genreIds, GENRE_AXIS_WEIGHTS.ec),
    in: 0,
  };
}

/**
 * Resserre les axes que seul le détail du film permet de mesurer.
 *
 * Ne recalcule jamais `fa` depuis zéro : sa part « notoriété » a été établie
 * sur la distribution du vivier complet, que cette étape n'a plus sous la main.
 * On se contente d'y ajouter ce que le détail apprend — l'appartenance à une
 * saga, qui rend un film plus familier qu'un inédit à notoriété égale.
 *
 * @param {AxisVector} base Axes grossiers.
 * @param {EnrichedCandidate} c Candidat enrichi.
 * @return {AxisVector} Axes resserrés.
 */
function refineAxes(base: AxisVector, c: EnrichedCandidate): AxisVector {
  const axes: AxisVector = {...base};
  const runtime = c.runtimeMinutes;

  if (typeof runtime === 'number' && runtime > 0) {
    // 90 min → −1, 150 min → +1, linéaire entre les deux.
    axes.in = Math.max(-1, Math.min(1, (runtime - 120) / 30));
    // Un film long est rarement pressé, un film court rarement contemplatif.
    axes.ry = Math.max(-1, Math.min(1, axes.ry - (runtime - 110) / 160));
    axes.de = Math.max(-1, Math.min(1, axes.de + (runtime - 110) / 220));
  }

  if (c.belongsToCollection) {
    axes.fa = Math.max(-1, axes.fa - 0.35);
  }

  if (typeof c.budget === 'number' && c.budget > 0) {
    // 5 M$ → intime, 150 M$ → épique ; échelle logarithmique, les budgets
    // s'étalant sur trois ordres de grandeur.
    const logScale = (Math.log10(c.budget) - 6.7) / 1.5;
    axes.ec = Math.max(-1, Math.min(1, 0.4 * axes.ec + 0.6 * logScale));
  }

  // Le ton : les mots-clés priment nettement sur les genres, qui n'en disent
  // presque rien — une comédie peut être tendre ou glaçante.
  const tone = toneFromKeywords(c.keywordNames ?? []);
  if (tone !== null) {
    axes.to = Math.max(-1, Math.min(1, 0.25 * axes.to + 0.75 * tone));
  }

  return axes;
}

/**
 * L'incertitude associée à un jeu d'axes, selon qu'ils sont enrichis ou non.
 * @param {boolean} enriched Si le détail du film est connu.
 * @param {EnrichedCandidate | null} c Candidat, pour les champs manquants.
 * @return {AxisVector} Écart-type par axe.
 */
function axisSigmaFor(
    enriched: boolean, c: EnrichedCandidate | null,
): AxisVector {
  if (!enriched) return {...COARSE_SIGMA};
  const sigma: AxisVector = {...COARSE_SIGMA, ...ENRICHED_SIGMA};
  // L'enrichissement ne garantit pas que TMDB avait la donnée : sans durée ni
  // budget, l'axe correspondant redevient aussi incertain qu'avant.
  if (!c || typeof c.runtimeMinutes !== 'number') sigma.in = COARSE_SIGMA.in;
  if (!c || typeof c.budget !== 'number' || c.budget <= 0) {
    sigma.ec = COARSE_SIGMA.ec;
  }
  // Le ton ne se resserre que si un mot-clé du lexique a répondu. Sans quoi il
  // reste l'axe le plus incertain du modèle, et doit peser en conséquence.
  if (c && toneFromKeywords(c.keywordNames ?? []) !== null) {
    sigma.to = 0.45;
  }
  return sigma;
}

/** Le vecteur de croyance envoyé par le client. */
interface BeliefPayload {
  mu: AxisVector;
  sigma: AxisVector;
  weight: AxisVector;
}

/**
 * Relit un jeu d'axes renvoyé par le client. Les axes ne sont jamais recalculés
 * à partir d'un sous-ensemble : la part « notoriété » de `fa` a été établie sur
 * la distribution du vivier complet, qu'on n'a plus ici. Un axe absent retombe
 * à 0, ce qui le neutralise sans fausser les autres.
 * @param {unknown} raw Bloc `axes` d'un candidat.
 * @return {AxisVector} Axes normalisés.
 */
function parseAxes(raw: unknown): AxisVector {
  const out = {} as AxisVector;
  const record = (typeof raw === 'object' && raw !== null) ?
    raw as Record<string, unknown> : {};
  for (const axis of AXIS_KEYS) {
    const value = record[axis];
    out[axis] = typeof value === 'number' && Number.isFinite(value) ?
      Math.max(-1, Math.min(1, value)) : 0;
  }
  return out;
}

/**
 * Relit un jeu d'incertitudes. Distinct de `parseAxes` sur deux points qui
 * comptent : le repli vaut 1 et non 0 — une incertitude manquante veut dire
 * « on ne sait pas », pas « on sait parfaitement » — et la borne basse est
 * strictement positive, un écart-type nul rendant le score infini.
 * @param {unknown} raw Bloc `axis_sigma` d'un candidat.
 * @return {AxisVector} Écarts-types normalisés.
 */
function parseSigma(raw: unknown): AxisVector {
  const out = {} as AxisVector;
  const record = (typeof raw === 'object' && raw !== null) ?
    raw as Record<string, unknown> : {};
  for (const axis of AXIS_KEYS) {
    const value = record[axis];
    out[axis] = typeof value === 'number' && Number.isFinite(value) ?
      Math.max(0.05, Math.min(2, value)) : 1;
  }
  return out;
}

/**
 * Lit le vecteur de croyance du client, ou `null` s'il est absent/malformé.
 * @param {unknown} raw Bloc `belief` du corps de requête.
 * @return {BeliefPayload | null} Croyance normalisée.
 */
function parseBelief(raw: unknown): BeliefPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const b = raw as Record<string, unknown>;
  const read = (key: string, fallback: number): AxisVector | null => {
    const source = b[key];
    if (typeof source !== 'object' || source === null) return null;
    const record = source as Record<string, unknown>;
    const out = {} as AxisVector;
    for (const axis of AXIS_KEYS) {
      const value = record[axis];
      out[axis] = typeof value === 'number' && Number.isFinite(value) ?
        value : fallback;
    }
    return out;
  };
  const mu = read('mu', 0);
  const sigma = read('sigma', 1);
  const weight = read('weight', 0);
  if (!mu || !sigma || !weight) return null;
  return {mu, sigma, weight};
}

/**
 * Le score d'un film : une proximité tolérante au doute.
 *
 * Un axe dont on ignore la position de la personne (σ grand) *ou* celle du film
 * (s grand) voit son terme s'aplatir et cesse de départager — le modèle ne
 * bluffe jamais sur ce qu'il ne sait pas. Un axe sur lequel rien n'a été
 * exprimé porte un poids nul et ne compte pas du tout.
 *
 * @param {AxisVector} axes Position du film.
 * @param {AxisVector} filmSigma Incertitude sur cette position.
 * @param {BeliefPayload} belief Croyance sur la personne.
 * @return {number} Score 0..100.
 */
function beliefScore(
    axes: AxisVector, filmSigma: AxisVector, belief: BeliefPayload,
): number {
  let weighted = 0;
  let total = 0;
  for (const axis of AXIS_KEYS) {
    const w = Math.max(0, belief.weight[axis]);
    if (w <= 0) continue;
    const spread =
      belief.sigma[axis] * belief.sigma[axis] +
      filmSigma[axis] * filmSigma[axis];
    if (spread <= 0) continue;
    const delta = belief.mu[axis] - axes[axis];
    weighted += w * Math.exp(-(delta * delta) / (2 * spread));
    total += w;
  }
  if (total <= 0) return 50;
  return Math.round((weighted / total) * 100);
}

/* ===================================================================== *
 *  Le trait : ce que la Galerie raconte, une fois traduit en croyance
 * ===================================================================== */

/** Précision de départ d'un axe vierge. Doit valoir celle du client. */
const TRAIT_PRIOR_TAU = 1;
/** Demi-vie d'une observation, en jours. Les goûts bougent ; le profil suit. */
const TRAIT_HALF_LIFE_DAYS = 180;
/**
 * Un film vu : on l'a regardé jusqu'à en témoigner, sans dire qu'on l'a aimé.
 */
const TRAIT_WEIGHT_GALLERY = 0.6;
/**
 * Une intention, pas une expérience — le soi projeté, à croire avec prudence.
 */
const TRAIT_WEIGHT_WATCHLIST = 0.2;
/** La parole de l'utilisateur sur lui-même l'emporte sur toute inférence. */
const TRAIT_WEIGHT_CORRECTION = 2.0;
/** Au-delà, une même journée n'est plus une soirée mais un import. */
const TRAIT_DAILY_CAP = 10;

interface TraitProfile {
  mu: AxisVector;
  tau: AxisVector;
  galleryCount: number;
  watchlistCount: number;
  correctedAxes: AxisKey[];
}

interface TraitEntry {
  genreIds: number[];
  inCollection: boolean;
  addedAtMillis: number;
}

/**
 * Ce qu'un film a laissé, une fois regardé. Le seul signal du système qui porte
 * sur l'expérience vécue et non sur une intention ou une déclaration.
 */
type VerdictValue = 'stayed' | 'passed' | 'unfinished';

interface TraitVerdict {
  axes: AxisVector;
  verdict: VerdictValue;
  atMillis: number;
}

/** La force d'un verdict. « Resté avec moi » est l'indice le plus fort qu'on
 * puisse recueillir — plus qu'une déclaration, plus qu'un film simplement vu.
 * « Il a passé le temps » pèse quasi zéro : la tiédeur n'est pas une
 * préférence, et la faire tirer le profil vers le film transformait chaque
 * soirée moyenne en engrais pour d'autres soirées moyennes. */
const VERDICT_WEIGHT: Record<VerdictValue, number> = {
  stayed: 1.2,
  passed: 0.05,
  unfinished: 0.8,
};

/** Une réponse durable donnée en séance. Déclarative (0,6 côté client) et
 * potentiellement contredite par la soirée suivante — d'où un poids modeste,
 * qui s'accumule si la personne répond pareil de séance en séance. */
const TRAIT_WEIGHT_SESSION_ANSWER = 0.3;
/** Un trio explicitement refusé (« Aucun ne me tente »). */
const TRAIT_WEIGHT_REJECTED_TRIO = 0.3;
/** Un trio jamais lancé, sans refus explicite : le signal le plus ambigu du
 * système — la soirée a pu simplement s'arrêter là. */
const TRAIT_WEIGHT_IGNORED_TRIO = 0.1;
/** Au-delà, un trio resté sans lancement compte comme décliné en silence. */
const IGNORED_TRIO_AFTER_DAYS = 7;

/**
 * Ce que chaque réponse de goût durable dépose dans le trait — le miroir
 * serveur des cibles d'`AnswerObservations` côté iOS, restreint aux dimensions
 * qui parlent du goût et non de la soirée. Les deux tables doivent rester
 * d'accord, sans quoi la séance apprendrait une chose et le trait une autre.
 */
const DURABLE_ANSWER_AXES:
  Record<string, Record<string, [AxisKey, number][]>> = {
    storyOrigin: {
      trueStory: [['an', -0.9], ['ch', 0.3]],
      onlyInCinema: [['an', 0.9]],
    },
    attachment: {
      character: [['ec', -0.8], ['an', -0.4]],
      world: [['ec', 0.8], ['an', 0.6]],
    },
    cognitiveMode: {
      understand: [['de', 0.8], ['to', -0.3]],
      feel: [['de', -0.4], ['to', 0.6]],
    },
    lastingTrace: {
      weight: [['ch', 0.9], ['to', -0.2]],
      smile: [['to', 0.9], ['ch', -0.4]],
      questions: [['de', 0.9], ['fa', 0.4]],
      wantMore: [['fa', -0.6], ['ec', 0.5]],
    },
  };

/** Une séance, telle que l'historique la raconte au trait : ce qui a été
 * déclaré de durable, et ce qu'est devenu le trio proposé. */
interface SessionSignal {
  answers: Record<string, unknown>;
  /** Position moyenne du trio, axes sans donnée omis. */
  trioAxes: Partial<AxisVector>;
  rejected: boolean;
  launched: boolean;
  atMillis: number;
}

/**
 * Positionne un film de la bibliothèque sur les axes que ses seules métadonnées
 * stockées permettent d'établir.
 *
 * Ce qu'on ne prétend pas savoir : la Galerie ne garde ni popularité ni durée.
 * `in` (l'investissement) reste donc entièrement hors de portée, et `fa` ne
 * repose que sur l'appartenance à une saga — un signal réel mais étroit. Ces
 * deux axes-là continueront d'être demandés au questionnaire, ce qui est
 * exactement le comportement voulu : on ne pose que ce qu'on ignore.
 *
 * @param {TraitEntry} entry Une entrée de bibliothèque.
 * @return {Partial<AxisVector>} Position, axes inconnus omis.
 */
function traitAxesFor(entry: TraitEntry): Partial<AxisVector> {
  const genreIds = entry.genreIds;
  const axes: Partial<AxisVector> = {
    ch: genreAxisValue(genreIds, GENRE_AXIS_WEIGHTS.ch),
    ry: genreAxisValue(genreIds, GENRE_AXIS_WEIGHTS.ry),
    de: genreAxisValue(genreIds, GENRE_AXIS_WEIGHTS.de),
    an: genreAxisValue(genreIds, GENRE_AXIS_WEIGHTS.an),
    to: genreAxisValue(genreIds, GENRE_AXIS_WEIGHTS.to),
    ec: genreAxisValue(genreIds, GENRE_AXIS_WEIGHTS.ec),
  };
  if (entry.inCollection) {
    // Une saga est un terrain connu ; l'inverse ne se déduit pas — un film hors
    // saga peut être aussi bien un inédit qu'un classique que tout le monde a
    // vu.
    axes.fa = -0.5;
  }
  return axes;
}

/**
 * Le poids d'une observation, une fois le temps passé dessus.
 * @param {number} base Poids de la source.
 * @param {number} ageDays Ancienneté en jours.
 * @param {number} sameDayCount Nombre d'entrées ajoutées le même jour.
 * @return {number} Poids effectif.
 */
function traitWeight(
    base: number, ageDays: number, sameDayCount: number,
): number {
  const decay = Math.pow(0.5, Math.max(0, ageDays) / TRAIT_HALF_LIFE_DAYS);
  // Vingt films ajoutés le même soir ne sont pas vingt soirées : c'est un
  // import, et sans ce plafond il écraserait deux ans de visionnage réel.
  const burst = Math.min(1, TRAIT_DAILY_CAP / Math.max(1, sameDayCount));
  return base * decay * burst;
}

/**
 * Construit la croyance de trait à partir de la bibliothèque.
 * @param {TraitEntry[]} gallery Films vus.
 * @param {TraitEntry[]} watchlist Films prévus.
 * @param {Partial<AxisVector>} corrections Corrections posées sur la Fiche.
 * @param {TraitVerdict[]} verdicts Ce que les films lancés ont laissé.
 * @param {SessionSignal[]} signals Ce que chaque séance a déclaré et donné.
 * @return {TraitProfile} Le trait.
 */
function buildTraitProfile(
    gallery: TraitEntry[],
    watchlist: TraitEntry[],
    corrections: Partial<AxisVector>,
    verdicts: TraitVerdict[] = [],
    signals: SessionSignal[] = [],
): TraitProfile {
  const mu = {} as AxisVector;
  const tau = {} as AxisVector;
  for (const axis of AXIS_KEYS) {
    mu[axis] = 0;
    tau[axis] = TRAIT_PRIOR_TAU;
  }

  const observe = (axis: AxisKey, target: number, precision: number): void => {
    if (precision <= 0) return;
    const updated = tau[axis] + precision;
    mu[axis] = (tau[axis] * mu[axis] + precision * target) / updated;
    tau[axis] = updated;
  };

  const dayKey = (millis: number): number =>
    Math.floor(millis / (24 * 3600 * 1000));
  const countByDay = new Map<number, number>();
  for (const entry of [...gallery, ...watchlist]) {
    const key = dayKey(entry.addedAtMillis);
    countByDay.set(key, (countByDay.get(key) ?? 0) + 1);
  }

  const now = Date.now();
  const ingest = (entries: TraitEntry[], base: number): void => {
    for (const entry of entries) {
      const ageDays = (now - entry.addedAtMillis) / (24 * 3600 * 1000);
      const sameDay = countByDay.get(dayKey(entry.addedAtMillis)) ?? 1;
      const weight = traitWeight(base, ageDays, sameDay);
      const axes = traitAxesFor(entry);
      for (const axis of AXIS_KEYS) {
        const value = axes[axis];
        if (typeof value === 'number') observe(axis, value, weight);
      }
    }
  };

  ingest(gallery, TRAIT_WEIGHT_GALLERY);
  ingest(watchlist, TRAIT_WEIGHT_WATCHLIST);

  // Les verdicts, ensuite. Ils portent sur des films dont on connaît la
  // position exacte — celle calculée à la finalisation, conservée dans
  // l'historique — donc ils n'ont pas à repasser par les genres comme la
  // bibliothèque.
  for (const entry of verdicts) {
    const ageDays = (now - entry.atMillis) / (24 * 3600 * 1000);
    const weight = traitWeight(VERDICT_WEIGHT[entry.verdict], ageDays, 1);
    for (const axis of AXIS_KEYS) {
      const value = entry.axes[axis];
      if (typeof value !== 'number') continue;
      // Un film abandonné est une preuve *contre* sa position. La mise à jour
      // ne sait que tirer vers une cible, jamais repousser : on vise donc un
      // point atténué du côté opposé, proportionnel à l'écart d'origine — un
      // film neutre ne produit ainsi aucun signal, là où une simple inversion
      // en inventerait un. Réserve honnête : « pas fini » peut tenir à la
      // fatigue ou à l'heure plutôt qu'au goût, d'où un poids inférieur à celui
      // de « resté avec moi ».
      const target = entry.verdict === 'unfinished' ? -0.4 * value : value;
      observe(axis, Math.max(-1, Math.min(1, target)), weight);
    }
  }

  // Les séances, ensuite. C'était la fuite principale du système : les réponses
  // de goût durable étaient posées, exploitées un soir, puis jetées — dix
  // séances sans Galerie n'apprenaient rien l'une à l'autre. Elles s'accumulent
  // désormais ici, avec la même demi-vie que le reste.
  for (const signal of signals) {
    const ageDays = (now - signal.atMillis) / (24 * 3600 * 1000);

    for (const [field, options] of Object.entries(DURABLE_ANSWER_AXES)) {
      const value = signal.answers[field];
      if (typeof value !== 'string') continue;
      const targets = options[value];
      if (!targets) continue;
      const weight = traitWeight(TRAIT_WEIGHT_SESSION_ANSWER, ageDays, 1);
      for (const [axis, target] of targets) observe(axis, target, weight);
    }

    // Le refus, enfin visible : un trio écarté (« Aucun ne me tente ») — ou
    // resté sans lancement au bout d'une semaine — est une preuve *contre* sa
    // position. Même convention que « pas fini » : une cible atténuée du côté
    // opposé, seulement sur les axes où le trio se situait franchement.
    const negativeBase = signal.rejected ?
      TRAIT_WEIGHT_REJECTED_TRIO :
      (!signal.launched && ageDays > IGNORED_TRIO_AFTER_DAYS ?
        TRAIT_WEIGHT_IGNORED_TRIO : 0);
    if (negativeBase > 0) {
      const weight = traitWeight(negativeBase, ageDays, 1);
      for (const axis of AXIS_KEYS) {
        const value = signal.trioAxes[axis];
        if (typeof value !== 'number' || Math.abs(value) < 0.25) continue;
        observe(axis, Math.max(-1, Math.min(1, -0.4 * value)), weight);
      }
    }
  }

  // Les corrections passent en dernier et pèsent le plus lourd : ce que
  // quelqu'un dit de lui-même prime sur ce qu'on a déduit de ses habitudes.
  const correctedAxes: AxisKey[] = [];
  for (const axis of AXIS_KEYS) {
    const value = corrections[axis];
    if (typeof value === 'number' && Number.isFinite(value)) {
      observe(axis, Math.max(-1, Math.min(1, value)), TRAIT_WEIGHT_CORRECTION);
      correctedAxes.push(axis);
    }
  }

  return {
    mu, tau,
    galleryCount: gallery.length,
    watchlistCount: watchlist.length,
    correctedAxes,
  };
}

/**
 * Lit les entrées de bibliothèque utiles au trait.
 * @param {admin.firestore.QuerySnapshot} snap Collection Firestore.
 * @return {TraitEntry[]} Entrées normalisées.
 */
function traitEntriesFrom(
    snap: admin.firestore.QuerySnapshot,
): TraitEntry[] {
  const entries: TraitEntry[] = [];
  for (const doc of snap.docs) {
    const genreIds = doc.get('genreIds');
    const addedAt = doc.get('addedAt');
    const millis = addedAt instanceof admin.firestore.Timestamp ?
      addedAt.toMillis() : Date.now();
    entries.push({
      genreIds: Array.isArray(genreIds) ?
        genreIds.filter((g): g is number => typeof g === 'number') : [],
      inCollection: typeof doc.get('collectionId') === 'number',
      addedAtMillis: millis,
    });
  }
  return entries;
}

/**
 * Ce qu'on redemandera à la prochaine ouverture, quand un film a été lancé sans
 * qu'on sache encore ce qu'il a donné.
 */
interface PendingVerdict {
  tmdbId: number;
  title: string | null;
}

/** Le délai avant de demander ce qu'un film a donné. Trop tôt, la personne est
 * encore devant ; trop tard, elle ne s'en souvient plus. */
const VERDICT_DELAY_HOURS = 8;
/**
 * Au-delà, on n'en parle plus : une question sur un film d'il y a trois
 * semaines est une corvée, pas une conversation.
 */
const VERDICT_EXPIRY_DAYS = 14;

/**
 * Position moyenne d'un trio dans l'espace commun, axe par axe.
 * @param {unknown[]} films Bloc `films` d'un document d'historique.
 * @return {Partial<AxisVector>} Moyenne par axe, axes sans donnée omis.
 */
function meanFilmAxes(films: unknown[]): Partial<AxisVector> {
  const sums = new Map<AxisKey, {total: number; count: number}>();
  for (const film of films) {
    if (typeof film !== 'object' || film === null) continue;
    const axes = (film as Record<string, unknown>).axes;
    if (typeof axes !== 'object' || axes === null) continue;
    const record = axes as Record<string, unknown>;
    for (const axis of AXIS_KEYS) {
      const value = record[axis];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const entry = sums.get(axis) ?? {total: 0, count: 0};
      entry.total += value;
      entry.count += 1;
      sums.set(axis, entry);
    }
  }
  const out: Partial<AxisVector> = {};
  for (const [axis, {total, count}] of sums) out[axis] = total / count;
  return out;
}

/** Ce que l'historique des séances apprend, une fois relu. */
interface SessionOutcomes {
  verdicts: TraitVerdict[];
  pending: PendingVerdict | null;
  signals: SessionSignal[];
}

/**
 * Relit l'historique des séances : les verdicts déjà donnés, celui qu'on
 * pourrait encore demander, et ce que chaque séance laisse au trait.
 * @param {admin.firestore.QuerySnapshot} snap Historique récent.
 * @return {SessionOutcomes} Lecture.
 */
function readSessionOutcomes(
    snap: admin.firestore.QuerySnapshot,
): SessionOutcomes {
  const verdicts: TraitVerdict[] = [];
  const signals: SessionSignal[] = [];
  let pending: PendingVerdict | null = null;
  const now = Date.now();

  for (const doc of snap.docs) {
    // Chaque séance parle au trait — y compris celles qui n'ont mené à aucun
    // lancement : c'est même leur silence qui nous intéresse.
    const createdAt = doc.get('createdAt');
    const films = doc.get('films');
    const answersRaw = doc.get('answers');
    const launched = doc.get('launched');
    const hasLaunch = typeof launched === 'object' && launched !== null;
    signals.push({
      answers: (typeof answersRaw === 'object' && answersRaw !== null) ?
        answersRaw as Record<string, unknown> : {},
      trioAxes: meanFilmAxes(Array.isArray(films) ? films : []),
      rejected: doc.get('rejected') === true,
      launched: hasLaunch,
      atMillis: createdAt instanceof admin.firestore.Timestamp ?
        createdAt.toMillis() : now,
    });

    if (!hasLaunch) continue;
    const record = launched as Record<string, unknown>;
    const tmdbId = Number(record.tmdbId);
    if (!Number.isFinite(tmdbId)) continue;

    const at = record.at instanceof admin.firestore.Timestamp ?
      record.at.toMillis() : 0;
    const verdict = doc.get('verdict');

    if (verdict === 'stayed' || verdict === 'passed' ||
        verdict === 'unfinished') {
      verdicts.push({
        axes: parseAxes(record.axes),
        verdict,
        atMillis: at || now,
      });
      continue;
    }

    // Pas encore de verdict : est-ce encore le moment d'en demander un ?
    const ageHours = (now - at) / (3600 * 1000);
    if (!pending && ageHours >= VERDICT_DELAY_HOURS &&
        ageHours <= VERDICT_EXPIRY_DAYS * 24) {
      pending = {
        tmdbId,
        title: typeof record.title === 'string' ? record.title : null,
      };
    }
  }

  return {verdicts, pending, signals};
}

/**
 * Construit les tags "pourquoi ce film" affichés à l'utilisateur, à partir
 * de faits vérifiables sur le film plutôt que d'expliquer la formule.
 * @param {EnrichedCandidate} c Candidat enrichi.
 * @param {QuestionnaireAnswersPayload} answers Réponses au questionnaire.
 * @param {string} language Langue de la requête en cours.
 * @return {string[]} Jusqu'à 4 tags courts.
 */
function buildReasons(
    c: EnrichedCandidate,
    answers: QuestionnaireAnswersPayload,
    language: string,
): string[] {
  const genres = GENRE_LABELS[language] ?? GENRE_LABELS[DEFAULT_LANGUAGE];
  const labels = REASON_LABELS[language] ?? REASON_LABELS[DEFAULT_LANGUAGE];
  const reasons: string[] = [];
  const genreIds = c.genre_ids ?? [];
  const chosenGenreIds = genreIdsFor(answers.genres);

  for (const id of genreIds) {
    if (chosenGenreIds.includes(id) && genres[id]) {
      reasons.push(genres[id]);
    }
    if (reasons.length >= 2) break;
  }

  if (c.runtimeMinutes !== null) {
    if (c.runtimeMinutes <= 95) reasons.push(labels.short);
    else if (c.runtimeMinutes >= 125) reasons.push(labels.long);
  }

  if ((c.vote_average ?? 0) >= 7.5) reasons.push(labels.wellRated);

  const matchedProvider = answers.platformIds.find((id) =>
    c.providerIds.includes(Number(id)));
  if (matchedProvider) reasons.push(labels.onYourPlatform);

  if (reasons.length === 0) reasons.push(labels.fallback);
  return reasons.slice(0, 4);
}

/**
 * Fetch le détail TMDB (runtime, casting, collection, providers FR) pour un
 * candidat de la shortlist — une seule requête par film grâce à
 * append_to_response.
 * @param {DiscoverRow} row Ligne issue du pool /discover.
 * @param {TMDBContext} ctx Jeton et langue de la requête en cours.
 * @return {Promise<EnrichedCandidate | null>} Candidat enrichi, ou null en
 *   cas d'échec (le film est alors simplement ignoré).
 */
async function enrichCandidate(
    row: DiscoverRow, ctx: TMDBContext,
): Promise<EnrichedCandidate | null> {
  try {
    const detail = await tmdbGET(`/movie/${row.id}`, {
      append_to_response: 'credits,videos,watch/providers,keywords',
    }, ctx);

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

    const rawKeywords =
      (detail.keywords as {keywords?: unknown} | undefined)?.keywords;
    const keywordNames: string[] = Array.isArray(rawKeywords) ?
      (rawKeywords as {name?: unknown}[])
          .map((k) => k.name)
          .filter((n): n is string => typeof n === 'string') : [];

    const videosResults =
      (detail.videos as {results?: unknown} | undefined)?.results;
    const videos = Array.isArray(videosResults) ?
      (videosResults as {type?: string; site?: string; key?: string}[]) : [];
    const trailer =
      videos.find((v) => v.type === 'Trailer' && v.site === 'YouTube') ??
      videos.find((v) => v.site === 'YouTube');
    const trailerKey = trailer?.key ?? null;

    // Le pays d'origine n'existe que sur la fiche détaillée : les endpoints de
    // liste de TMDB ne le renvoient pas du tout. C'est donc ici, et nulle part
    // avant, qu'on peut le connaître — et c'est pourquoi la garantie d'origine
    // s'applique à la finalisation, sur des candidats déjà enrichis.
    const detailOrigins = Array.isArray(detail.origin_country) ?
      (detail.origin_country as unknown[])
          .filter((c): c is string => typeof c === 'string') : [];
    const productionCountries = Array.isArray(detail.production_countries) ?
      (detail.production_countries as {iso_3166_1?: unknown}[])
          .map((c) => c.iso_3166_1)
          .filter((c): c is string => typeof c === 'string') : [];
    const originCountry = detailOrigins.length > 0 ?
      detailOrigins : productionCountries;

    return {
      ...row,
      origin_country: originCountry,
      runtimeMinutes:
        typeof detail.runtime === 'number' ? detail.runtime : null,
      belongsToCollection: detail.belongs_to_collection !== null &&
        detail.belongs_to_collection !== undefined,
      castPopularities,
      providerIds,
      trailerKey,
      budget: typeof detail.budget === 'number' ? detail.budget : null,
      keywordNames: keywordNames,
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
      return {
        candidate, adjustedScore: Math.max(1, candidate.finalScore - penalty),
      };
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
  const weights =
    items.map((i) => Math.exp(i.adjustedScore / SOFTMAX_TEMPERATURE));
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
 *
 * L'attestation de l'application est vérifiée d'abord, et au même endroit :
 * c'est ce qui garantit qu'aucun point d'entrée authentifié ne peut l'oublier.
 * Un compte Firebase étant gratuit et illimité à créer, le jeton utilisateur
 * dit qui appelle, jamais depuis quoi.
 * @param {Request} req Incoming request.
 * @param {Response} res Response to write an error to on failure.
 * @return {Promise<string | null>} The authenticated uid, or null.
 */
async function verifyAuth(req: Request, res: Response): Promise<string | null> {
  if (!await passesAppCheck(req, res)) return null;

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

/**
 * JSON shape of a `DiscoverRow` as sent to/echoed back by the client.
 * @param {DiscoverRow} row Row to serialize.
 * @return {Object} Plain object ready for `res.json`.
 */
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
 * Le trait : ce que la bibliothèque raconte, traduit dans l'espace commun.
 *
 * Recalculé à chaque appel plutôt que mis en cache — une Galerie tient en une
 * lecture Firestore, et un cache introduirait une fraîcheur à gérer pour
 * économiser quelques millisecondes. Renvoie systématiquement un profil, même
 * vide : le démarrage à froid est un chemin normal, pas une erreur.
 */
export const getTasteProfile = onRequest(
    {invoker: 'public', timeoutSeconds: 20},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'POST') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const db = getAdmin().firestore();
        const userRef = db.collection('users').doc(uid);
        const [gallerySnap, watchlistSnap, correctionsSnap, historySnap] =
          await Promise.all([
            userRef.collection('gallery').get(),
            userRef.collection('watchlist').get(),
            userRef.collection('taste').doc('corrections').get(),
            userRef.collection('recommendationHistory')
                .orderBy('createdAt', 'desc').limit(20).get(),
          ]);

        const corrections: Partial<AxisVector> = {};
        if (correctionsSnap.exists) {
          for (const axis of AXIS_KEYS) {
            const value = correctionsSnap.get(axis);
            if (typeof value === 'number') corrections[axis] = value;
          }
        }

        const outcomes = readSessionOutcomes(historySnap);
        const trait = buildTraitProfile(
            traitEntriesFrom(gallerySnap),
            traitEntriesFrom(watchlistSnap),
            corrections,
            outcomes.verdicts,
            outcomes.signals,
        );

        res.status(200).json({
          mu: trait.mu,
          tau: trait.tau,
          gallery_count: trait.galleryCount,
          watchlist_count: trait.watchlistCount,
          corrected_axes: trait.correctedAxes,
          verdict_count: outcomes.verdicts.length,
          pending_verdict: outcomes.pending,
        });
      } catch (error) {
        logger.error('getTasteProfile failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

/**
 * Ce qu'une séance a donné, en deux temps : le film lancé, puis ce qu'il a
 * laissé.
 *
 * C'est le seul endroit du système où l'on apprend quelque chose de
 * l'expérience réelle plutôt que d'une déclaration ou d'une intention. Tout le
 * reste — les charges du corpus, les coefficients du cadran, la force des
 * sources — sera un jour calibré sur ces deux signaux ; en attendant ils
 * nourrissent déjà le trait.
 */
export const recordSessionOutcome = onRequest(
    {invoker: 'public', timeoutSeconds: 20},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'POST') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const body = (req.body ?? {}) as Record<string, unknown>;
        const tmdbId = Number(body.tmdbId);
        if (body.kind !== 'rejection' && !Number.isFinite(tmdbId)) {
          res.status(400).json({error: 'invalid_tmdb_id'});
          return;
        }

        const userRef = getAdmin().firestore().collection('users').doc(uid);
        const historySnap = await userRef.collection('recommendationHistory')
            .orderBy('createdAt', 'desc').limit(20).get();

        if (body.kind === 'rejection') {
          // « Aucun des trois ne me tente » — le cas le plus fréquent d'échec
          // était jusqu'ici invisible. On marque la séance qui a proposé ce
          // trio ; le trait en tirera une preuve contre sa position.
          const ids = Array.isArray(body.tmdbIds) ?
            body.tmdbIds.filter((x): x is number =>
              typeof x === 'number' && Number.isFinite(x)) : [];
          if (ids.length === 0) {
            res.status(400).json({error: 'invalid_tmdb_ids'});
            return;
          }
          const doc = historySnap.docs.find((d) => {
            const stored = d.get('tmdbIds');
            return Array.isArray(stored) &&
              ids.every((id) => stored.includes(id));
          });
          if (!doc) {
            res.status(404).json({error: 'session_not_found'});
            return;
          }
          await doc.ref.set({
            rejected: true,
            rejectedAt: admin.firestore.Timestamp.now(),
          }, {merge: true});
          res.status(200).json({ok: true});
          return;
        }

        if (body.kind === 'launch') {
          // On retrouve la séance qui a proposé ce film pour y attacher sa
          // position — le client n'a pas à la transporter.
          const doc = historySnap.docs.find((d) => {
            const ids = d.get('tmdbIds');
            return Array.isArray(ids) && ids.includes(tmdbId);
          });
          if (!doc) {
            res.status(404).json({error: 'session_not_found'});
            return;
          }
          const films = doc.get('films');
          const film = Array.isArray(films) ?
            (films as Record<string, unknown>[])
                .find((f) => Number(f.id) === tmdbId) : undefined;

          await doc.ref.set({
            launched: {
              tmdbId,
              title: film?.title ?? null,
              rank: film?.rank ?? null,
              axes: film?.axes ?? null,
              at: admin.firestore.Timestamp.now(),
            },
          }, {merge: true});
          res.status(200).json({ok: true});
          return;
        }

        if (body.kind === 'verdict') {
          const value = body.verdict;
          if (value !== 'stayed' && value !== 'passed' &&
            value !== 'unfinished') {
            res.status(400).json({error: 'invalid_verdict'});
            return;
          }
          const doc = historySnap.docs.find(
              (d) => Number(d.get('launched')?.tmdbId) === tmdbId,
          );
          if (!doc) {
            res.status(404).json({error: 'session_not_found'});
            return;
          }
          await doc.ref.set({verdict: value}, {merge: true});
          res.status(200).json({ok: true});
          return;
        }

        res.status(400).json({error: 'unknown_kind'});
      } catch (error) {
        logger.error('recordSessionOutcome failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

/**
 * Une correction posée sur la Fiche. Stockée à part du calcul : un recalcul du
 * trait ne doit jamais effacer ce que quelqu'un a dit de lui-même. Une valeur
 * nulle retire la correction et rend l'axe à l'inférence.
 */
export const setTasteCorrection = onRequest(
    {invoker: 'public', timeoutSeconds: 20},
    async (req: Request, res: Response) => {
      try {
        if (req.method !== 'POST') {
          res.status(405).json({error: 'method_not_allowed'});
          return;
        }
        const uid = await verifyAuth(req, res);
        if (!uid) return;

        const body = (req.body ?? {}) as Record<string, unknown>;
        const axis = typeof body.axis === 'string' ? body.axis : '';
        if (!AXIS_KEYS.includes(axis as AxisKey)) {
          res.status(400).json({error: 'unknown_axis'});
          return;
        }

        const ref = getAdmin().firestore()
            .collection('users').doc(uid)
            .collection('taste').doc('corrections');

        if (body.value === null) {
          await ref.set(
              {[axis]: admin.firestore.FieldValue.delete()}, {merge: true},
          );
        } else if (typeof body.value === 'number' &&
          Number.isFinite(body.value)) {
          await ref.set(
              {[axis]: Math.max(-1, Math.min(1, body.value))}, {merge: true},
          );
        } else {
          res.status(400).json({error: 'invalid_value'});
          return;
        }

        res.status(200).json({ok: true});
      } catch (error) {
        logger.error('setTasteCorrection failed', {error});
        res.status(500).json({error: 'internal_error'});
      }
    },
);

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
          fetchCandidatePool(
              answers,
              {dealbreaker: true, platforms: false},
              tmdb(req, res),
          ),
        ]);

        // Les genres bannis dans les réglages ne sont jamais assouplis, même
        // quand le vivier est trop maigre : c'est le sens de « jamais ». Le
        // genre demandé ce soir suit la même règle — c'est la réponse la plus
        // explicite du parcours, elle prime sur la taille du vivier.
        // Le pays d'origine ne figure pas ici : TMDB ne le renvoie pas sur ses
        // listes. C'est `with_origin_country` dans la requête qui a trié, et la
        // finalisation qui garantira — sur des candidats enrichis, seuls à
        // porter l'information.
        const keep = (row: DiscoverRow): boolean =>
          !exclusionSet.has(row.id) &&
          !(row.genre_ids ?? [])
              .some((id) => declared.bannedGenreIDs.has(id)) &&
          matchesRequestedGenres(row.genre_ids, answers);

        let pool = filterByContentFormat(rawPool.filter(keep), answers);
        let notice: string | null = null;

        if (pool.length < POOL_HARD_FLOOR && answers.platformIds.length > 0) {
          const relaxed = await fetchCandidatePool(
              answers, {dealbreaker: true, platforms: true}, tmdb(req, res),
          );
          pool = filterByContentFormat(relaxed.filter(keep), answers);
          notice = 'Résultats élargis hors de vos plateformes habituelles.';
        }
        if (!notice && pool.length < POOL_HEALTHY_TARGET) {
          logger.info('getCandidatePool: below healthy pool target', {
            uid, poolSize: pool.length, target: POOL_HEALTHY_TARGET,
          });
        }

        // Les axes sont calculés ici et nulle part ailleurs : le client les
        // rejoue tels quels pour son classement local, et les renvoie à la
        // finalisation. Une seule source de vérité pour la position des films.
        const stats = poolStatsFor(pool);
        const coarseSigma = axisSigmaFor(false, null);

        res.status(200).json({
          candidates: pool.map((row) => ({
            ...discoverRowToJSON(row),
            axes: coarseAxesFor(row, stats),
            axis_sigma: coarseSigma,
          })),
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
        const rawCandidates =
          Array.isArray(body.candidates) ? body.candidates : [];
        const rows: DiscoverRow[] = rawCandidates
            .filter((c): c is Record<string, unknown> =>
              typeof c === 'object' && c !== null)
            .map((c) => ({
              id: Number(c.id),
              title: typeof c.title === 'string' ? c.title : undefined,
              overview: typeof c.overview === 'string' ? c.overview : null,
              poster_path:
                typeof c.poster_path === 'string' ? c.poster_path : null,
              vote_average:
                typeof c.vote_average === 'number' ? c.vote_average : null,
              vote_count:
                typeof c.vote_count === 'number' ? c.vote_count : null,
              popularity:
                typeof c.popularity === 'number' ? c.popularity : null,
              genre_ids:
                Array.isArray(c.genre_ids) ? c.genre_ids as number[] : [],
              release_date:
                typeof c.release_date === 'string' ? c.release_date : null,
              origin_country: Array.isArray(c.origin_country) ?
                c.origin_country as string[] : [],
            }))
            .filter((row) => Number.isFinite(row.id));

        if (rows.length === 0) {
          res.status(400).json({error: 'no_candidates'});
          return;
        }
        if (rows.length > ENRICH_BATCH_MAX) {
          res.status(400).json({
            error: 'too_many_candidates', max: ENRICH_BATCH_MAX,
          });
          return;
        }

        // Les axes grossiers arrivent avec les candidats et servent de base au
        // raffinage : c'est la seule façon de préserver la part « notoriété »
        // de `fa`, calculée sur le vivier entier à l'étape précédente.
        const coarseByID = new Map<number, AxisVector>();
        for (const raw of rawCandidates) {
          if (typeof raw !== 'object' || raw === null) continue;
          const record = raw as Record<string, unknown>;
          const id = Number(record.id);
          if (Number.isFinite(id)) coarseByID.set(id, parseAxes(record.axes));
        }

        const enrichedResults = await Promise.allSettled(
            rows.map((row) => enrichCandidate(row, tmdb(req, res))),
        );
        const enriched = enrichedResults
            .filter((r) => r.status === 'fulfilled')
            .map((r) =>
              (r as PromiseFulfilledResult<EnrichedCandidate | null>).value)
            .filter((c): c is EnrichedCandidate => c !== null);

        res.status(200).json({
          candidates: enriched.map((c) => {
            const base = coarseByID.get(c.id) ?? parseAxes(null);
            return {
              ...discoverRowToJSON(c),
              runtime_minutes: c.runtimeMinutes,
              belongs_to_collection: c.belongsToCollection,
              cast_popularities: c.castPopularities,
              provider_ids: c.providerIds,
              trailer_key: c.trailerKey,
              axes: refineAxes(base, c),
              axis_sigma: axisSigmaFor(true, c),
            };
          }),
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
        const rawCandidates =
          Array.isArray(body.candidates) ? body.candidates : [];

        let shortlist: EnrichedCandidate[] = rawCandidates
            .filter((c): c is Record<string, unknown> =>
              typeof c === 'object' && c !== null)
            .map((c) => ({
              id: Number(c.id),
              title: typeof c.title === 'string' ? c.title : undefined,
              overview: typeof c.overview === 'string' ? c.overview : null,
              poster_path:
                typeof c.poster_path === 'string' ? c.poster_path : null,
              vote_average:
                typeof c.vote_average === 'number' ? c.vote_average : null,
              vote_count:
                typeof c.vote_count === 'number' ? c.vote_count : null,
              popularity:
                typeof c.popularity === 'number' ? c.popularity : null,
              genre_ids:
                Array.isArray(c.genre_ids) ? c.genre_ids as number[] : [],
              release_date:
                typeof c.release_date === 'string' ? c.release_date : null,
              origin_country: Array.isArray(c.origin_country) ?
                c.origin_country as string[] : [],
              runtimeMinutes: typeof c.runtime_minutes === 'number' ?
                c.runtime_minutes : null,
              belongsToCollection: c.belongs_to_collection === true,
              castPopularities: Array.isArray(c.cast_popularities) ?
                c.cast_popularities as number[] : [],
              providerIds: Array.isArray(c.provider_ids) ?
                c.provider_ids as number[] : [],
              trailerKey:
                typeof c.trailer_key === 'string' ? c.trailer_key : null,
              budget: typeof c.budget === 'number' ? c.budget : null,
              // Les axes voyagent avec le candidat depuis leur calcul initial
              // et restent attachés à lui : les filtres et tris qui suivent
              // peuvent réordonner la shortlist sans jamais les désaligner.
              axes: parseAxes(c.axes),
              axisSigma: parseSigma(c.axis_sigma),
              finalScore: 0,
              reasons: [],
            }))
            .filter((row) => Number.isFinite(row.id));

        if (shortlist.length === 0) {
          res.status(400).json({error: 'no_candidates'});
          return;
        }

        // Le genre demandé, réappliqué là où le trio se décide. Sans ce filtre,
        // la garantie reposait entièrement sur le fait que le client renvoie le
        // vivier qu'il avait reçu — une supposition, pas une garantie. Aucun
        // repli ici : si plus rien ne correspond, mieux vaut le dire que
        // proposer un film d'un genre qui n'a pas été demandé.
        shortlist = shortlist.filter(
            (c) => matchesRequestedGenres(c.genre_ids, answers),
        );
        if (shortlist.length === 0) {
          res.status(409).json({error: 'no_candidates_in_requested_genres'});
          return;
        }

        shortlist = shortlist.filter(
            (c) => matchesRequestedOrigins(c.origin_country, answers),
        );
        if (shortlist.length === 0) {
          res.status(409).json({error: 'no_candidates_in_requested_origins'});
          return;
        }

        // "predictablePlot" est un filtre dur : on retire les suites/sagas,
        // sauf si ça viderait la shortlist (jamais de résultat vide).
        if (answers.dealbreaker === 'predictablePlot') {
          const withoutFranchises =
            shortlist.filter((c) => !c.belongsToCollection);
          if (withoutFranchises.length >= RESULT_COUNT) {
            shortlist = withoutFranchises;
          }
        }

        // Le scoring par proximité dans l'espace commun est la voie normale.
        // L'ancienne formule pondérée reste le repli d'un client qui
        // n'enverrait pas encore de croyance — elle n'a pas d'autre usage.
        const belief = parseBelief(body.belief);
        shortlist = shortlist
            .map((c) => ({
              ...c,
              finalScore: belief && c.axes && c.axisSigma ?
                beliefScore(c.axes, c.axisSigma, belief) :
                finalWeightedScore(c, answers),
            }))
            .sort((a, b) => b.finalScore - a.finalScore);

        // L'exploration (softmax) choisit délibérément les 3 films dans un
        // ordre non strictement trié — on re-trie par score pour l'affichage
        // (#1/#2/#3) sans changer *lesquels* des 3 films ont été
        // sélectionnés.
        const selected = selectWithExplorationAndDiversity(shortlist)
            .sort((a, b) => b.finalScore - a.finalScore)
            .map((c) => ({
              ...c,
              reasons: buildReasons(c, answers, requestedLanguage(req, res)),
            }));

        const a = getAdmin();
        await a.firestore().collection('users').doc(uid)
            .collection('recommendationHistory').add({
              createdAt: a.firestore.Timestamp.now(),
              tmdbIds: selected.map((c) => c.id),
              answers,
              // La position des trois films est conservée ici, et nulle part
              // ailleurs : c'est à elle que le verdict du lendemain viendra
              // s'accrocher. Sans ça, savoir qu'un film est « resté » avec
              // quelqu'un n'apprendrait rien — on ignorerait de quel film il
              // s'agissait dans l'espace commun.
              films: selected.map((c, index) => ({
                id: c.id,
                title: c.title ?? null,
                rank: index + 1,
                axes: c.axes ?? null,
              })),
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

/**
 * Borne une valeur dans [0, 1].
 * @param {number} value Valeur à borner.
 * @return {number} Valeur bornée.
 */
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
 * @param {DeclaredProfile} declared Préférences déclarées au questionnaire.
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

/**
 * Copie mélangée (Fisher-Yates).
 * @param {T[]} items Éléments à mélanger.
 * @return {T[]} Copie mélangée, l'original n'est pas modifié.
 */
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
 * @param {TMDBContext} ctx Jeton et langue de la requête en cours.
 * @return {Promise<DiscoverRow[]>} Candidats du voisinage.
 */
async function fetchNeighborCandidates(
    profile: TasteProfile, ctx: TMDBContext,
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
        page: '1',
      }, ctx)),
    ...similarSeeds.map((id) =>
      tmdbGET(`/movie/${id}/similar`, {
        page: '1',
      }, ctx)),
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
 * @param {TMDBContext} ctx Jeton et langue de la requête en cours.
 * @return {Promise<DiscoverRow[]>} Candidats profilés.
 */
async function fetchProfiledCandidates(
    profile: TasteProfile, voteCountFloor: number, ctx: TMDBContext,
): Promise<DiscoverRow[]> {
  const genreIds = topGenreIds(profile, 3);
  if (genreIds.length === 0) return [];

  const decades = targetDecades(profile);
  const requests = decades.map((decade) => tmdbGET('/discover/movie', {
    'region': DEFAULT_REGION,
    'include_adult': 'false',
    'include_video': 'false',
    'with_genres': genreIds.join('|'),
    'primary_release_date.gte': `${decade}-01-01`,
    'primary_release_date.lte': `${decade + 9}-12-31`,
    'vote_count.gte': String(voteCountFloor),
    'sort_by': 'vote_count.desc',
    'page': String(1 + Math.floor(Math.random() * 3)),
  }, ctx));

  const settled = await Promise.allSettled(requests);
  return settled.flatMap((result) => rowsFrom(result, 'results'));
}

/**
 * Source C — les piliers de notoriété d'une décennie, sans filtre de genre.
 * C'est ce qui fait tourner le feed à froid, et ce qui rattrape les
 * blockbusters que tout le monde a vus en dehors de son genre de prédilection.
 * @param {TasteProfile} profile Profil de goût.
 * @param {TMDBContext} ctx Jeton et langue de la requête en cours.
 * @return {Promise<DiscoverRow[]>} Candidats grand public.
 */
async function fetchPillarCandidates(
    profile: TasteProfile, ctx: TMDBContext,
): Promise<DiscoverRow[]> {
  const decades = profile.gallerySize >= SWIPE_PROFILE_MIN_SIZE ?
    targetDecades(profile) :
    shuffled([1990, 2000, 2010, 2020]);

  const requests = decades.map((decade) => tmdbGET('/discover/movie', {
    'region': DEFAULT_REGION,
    'include_adult': 'false',
    'include_video': 'false',
    'primary_release_date.gte': `${decade}-01-01`,
    'primary_release_date.lte': `${decade + 9}-12-31`,
    'vote_count.gte': String(SWIPE_COLD_VOTE_COUNT_FLOOR),
    'sort_by': 'vote_count.desc',
    'page': String(1 + Math.floor(Math.random() * 3)),
  }, ctx));

  const settled = await Promise.allSettled(requests);
  return settled.flatMap((result) => rowsFrom(result, 'results'));
}

/**
 * Sources D et E — franchises et têtes d'affiche récurrentes. Les deux
 * partagent les mêmes appels de détail (`append_to_response=credits`) : une
 * seule requête par graine sert à la fois à trouver la saga et le casting.
 * @param {TasteProfile} profile Profil de goût.
 * @param {TMDBContext} ctx Jeton et langue de la requête en cours.
 * @return {Promise<{franchise: DiscoverRow[], people: DiscoverRow[]}>}
 *   Candidats des deux sources.
 */
async function fetchFranchiseAndPeopleCandidates(
    profile: TasteProfile, ctx: TMDBContext,
): Promise<{franchise: DiscoverRow[]; people: DiscoverRow[]}> {
  const seeds = profile.seedIds.slice(0, SWIPE_SEEDS_DETAILS);
  if (seeds.length === 0) return {franchise: [], people: []};

  const detailSettled = await Promise.allSettled(
      seeds.map((id) => tmdbGET(`/movie/${id}`, {
        append_to_response: 'credits',
      }, ctx)),
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
        }, ctx)),
    ),
    Promise.allSettled(
        Array.from(personIds).slice(0, 2).map((id) =>
          tmdbGET('/discover/movie', {
            'include_adult': 'false',
            'include_video': 'false',
            'with_cast': String(id),
            'vote_count.gte': String(SWIPE_VOTE_COUNT_FLOOR),
            'sort_by': 'vote_count.desc',
            'page': '1',
          }, ctx)),
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
 * @param {TMDBContext} ctx Jeton et langue de la requête en cours.
 * @return {Promise<Map<number, SwipeCandidate>>} Vivier dédoublonné.
 */
async function fetchSwipePool(
    profile: TasteProfile, ctx: TMDBContext,
): Promise<Map<number, SwipeCandidate>> {
  const voteCountFloor = profile.gallerySize >= SWIPE_PROFILE_MATURE_SIZE ?
    SWIPE_VOTE_COUNT_FLOOR : SWIPE_COLD_VOTE_COUNT_FLOOR;

  const [neighbors, profiled, pillars, franchiseAndPeople] = await Promise.all([
    fetchNeighborCandidates(profile, ctx),
    fetchProfiledCandidates(profile, voteCountFloor, ctx),
    fetchPillarCandidates(profile, ctx),
    fetchFranchiseAndPeopleCandidates(profile, ctx),
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

/**
 * Ids déjà servis dans la session courante, envoyés par le client.
 * @param {unknown} value Payload brut de la requête.
 * @return {Set<number>} Ids valides, dédupliqués.
 */
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

        const pool = await fetchSwipePool(profile, tmdb(req, res));
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
    const item =
      entry.item as SwipeDecisionPayload['item'] | undefined;
    if (!item?.id || !item?.tmdbId || !item?.mediaType || !item?.title) {
      continue;
    }
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
              totalDecisions:
                a.firestore.FieldValue.increment(decisions.length),
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

/**
 * Date au format `YYYY-MM-DD` attendu par TMDB.
 * @param {Date} date Date à formater.
 * @return {string} Date au format `YYYY-MM-DD`.
 */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Les films sortis en salle en France sur la fenêtre récente.
 *
 * `/discover` plutôt que `/movie/now_playing` : la fenêtre, le tri et le
 * filtrage restent sous contrôle, ce qui permet ensuite de classer selon les
 * goûts — impossible avec `now_playing`, qui renvoie une liste figée.
 * @param {TMDBContext} ctx Jeton et langue de la requête en cours.
 * @return {Promise<DiscoverRow[]>} Films à l'affiche.
 */
async function fetchInTheaters(ctx: TMDBContext): Promise<DiscoverRow[]> {
  const now = new Date();
  const from =
    new Date(now.getTime() - THEATERS_WINDOW_DAYS * 24 * 3600 * 1000);

  // La fenêtre glisse chaque nuit. Elle figure dans les paramètres, donc dans
  // l'URL, donc dans la clé de cache : la veille s'évince d'elle-même.
  const requests = [1, 2].map((page) => tmdbGET('/discover/movie', {
    'region': DEFAULT_REGION,
    'include_adult': 'false',
    'include_video': 'false',
    // 3 = sortie en salle, 2 = première limitée.
    'with_release_type': '3|2',
    'primary_release_date.gte': isoDate(from),
    'primary_release_date.lte': isoDate(now),
    'sort_by': 'popularity.desc',
    'page': String(page),
  }, ctx));

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
 * @param {TMDBContext} ctx Jeton et langue de la requête en cours.
 * @return {Promise<DiscoverRow[]>} Lignes brutes, non filtrées.
 */
async function fetchTrendingPages(
    pages: number[], ctx: TMDBContext,
): Promise<DiscoverRow[]> {
  const settled = await Promise.allSettled(pages.map((page) => tmdbGET(
      '/trending/movie/week',
      {page: String(page)},
      ctx,
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
 * @param {TMDBContext} ctx Jeton et langue de la requête en cours.
 * @return {Promise<DiscoverRow[]>} Lignes brutes, assez nombreuses pour
 *   couvrir `TRENDING_MIN_SIZE` une fois nettoyées par l'appelant.
 */
async function backfillTrending(
    initial: DiscoverRow[],
    declared: DeclaredProfile,
    theatricalExclusion: Set<number>,
    ctx: TMDBContext,
): Promise<DiscoverRow[]> {
  let rows = initial;
  let nextPage = TRENDING_INITIAL_PAGES + 1;
  while (
    cleanHomeRow(rows, declared, theatricalExclusion).length <
      TRENDING_MIN_SIZE &&
    nextPage <= TRENDING_MAX_PAGES
  ) {
    rows = rows.concat(await fetchTrendingPages([nextPage], ctx));
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
    const isBanned =
      (row.genre_ids ?? []).some((id) => declared.bannedGenreIDs.has(id));
    if (isBanned) continue;
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
          fetchInTheaters(tmdb(req, res)),
          fetchTrendingPages(
              Array.from({length: TRENDING_INITIAL_PAGES}, (_, i) => i + 1),
              tmdb(req, res),
          ),
          seedId === null ? Promise.resolve([]) :
            tmdbGET(`/movie/${seedId}/recommendations`, {
              page: '1',
            }, tmdb(req, res))
                .then((data) => Array.isArray(data.results) ?
                  data.results as DiscoverRow[] : [])
                .catch(() => [] as DiscoverRow[]),
        ]);

        // Le classement par correspondance est ce qui distingue « au cinéma »
        // de « pour vous au cinéma ». La popularité ne sert qu'à départager :
        // en tête de tri elle ramènerait les mêmes blockbusters en permanence.
        const rankedTheaters = [...theaters].sort((left, right) => {
          const leftScore =
            tasteMatch({...left, source: 'profile', score: 0}, profile);
          const rightScore =
            tasteMatch({...right, source: 'profile', score: 0}, profile);
          if (Math.abs(leftScore - rightScore) > 0.02) {
            return rightScore - leftScore;
          }
          return (right.popularity ?? 0) - (left.popularity ?? 0);
        });

        const noExclusion = new Set<number>();
        const seededExclusion = seedId === null ?
          noExclusion : new Set<number>([seedId]);
        // Un film encore en salle a déjà sa rangée dédiée : le retrouver aussi
        // dans les tendances ferait doublon et brouillerait la distinction
        // entre « au cinéma » et « disponible ailleurs en ce moment ».
        const theatricalExclusion = new Set(
            theaters
                .filter((row) => typeof row.id === 'number')
                .map((row) => row.id),
        );
        const trending = await backfillTrending(
            trendingInitial, declared, theatricalExclusion, tmdb(req, res),
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
      director: typeof doc.get('director') === 'string' ?
        doc.get('director') : null,
      collectionId: typeof doc.get('collectionId') === 'number' ?
        doc.get('collectionId') : null,
      collectionTotal: typeof doc.get('collectionTotal') === 'number' ?
        doc.get('collectionTotal') : null,
      addedAt: addedAt instanceof admin.firestore.Timestamp ?
        addedAt.toDate() : null,
    };
  });
}

/**
 * Compte les valeurs distinctes d'une clé, en ignorant les nulls.
 * @param {T[]} items Éléments à compter.
 * @param {function(T): ?string} key Extrait la clé d'un élément.
 * @return {Map<string, number>} Effectif par valeur de clé.
 */
function countBy<T>(
    items: T[], key: (item: T) => string | null,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/**
 * Ce que raconte le détail d'un badge, dans chaque langue.
 *
 * Même parti que `GENRE_LABELS` et `REASON_LABELS` un peu plus haut, et pour la
 * même raison : ces phrases se composent ici, à partir de chiffres que seul le
 * serveur a en main, et sans second aller-retour. Elles suivent donc la langue
 * de la requête, table par table.
 *
 * Le prix de ce choix est qu'elles échappent au catalogue de l'app. La solution
 * plus fidèle à la règle serait de renvoyer les chiffres bruts et de composer
 * côté client ; elle coûte un aller-retour de conception pour cinq phrases.
 */
const BADGE_DETAIL_LABELS: Record<string, {
  missingDecades: (years: string) => string;
  actionFilms: (genre: string) => string;
  genresWithTen: (n: number) => string;
  watchlistFloor: (peak: number) => string;
  watchlistLeft: (n: number) => string;
  bestCollection: (percent: number) => string;
}> = {
  'fr-FR': {
    missingDecades: (years) => `Il vous manque les années ${years}.`,
    actionFilms: (genre) => `Films d'${genre} dans votre galerie.`,
    genresWithTen: (n) =>
      `${n} genres comptent déjà au moins 10 films.`,
    watchlistFloor: (peak) =>
      `Votre watchlist doit d'abord atteindre 15 films (record : ${peak}).`,
    watchlistLeft: (n) =>
      `Il reste ${n} film${n > 1 ? 's' : ''} à voir.`,
    bestCollection: (percent) =>
      `Votre saga la plus avancée est complétée à ${percent} %.`,
  },
  'en-US': {
    missingDecades: (years) => `You are missing the ${years}.`,
    actionFilms: (genre) => `${genre} films in your gallery.`,
    genresWithTen: (n) =>
      `${n} genres already count at least 10 films.`,
    watchlistFloor: (peak) =>
      `Your watchlist has to reach 15 films first (best: ${peak}).`,
    watchlistLeft: (n) =>
      `${n} film${n > 1 ? 's' : ''} left to watch.`,
    bestCollection: (percent) =>
      `Your most advanced saga is ${percent}% complete.`,
  },
};

/**
 * Applique les quinze règles.
 * @param {GalleryFact[]} facts Galerie normalisée.
 * @param {number} watchlistSize Taille actuelle de la watchlist.
 * @param {number} watchlistPeak Plus grande taille jamais atteinte.
 * @param {number} totalDecisions Nombre de cartes tranchées au swipe.
 * @param {string} language Langue de la requête en cours.
 * @return {BadgeState[]} État des quinze badges, sans les dates d'obtention.
 */
function computeBadgeStates(
    facts: GalleryFact[],
    watchlistSize: number,
    watchlistPeak: number,
    totalDecisions: number,
    language: string,
): BadgeState[] {
  const say = BADGE_DETAIL_LABELS[language] ??
    BADGE_DETAIL_LABELS[DEFAULT_LANGUAGE];
  const genreNames = GENRE_LABELS[language] ?? GENRE_LABELS[DEFAULT_LANGUAGE];
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
      facts
          .map((f) => f.addedAt)
          .filter((d): d is Date => d !== null)
          .map(parisDay),
  );

  const directorCounts = countBy(facts, (f) => f.director);
  const topDirector = Math.max(0, ...Array.from(directorCounts.values()));

  // Une saga est complète quand le nombre d'épisodes possédés atteint le
  // nombre total d'épisodes que TMDB lui connaît.
  const collectionOwned = new Map<number, number>();
  const collectionTotal = new Map<number, number>();
  for (const fact of facts) {
    if (fact.collectionId === null) continue;
    collectionOwned.set(
        fact.collectionId, (collectionOwned.get(fact.collectionId) ?? 0) + 1,
    );
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

  const preSeventies =
    facts.filter((f) => f.year !== null && f.year < 1970).length;

  const missingDecades = [
    1930, 1940, 1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020,
  ].filter((d) => !decades.has(d));

  const actionName = genreNames[GENRE_ACTION] ?? 'Action';

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
        say.missingDecades(missingDecades.slice(0, 3).join(', ')) : null),
    rule('steel_heart', genreCounts.get(GENRE_ACTION) ?? 0, 75,
        say.actionFilms(actionName.toLowerCase())),
    rule('sleepless', genreCounts.get(27) ?? 0, 40),
    rule('panoramic', genresWithTen, 8, say.genresWithTen(genresWithTen)),
    rule('marathon', streak, 7),
    rule('ritual', streak, 60),
    rule('clean_list',
      watchlistPeak >= 15 && watchlistSize === 0 ? 1 : 0, 1,
      watchlistPeak < 15 ?
        say.watchlistFloor(watchlistPeak) :
        say.watchlistLeft(watchlistSize)),
    rule('sorter', totalDecisions, 500),
    rule('signature', topDirector, 8),
    rule('integral', completedCollections > 0 ? 1 : 0, 1,
      bestCollectionRatio > 0 ?
        say.bestCollection(Math.round(bestCollectionRatio * 100)) : null),
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

        const publicProfileRef = db.collection('publicProfiles').doc(uid);
        const [
          gallerySnap, watchlistSnap, swipeSnap, badgesSnap, stateSnap,
          publicProfileSnap,
        ] = await Promise.all([
          userRef.collection('gallery').get(),
          userRef.collection('watchlist').get(),
          userRef.collection('preferences').doc('swipeProfile').get(),
          userRef.collection('badges').get(),
          userRef.collection('preferences').doc('badgeState').get(),
          publicProfileRef.get(),
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

        const states = computeBadgeStates(
            toGalleryFacts(gallerySnap.docs),
            watchlistSnap.size,
            watchlistPeak,
            totalDecisions,
            requestedLanguage(req, res),
        );

        const alreadyUnlocked = new Map<string, admin.firestore.Timestamp>();
        for (const doc of badgesSnap.docs) {
          const at = doc.get('unlockedAt');
          if (at instanceof admin.firestore.Timestamp) {
            alreadyUnlocked.set(doc.id, at);
          }
        }

        const now = a.firestore.Timestamp.now();
        const batch = db.batch();
        let writes = 0;

        const payload = states.map((state) => {
          const existing = alreadyUnlocked.get(state.id);
          if (existing) {
            // Déjà obtenu : il le reste, quoi qu'il arrive à la galerie.
            return {
              ...state,
              unlocked: true,
              unlockedAt: existing.toDate().toISOString(),
              current: state.target,
            };
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

        // `publicProfiles.galleryCount` se rafraîchit ici, et nulle part
        // ailleurs. Il alimente le tri des profils suggérés et le sous-titre
        // « N vus » des listes du Hall ; le compte exact, lui, reste calculé à
        // la volée par `getPublicProfile`.
        //
        // Ici plutôt que dans `setMediaStatus` et `recordSwipes` : ces deux
        // fonctions écrivent sans lire, et leur faire tenir un compteur juste
        // demanderait de relire l'état de chaque film avant de l'écrire. Cette
        // fonction, elle, a déjà la galerie entière en main, et le client
        // l'appelle à l'ouverture puis à chaque changement de galerie
        // (`BadgesViewModel.checkForNewAchievements`) : le compteur suit donc
        // les ajouts de près, sans qu'aucun chemin d'écriture ait à y penser.
        //
        // Conditionné à l'existence du profil : tout le monde n'a pas réservé
        // de pseudo, et un `set` créerait ici un profil fantôme sans identité.
        if (publicProfileSnap.exists &&
            publicProfileSnap.get('galleryCount') !== gallerySnap.size) {
          batch.update(publicProfileRef, {galleryCount: gallerySnap.size});
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

        // Le seul point d'entrée qui ne peut pas être authentifié : il est
        // appelé pendant la saisie, avant que le compte n'existe. C'est donc
        // l'attestation seule qui le protège de l'énumération de pseudos.
        if (!await passesAppCheck(req, res)) return;

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
        // Le profil public d'un ami se lit dans *votre* langue, pas dans la
        // sienne : c'est votre requête qui la porte.
        const language = requestedLanguage(req, res);
        const names = GENRE_LABELS[language] ?? GENRE_LABELS[DEFAULT_LANGUAGE];
        const labels = REASON_LABELS[language] ??
          REASON_LABELS[DEFAULT_LANGUAGE];
        const genres = top.map(([id, n]) => ({
          id,
          name: names[id] ?? `Genre ${id}`,
          share: total > 0 ? n / total : 0,
        }));
        const remainder = ranked.slice(PUBLIC_PROFILE_GENRES)
            .reduce((sum, [, n]) => sum + n, 0);
        if (remainder > 0 && total > 0) {
          genres.push({
            id: -1,
            name: labels.otherGenres,
            share: remainder / total,
          });
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
