/* ===================================================================== *
 *  CinéMatch : les règles communes aux deux moteurs
 *
 *  Ce qui reste du moteur v2 depuis que les cinq se notent par la fiche
 *  (`fiche.ts`) et par la carte (`carte/`) : les filtres durs de la soirée
 *  et leur élargissement, le repos d'un film déjà montré, la règle de la
 *  famille, l'accord d'une série avec le temps qu'on veut lui donner, et le
 *  tirage déterministe. Le score à huit axes, ses poids appris sur les
 *  comparaisons de la Porte et la composition des cinq sont partis avec
 *  `getCineMatchFive` (18 octobre 2026).
 *
 *  Module pur : aucune dépendance Firebase, aucun appel réseau.
 * ===================================================================== */

/** Les huit axes, dans l'ordre de la spec de l'espace commun. */
export const ENGINE_AXES =
  ['ch', 'ry', 'fa', 'de', 'an', 'to', 'ec', 'in'] as const;
export type EngineAxis = typeof ENGINE_AXES[number];
export type EngineAxes = Record<EngineAxis, number>;

/** Un film candidat, tel que le moteur le lit. */
export interface EngineFilm {
  id: number;
  axes: EngineAxes;
  genreIds: number[];
  year: number | null;
  voteCount: number | null;
  /** La durée du film, ou celle d'un épisode pour une série. */
  runtime: number | null;
  providerIds: number[];
  keywordNames: string[];
  listed: boolean;
  certification: string | null;
  /** Séries seulement : saisons sorties. */
  seasonCount?: number | null;
  /** Séries seulement : épisodes de ces saisons. */
  episodeCount?: number | null;
  /** Séries seulement : terminée, en cours, annulée. */
  status?: SeriesStatus | null;
}

/**
 * Le moteur des séries est le moteur des films, avec trois différences : on
 * choisit dans quoi s'engager et non une soirée, une série peut ne pas avoir
 * de fin, et essayer ne coûte qu'un épisode. Tout ce qui suit est optionnel :
 * absent, le moteur rend exactement ce qu'il rendait pour un film.
 */
export type SeriesStatus = 'ended' | 'returning' | 'canceled';

/**
 * Le temps total qu'on accepte de donner à une série. Il remplace l'énergie,
 * qui règle une soirée : une série ne se choisit pas pour une soirée.
 */
export type Engagement = 'mini' | 'season' | 'long' | 'any';

/** Un film de la galerie, vu, positionné. */
export interface EngineGalleryFilm {
  id: number;
  axes: EngineAxes;
  genreIds: number[];
  loved: boolean;
  /** Dernière apparition en affiche de comparaison, en millisecondes. */
  posterLastShownAt: number | null;
}

export type Company = 'alone' | 'duo' | 'family';
export type Duration = 'short' | 'medium' | 'long' | 'any';

export interface Situation {
  company: Company;
  /** La durée du film, ou celle d'un épisode quand `kind` vaut `series`. */
  duration: Duration;
  /** Identifiants de plateformes TMDB, en chaîne. Vide = pas de filtre. */
  platformIds: string[];
  /** Absent : un film. */
  kind?: 'film' | 'series';
}

/** Ce que le journal d'exposition sait d'un film, dates en millisecondes. */
export interface ExposureRecord {
  shownCount: number;
  lastShownAt: number | null;
  chosenAt: number | null;
}

/** Ce qui a été élargi pour trouver assez de films. */
export interface Widening {
  duration: boolean;
  platforms: boolean;
}

/* --------------------------------------------------------------------- *
 *  Les constantes
 * --------------------------------------------------------------------- */

/** La pénalité maximale d'un film montré, et sa décroissance en jours. */
const EXPOSURE_PENALTY = 1.2;
const EXPOSURE_DECAY_DAYS = 7;
/** Au-delà, un film montré ne pèse plus rien. */
export const EXPOSURE_MEMORY_DAYS = 14;
/** Un film montré deux fois et jamais choisi se repose ce nombre de jours. */
const EXPOSURE_REST_DAYS = 5;

const DAY_MS = 24 * 3600 * 1000;

/** Ce que pèse l'accord avec l'engagement demandé, en unités brutes. */
const ENGAGEMENT_WEIGHT = 1.0;
/**
 * Une histoire qui s'arrête sans fin. On la pénalise franchement quand on
 * cherche à s'engager ; à peine quand on veut « une saison pour voir ».
 */
const CANCELED_PENALTY = 0.8;
const CANCELED_PENALTY_TRIAL = 0.3;
/** Une histoire qui a sa fin, un peu plus quand on cherche à durer. */
const ENDED_BONUS = 0.2;
const ENDED_BONUS_LONG = 0.4;
/** Au-delà, une mini-série n'en est plus une. */
const MINI_MAX_HOURS = 8;
/** Une longue histoire, en saisons sorties. */
const LONG_MIN_SEASONS = 3;
/** Le pas d'élargissement de la durée d'un épisode, en minutes. */
const SERIES_WIDEN_STEP = 10;
const GENRE_HORROR = 27;
/** Les classifications écartées quand on regarde en famille. */
const FAMILY_BLOCKED_CERTIFICATIONS = new Set(['16', '18']);

/**
 * Vrai si un film peut se regarder en famille : pas d'horreur, pas de
 * classification 16 ou 18. Les classifications TV françaises s'écrivent
 * parfois « -16 » : seuls les chiffres comptent. Pour un film (« U »,
 * « 12 », « 16 »), rien ne change.
 * @param {number[]} genreIds Genres TMDB.
 * @param {?string} certification Classification.
 * @return {boolean} Vrai si le film passe.
 */
export function familyAllows(
    genreIds: number[], certification: string | null,
): boolean {
  if (genreIds.includes(GENRE_HORROR)) return false;
  const digits = (certification ?? '').replace(/[^0-9]/g, '');
  return !FAMILY_BLOCKED_CERTIFICATIONS.has(digits);
}

/* --------------------------------------------------------------------- *
 *  Filtres durs et élargissement
 * --------------------------------------------------------------------- */

/** Ce que les filtres doivent savoir de la soirée. */
export interface FilterContext {
  situation: Situation;
  /** Films à écarter d'office : la galerie, déjà vue. */
  excludedIds: Set<number>;
  exposure: Map<number, ExposureRecord>;
  now: number;
}

/** Le résultat des filtres. */
export interface FilterResult {
  eligible: EngineFilm[];
  /** Les éligibles qui passaient le filtre d'origine, sans élargissement. */
  conforming: Set<number>;
  widened: Widening | null;
}

/** En deçà, on élargit. */
const WIDEN_BELOW = 3;
/** Le pas d'élargissement de la durée, de chaque côté, et le nombre de pas. */
const WIDEN_DURATION_STEP = 15;
const WIDEN_DURATION_STEPS = 4;
/**
 * L'élargissement de durée le plus large, en minutes. Le vivier TMDB s'en
 * sert pour aller chercher, quand il le faut, de quoi élargir vraiment.
 */
export const DURATION_WIDEN_MAX_MINUTES =
  WIDEN_DURATION_STEP * WIDEN_DURATION_STEPS;
/** La même chose pour la durée d'un épisode. */
export const SERIES_DURATION_WIDEN_MAX_MINUTES =
  SERIES_WIDEN_STEP * WIDEN_DURATION_STEPS;

/**
 * Vrai si un film montré trop souvent doit se reposer : deux apparitions,
 * jamais choisi, la dernière il y a moins de cinq jours. Le proposer une
 * troisième fois dirait qu'on n'a rien retenu.
 * @param {ExposureRecord | undefined} record Journal du film.
 * @param {number} now Instant présent.
 * @return {boolean} Vrai si le film est exclu.
 */
export function isResting(
    record: ExposureRecord | undefined, now: number,
): boolean {
  if (!record || record.shownCount < 2 || record.chosenAt !== null) {
    return false;
  }
  if (record.lastShownAt === null) return false;
  return (now - record.lastShownAt) / DAY_MS < EXPOSURE_REST_DAYS;
}

/**
 * Vrai si le film tient dans la durée demandée, élargie de `steps` pas.
 * Un film sans durée ne passe jamais quand une durée est demandée : mieux
 * vaut un film de moins qu'une soirée qui déborde.
 * @param {number | null} runtime Durée du film, en minutes.
 * @param {Duration} duration Durée demandée.
 * @param {number} steps Pas d'élargissement.
 * @param {string} kind `series` pour la durée d'un épisode.
 * @return {boolean} Vrai si le film convient.
 */
function fitsDuration(
    runtime: number | null, duration: Duration, steps: number,
    kind?: 'film' | 'series',
): boolean {
  if (duration === 'any') return true;
  if (runtime === null || !(runtime > 0)) return false;
  if (kind === 'series') {
    // La durée d'un épisode : moins d'une demi-heure, autour de trois quarts
    // d'heure, une heure et plus. Le pas d'élargissement est de dix minutes :
    // un épisode de 40 minutes un soir « court » déborde déjà.
    const seriesSlack = steps * SERIES_WIDEN_STEP;
    if (duration === 'short') return runtime <= 35 + seriesSlack;
    if (duration === 'long') return runtime >= 55 - seriesSlack;
    return runtime >= 30 - seriesSlack && runtime <= 60 + seriesSlack;
  }
  const slack = steps * WIDEN_DURATION_STEP;
  if (duration === 'short') return runtime < 90 + slack;
  if (duration === 'long') return runtime > 120 - slack;
  return runtime >= 90 - slack && runtime <= 120 + slack;
}

/**
 * Les filtres durs, puis l'élargissement par paliers s'il reste moins de
 * trois films.
 *
 * L'ordre des paliers dit ce qui compte le plus : la durée cède d'abord,
 * quart d'heure par quart d'heure, parce qu'un film de 1 h 45 un soir
 * « moins d'1 h 30 » reste une soirée tenable ; les plateformes cèdent
 * ensuite, parce qu'un film qui n'est pas chez soi coûte un abonnement. Le
 * palier « plateformes » repart de la durée d'origine : on n'élargit
 * jamais deux choses quand une seule suffit.
 * @param {EngineFilm[]} films Le vivier.
 * @param {FilterContext} ctx La soirée.
 * @return {FilterResult} Les éligibles et ce qui a été élargi.
 */
export function applyFilters(
    films: EngineFilm[], ctx: FilterContext,
): FilterResult {
  const {situation} = ctx;
  const platforms = new Set(
      situation.platformIds
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id)),
  );

  // Ce qui ne s'élargit jamais : le déjà-vu, le repos d'exposition, et ce
  // qu'on ne montre pas à des enfants.
  const base = films.filter((film) => {
    if (!Number.isFinite(film.id) || film.id <= 0) return false;
    if (ctx.excludedIds.has(film.id)) return false;
    if (isResting(ctx.exposure.get(film.id), ctx.now)) return false;
    if (situation.company === 'family' &&
        !familyAllows(film.genreIds, film.certification)) {
      return false;
    }
    return true;
  });

  const onPlatform = (film: EngineFilm): boolean =>
    platforms.size === 0 ||
    film.providerIds.some((id) => platforms.has(id));
  const pass = (steps: number, anyPlatform: boolean): EngineFilm[] =>
    base.filter((film) =>
      fitsDuration(film.runtime, situation.duration, steps, situation.kind) &&
      (anyPlatform || onPlatform(film)));

  const strict = pass(0, false);
  const conforming = new Set(strict.map((film) => film.id));
  if (strict.length >= WIDEN_BELOW) {
    return {eligible: strict, conforming, widened: null};
  }

  const durationSteps = situation.duration === 'any' ?
    [] : Array.from({length: WIDEN_DURATION_STEPS}, (_, i) => i + 1);
  let last = strict;
  let widened: Widening = {duration: false, platforms: false};

  for (const steps of durationSteps) {
    last = pass(steps, false);
    widened = {duration: true, platforms: false};
    if (last.length >= WIDEN_BELOW) {
      return {eligible: last, conforming, widened};
    }
  }

  if (platforms.size > 0) {
    for (const steps of [0, ...durationSteps]) {
      last = pass(steps, true);
      widened = {duration: steps > 0, platforms: true};
      if (last.length >= WIDEN_BELOW) break;
    }
  }

  // Même élargi à fond, on rend ce qu'on a : deux films valent mieux
  // qu'une erreur. Seul un vivier vide fera dire « rien » à l'appelant.
  const somethingChanged = widened.duration || widened.platforms;
  return {
    eligible: last,
    conforming,
    widened: somethingChanged && last.length > 0 ? widened : null,
  };
}

/* --------------------------------------------------------------------- *
 *  Ce qui décale une note
 * --------------------------------------------------------------------- */

/**
 * La pénalité d'exposition : un film montré récemment recule, d'autant
 * plus que c'était récent. Le remontrer tout de suite dirait qu'on n'a pas
 * vu qu'il n'a pas été choisi.
 * @param {ExposureRecord | undefined} record Journal du film.
 * @param {number} now Instant présent.
 * @return {number} Pénalité, positive.
 */
export function exposurePenalty(
    record: ExposureRecord | undefined, now: number,
): number {
  if (!record || record.lastShownAt === null) return 0;
  const days = Math.max(0, (now - record.lastShownAt) / DAY_MS);
  if (days >= EXPOSURE_MEMORY_DAYS) return 0;
  return EXPOSURE_PENALTY * Math.exp(-days / EXPOSURE_DECAY_DAYS);
}

/**
 * Le temps total d'une série, en heures. Sans durée d'épisode, trois quarts
 * d'heure : c'est la durée la plus courante d'une fiction.
 * @param {EngineFilm} film La série.
 * @return {number} Heures.
 */
function seriesHours(film: EngineFilm): number {
  return ((film.episodeCount ?? 0) * (film.runtime ?? 45)) / 60;
}

/**
 * L'accord d'une série avec l'engagement demandé.
 * @param {EngineFilm} film La série.
 * @param {?Engagement} engagement Le temps total accepté.
 * @return {number} Positif si elle tient, négatif sinon.
 */
export function engagementFit(
    film: EngineFilm, engagement: Engagement | null | undefined,
): number {
  if (!engagement || engagement === 'any' || engagement === 'season') return 0;
  const seasons = film.seasonCount ?? 0;
  if (engagement === 'mini') {
    const oneShot = seasons === 1 && film.status !== 'returning';
    const hours = seriesHours(film);
    if (oneShot || (hours > 0 && hours <= MINI_MAX_HOURS)) {
      return ENGAGEMENT_WEIGHT;
    }
    return -ENGAGEMENT_WEIGHT * (hours > 20 ? 1 : 0.5);
  }
  return seasons >= LONG_MIN_SEASONS ?
    ENGAGEMENT_WEIGHT : -0.6 * ENGAGEMENT_WEIGHT;
}

/**
 * Ce que le statut d'une série change : une histoire annulée recule, une
 * histoire terminée avance un peu.
 * @param {EngineFilm} film La série.
 * @param {?Engagement} engagement Le temps total accepté.
 * @return {number} Décalage brut.
 */
export function statusTerm(
    film: EngineFilm, engagement: Engagement | null | undefined,
): number {
  if (film.status === 'canceled') {
    return engagement === 'season' || engagement === 'mini' ?
      -CANCELED_PENALTY_TRIAL : -CANCELED_PENALTY;
  }
  if (film.status === 'ended') {
    return engagement === 'long' ? ENDED_BONUS_LONG : ENDED_BONUS;
  }
  return 0;
}

/* --------------------------------------------------------------------- *
 *  Le tirage
 * --------------------------------------------------------------------- */

/**
 * Hachage FNV-1a d'une chaîne, sur 32 bits.
 * @param {string} text Texte.
 * @return {number} Empreinte.
 */
function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Un générateur pseudo-aléatoire déterministe (mulberry32). Un tirage
 * dépend de sa graine (la personne, le jour, la soirée) : rouvrir l'écran
 * rend les mêmes films, le lendemain en rend d'autres.
 * @param {string} key Graine.
 * @return {function(): number} Tirage sur [0, 1).
 */
export function seededRandom(key: string): () => number {
  let state = hashString(key);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
