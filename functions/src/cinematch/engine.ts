/* ===================================================================== *
 *  CinéMatch v2 : le moteur
 *
 *  Module pur. Aucune dépendance Firebase, aucun appel réseau : des films
 *  en entrée, un classement en sortie. C'est ce qui permet de le vérifier
 *  avec Node seul, sur un catalogue synthétique, avant qu'il ne serve une
 *  vraie soirée. Les points d'entrée de `index.ts` construisent les
 *  entrées (vivier TMDB, galerie positionnée, journal d'exposition,
 *  watchlist) et ne font rien d'autre que les passer ici.
 *
 *  Les attributs des films sont déduits des huit axes existants et des
 *  mots-clés TMDB. Pas d'IA : tout ce qui décide ici se relit.
 * ===================================================================== */

/** Les huit axes, dans l'ordre de la spec de l'espace commun. */
export const ENGINE_AXES =
  ['ch', 'ry', 'fa', 'de', 'an', 'to', 'ec', 'in'] as const;
export type EngineAxis = typeof ENGINE_AXES[number];
export type EngineAxes = Record<EngineAxis, number>;

/**
 * Les axes qui disent ce qu'un film fait vivre. `in` (la durée) en est
 * écarté partout où l'on compare deux films : deux soirées ne se
 * ressemblent pas parce qu'elles durent pareil, et la durée a déjà son
 * filtre dur.
 */
const TASTE_AXES: EngineAxis[] =
  ['ch', 'ry', 'fa', 'de', 'an', 'to', 'ec'];

/** Un film candidat, tel que le moteur le lit. */
export interface EngineFilm {
  id: number;
  axes: EngineAxes;
  genreIds: number[];
  year: number | null;
  voteCount: number | null;
  runtime: number | null;
  providerIds: number[];
  keywordNames: string[];
  listed: boolean;
  certification: string | null;
}

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
export type Want =
  'light' | 'soft' | 'suspense' | 'think' | 'feelgood' | 'everyone';
export type Energy = 'low' | 'high';

export interface Situation {
  company: Company;
  duration: Duration;
  /** Identifiants de plateformes TMDB, en chaîne. Vide = pas de filtre. */
  platformIds: string[];
}

export type Comparison =
  { kind: 'pick'; keptId: number; excludedId: number; latencyMs: number } |
  { kind: 'none'; shownIds: number[] };

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
 *  Attributs dérivés
 * --------------------------------------------------------------------- */

/**
 * Les mots-clés qui disent qu'un film finit bien ou fait du bien. Noms TMDB
 * en anglais, comparés en minuscules. Le ton des axes dit « chaleureux »,
 * pas « heureux » : un film tendre peut finir mal, et seuls les mots-clés
 * portent cette différence.
 */
const HAPPY_KEYWORDS = [
  'feel-good', 'happy ending', 'hope', 'redemption', 'friendship',
];

/** Les mots-clés d'une fin ou d'un sujet qui pèse. */
const SAD_KEYWORDS = ['tragedy', 'death', 'grief', 'suicide'];

/**
 * Les mots-clés de « quelqu'un s'en sort ». C'est ce que cherche la
 * personne qui veut se remonter le moral, et le ton seul ne le dit pas :
 * une comédie légère n'est pas une histoire d'espoir.
 */
const HOPE_KEYWORDS = [
  'hope', 'redemption', 'inspirational', 'underdog',
  'overcoming adversity',
];

/** Les attributs d'un film, sur 0..1 (et deux drapeaux). */
export interface Features {
  /** Exigence cognitive : la densité. */
  cog: number;
  /** Exigence affective : la charge. */
  aff: number;
  /** Tension : le rythme. */
  ten: number;
  /** Amusement : chaleureux et léger à la fois. */
  fun: number;
  happy: number;
  hope: number;
  /** Découverte : un film peu connu, donc un pari. */
  bet: boolean;
  /** Un film lourd. */
  heavy: boolean;
}

/**
 * Borne une valeur dans [0, 1].
 * @param {number} value Valeur.
 * @return {number} Valeur bornée.
 */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Vrai si le film porte au moins un des mots-clés de la liste.
 * @param {Set<string>} names Mots-clés du film, en minuscules.
 * @param {string[]} list Liste de référence.
 * @return {number} 1 si un mot est présent, 0 sinon.
 */
function hasKeyword(names: Set<string>, list: string[]): number {
  return list.some((word) => names.has(word)) ? 1 : 0;
}

/**
 * Les attributs dérivés d'un film, lus sur ses axes et ses mots-clés.
 * @param {Object} film Le film : ses axes et ses mots-clés.
 * @param {EngineAxes} film.axes Position sur les huit axes.
 * @param {string[]} film.keywordNames Mots-clés TMDB.
 * @return {Features} Attributs sur 0..1.
 */
export function features(
    film: {axes: EngineAxes; keywordNames?: string[]},
): Features {
  const a = film.axes;
  const names = new Set(
      (film.keywordNames ?? []).map((name) => name.toLowerCase()),
  );
  const warmth = (a.to + 1) / 2;
  return {
    cog: (a.de + 1) / 2,
    aff: (a.ch + 1) / 2,
    ten: (a.ry + 1) / 2,
    fun: clamp01(((a.to - a.ch) / 2 + 1) / 2),
    happy: clamp01(warmth + 0.25 * hasKeyword(names, HAPPY_KEYWORDS) -
      0.25 * hasKeyword(names, SAD_KEYWORDS)),
    hope: hasKeyword(names, HOPE_KEYWORDS) ? 1 : clamp01(warmth - 0.2),
    bet: a.fa > 0.25,
    heavy: a.ch > 0.5,
  };
}

/* --------------------------------------------------------------------- *
 *  Les réponses, en poids
 * --------------------------------------------------------------------- */

type FeatureKey = 'cog' | 'aff' | 'ten' | 'fun' | 'happy' | 'hope';
type FeatureWeights = Partial<Record<FeatureKey, number>>;

/**
 * Ce que chaque envie demande aux attributs, en unités d'écart. Repris du
 * prototype, puis décorrélé de l'énergie : l'envie dit le genre de soirée,
 * elle ne dit plus combien on a de forces pour elle.
 */
export const WANT_WEIGHTS: Record<Want, FeatureWeights> = {
  light: {fun: 1.2, cog: -0.8, aff: -0.6, ten: 0.4},
  soft: {fun: 0.6, cog: -0.5, aff: -0.9, ten: -0.8, happy: 0.8},
  suspense: {ten: 1.2, aff: 0.6, fun: 0.2},
  think: {cog: 1.3, aff: 0.3, fun: -0.3},
  feelgood: {hope: 1.2, happy: 0.7, fun: 0.4, aff: -0.2},
  // Seulement à plusieurs : seul, « plaire à tout le monde » ne veut rien
  // dire, et la réponse est ignorée.
  everyone: {fun: 0.9, ten: 0.3, aff: -0.3},
};

/**
 * L'énergie ne règle que l'exigence (cog, aff) et la part de découverte.
 * Elle reste ainsi orthogonale à l'envie : « du suspense » fatigué reste du
 * suspense, simplement plus facile à suivre.
 */
export const ENERGY_WEIGHTS: Record<
  Energy, {cog: number; aff: number; novelty: number}
> = {
  low: {cog: -0.6, aff: -0.5, novelty: -0.15},
  high: {cog: 0.3, aff: 0.2, novelty: 0.25},
};

/**
 * Devoir contre envie (Milkman, Rogers & Bazerman 2009), par genre TMDB.
 * Positif : le film qu'on se promet de voir un jour. Négatif : celui qu'on
 * a envie de lancer ce soir. La note publique en est retirée à dessein :
 * elle récompensait les films qu'on admire sans avoir envie de les voir.
 */
const SMW_GENRE: Record<number, number> = {
  18: 0.48, 35: -0.83, 53: -0.60, 28: -1.0, 10749: -0.30, 80: -0.73,
  12: -0.80, 878: -0.67, 14: -0.70, 10751: -0.90, 16: -0.90,
  99: 0.60, 36: 0.50, 10752: 0.40,
};
/** Ce qu'une année d'âge ajoute au devoir. */
const SMW_PER_YEAR = 0.0216;

/** Les poids des termes standardisés. */
const TERM_WEIGHTS = {
  taste: 1.0, learned: 1.0, want: 1.0, energy: 0.5, duty: -0.5,
};
/** L'avantage d'un film de la watchlist, hors standardisation. */
const LISTED_BONUS = 0.3;
/** La pénalité maximale d'un film montré, et sa décroissance en jours. */
const EXPOSURE_PENALTY = 1.2;
const EXPOSURE_DECAY_DAYS = 7;
/** Au-delà, un film montré ne pèse plus rien. */
export const EXPOSURE_MEMORY_DAYS = 14;
/** Un film montré deux fois et jamais choisi se repose ce nombre de jours. */
const EXPOSURE_REST_DAYS = 5;
/** Ce que les hésitations poussent vers le sûr, au plus. */
const CONSERVATISM_WEIGHT = 0.35;
/** L'avance d'un film qui passait le filtre d'origine, quand on élargit. */
const CONFORMING_BONUS = 3;
/** Le bonus de genre commun dans la similarité à un coup de cœur. */
const TASTE_GENRE_BONUS = 0.14;
/** L'amplitude du prior tiré des coups de cœur. */
const PRIOR_SCALE = 0.9;
/** Le pas d'apprentissage d'une comparaison. */
const LEARNING_RATE = 0.8;

const DAY_MS = 24 * 3600 * 1000;
const GENRE_HORROR = 27;
/** Les classifications écartées quand on regarde en famille. */
const FAMILY_BLOCKED_CERTIFICATIONS = new Set(['16', '18']);

/* --------------------------------------------------------------------- *
 *  Similarités et poids appris
 * --------------------------------------------------------------------- */

/**
 * Ressemblance de deux films : 1 − distance L1 sur les sept axes de goût,
 * ramenée à 0..1 (chaque axe court sur une amplitude de 2).
 * @param {EngineAxes} a Premier film.
 * @param {EngineAxes} b Second film.
 * @return {number} Similarité, 1 = identiques.
 */
export function filmSimilarity(a: EngineAxes, b: EngineAxes): number {
  let distance = 0;
  for (const axis of TASTE_AXES) distance += Math.abs(a[axis] - b[axis]);
  return 1 - distance / 14;
}

/**
 * Un vecteur nul sur les huit axes.
 * @return {EngineAxes} Zéros.
 */
function zeroAxes(): EngineAxes {
  return {ch: 0, ry: 0, fa: 0, de: 0, an: 0, to: 0, ec: 0, in: 0};
}

/**
 * Position moyenne d'un ensemble de films.
 * @param {EngineAxes[]} list Positions.
 * @return {EngineAxes} Moyenne par axe, zéros si la liste est vide.
 */
function meanAxes(list: EngineAxes[]): EngineAxes {
  const out = zeroAxes();
  if (list.length === 0) return out;
  for (const axes of list) {
    for (const axis of ENGINE_AXES) out[axis] += axes[axis];
  }
  for (const axis of ENGINE_AXES) out[axis] /= list.length;
  return out;
}

/**
 * Le multiplicateur de latence d'une comparaison (Konovalov 2019) : un
 * geste rapide dit une préférence nette, un geste lent une hésitation.
 * @param {number} latencyMs Latence du geste.
 * @return {number} Multiplicateur.
 */
function latencyFactor(latencyMs: number): number {
  if (!Number.isFinite(latencyMs)) return 1;
  if (latencyMs < 900) return 1.25;
  if (latencyMs < 2500) return 1;
  return 0.55;
}

/**
 * Les poids appris de la soirée : un prior tiré des coups de cœur, puis
 * chaque comparaison jouée.
 *
 * Le prior mesure l'écart entre ce qu'on a adoré et ce qu'on a sous la
 * main : il dit dans quelle direction chercher parmi CES films, pas dans
 * l'absolu. Sans coup de cœur il est nul, et c'est voulu : un prior tiré
 * de la galerie entière apprendrait « ce que tu regardes », qui n'est pas
 * « ce que tu aimes ».
 *
 * Aucune borne sur les poids : mesuré sur le banc d'essai, une borne à
 * ±0.6 annulait précisément le gain des comparaisons. « Aucun des quatre »
 * ne bouge rien : ne pas avoir envie de quatre films ne dit pas de quel
 * côté aller.
 * @param {EngineAxes[]} loved Positions des coups de cœur.
 * @param {EngineAxes[]} reference Positions des films de référence.
 * @param {Comparison[]} comparisons Comparaisons de la soirée, dans l'ordre.
 * @param {Map<number, EngineAxes>} axesById Positions des films comparés.
 * @return {EngineAxes} Poids par axe.
 */
export function buildWeights(
    loved: EngineAxes[],
    reference: EngineAxes[],
    comparisons: Comparison[],
    axesById: Map<number, EngineAxes>,
): EngineAxes {
  const weights = zeroAxes();
  if (loved.length > 0) {
    const lovedMean = meanAxes(loved);
    const referenceMean = meanAxes(reference);
    for (const axis of ENGINE_AXES) {
      weights[axis] = PRIOR_SCALE * (lovedMean[axis] - referenceMean[axis]);
    }
  }
  for (const comparison of comparisons) {
    if (comparison.kind !== 'pick') continue;
    const kept = axesById.get(comparison.keptId);
    const excluded = axesById.get(comparison.excludedId);
    if (!kept || !excluded) continue;
    const rate = LEARNING_RATE * latencyFactor(comparison.latencyMs);
    for (const axis of ENGINE_AXES) {
      weights[axis] += rate * (kept[axis] - excluded[axis]) / 2;
    }
  }
  return weights;
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
 * @return {boolean} Vrai si le film convient.
 */
function fitsDuration(
    runtime: number | null, duration: Duration, steps: number,
): boolean {
  if (duration === 'any') return true;
  if (runtime === null || !(runtime > 0)) return false;
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
    if (situation.company === 'family') {
      if (film.genreIds.includes(GENRE_HORROR)) return false;
      if (FAMILY_BLOCKED_CERTIFICATIONS.has(film.certification ?? '')) {
        return false;
      }
    }
    return true;
  });

  const onPlatform = (film: EngineFilm): boolean =>
    platforms.size === 0 ||
    film.providerIds.some((id) => platforms.has(id));
  const pass = (steps: number, anyPlatform: boolean): EngineFilm[] =>
    base.filter((film) =>
      fitsDuration(film.runtime, situation.duration, steps) &&
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
 *  Le score
 * --------------------------------------------------------------------- */

/** Ce que le score doit savoir de la soirée. */
export interface ScoreContext {
  situation: Situation;
  want: Want | null;
  energy: Energy | null;
  hesitations: number;
  /** Les coups de cœur positionnés. */
  loved: {axes: EngineAxes; genreIds: number[]}[];
  weights: EngineAxes;
  exposure: Map<number, ExposureRecord>;
  now: number;
  /** Les films qui passaient le filtre d'origine, quand on a élargi. */
  conforming?: Set<number> | null;
}

/** Le détail d'un score, pour le journal et les vérifications. */
export interface ScoreTerms {
  taste: number;
  learned: number;
  want: number;
  energy: number;
  duty: number;
  listed: number;
  exposure: number;
  novelty: number;
  conservatism: number;
  conforming: number;
}

export interface ScoredFilm {
  film: EngineFilm;
  score: number;
  terms: ScoreTerms;
}

/**
 * Standardise une série (z-score). Une série constante rend des zéros : un
 * terme qui ne sépare aucun film ne doit rien peser, et surtout pas
 * diviser par zéro.
 * @param {number[]} values Valeurs brutes.
 * @return {number[]} Valeurs centrées réduites.
 */
function standardize(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / n;
  const sd = Math.sqrt(variance);
  if (!(sd > 1e-9)) return values.map(() => 0);
  return values.map((v) => (v - mean) / sd);
}

/**
 * Le goût durable d'un film : la moyenne de ses trois meilleures
 * ressemblances aux coups de cœur. Trois et non une : un film proche d'un
 * seul coup de cœur isolé est une coïncidence, proche de trois c'est un
 * goût.
 * @param {EngineFilm} film Le film.
 * @param {Object[]} loved Coups de cœur.
 * @return {number} Goût brut, 0 sans coup de cœur.
 */
function tasteOf(
    film: EngineFilm, loved: {axes: EngineAxes; genreIds: number[]}[],
): number {
  if (loved.length === 0) return 0;
  // Les trois meilleures, tenues à la main : trier toutes les similarités
  // coûterait un tri par film, soit l'essentiel du temps sur 3 000 films.
  const best = [-Infinity, -Infinity, -Infinity];
  for (const anchor of loved) {
    let sim = filmSimilarity(film.axes, anchor.axes);
    if (film.genreIds.some((id) => anchor.genreIds.includes(id))) {
      sim += TASTE_GENRE_BONUS;
    }
    if (sim > best[2]) {
      if (sim > best[0]) {
        best[2] = best[1]; best[1] = best[0]; best[0] = sim;
      } else if (sim > best[1]) {
        best[2] = best[1]; best[1] = sim;
      } else {
        best[2] = sim;
      }
    }
  }
  const kept = best.filter((v) => v > -Infinity);
  return kept.reduce((sum, v) => sum + v, 0) / kept.length;
}

/**
 * Σ w_k · (attribut_k − 0.5).
 * @param {Features} f Attributs du film.
 * @param {FeatureWeights} weights Poids.
 * @return {number} Contribution brute.
 */
function weightedFeatures(f: Features, weights: FeatureWeights): number {
  let total = 0;
  for (const [key, weight] of Object.entries(weights)) {
    total += (weight ?? 0) * (f[key as FeatureKey] - 0.5);
  }
  return total;
}

/**
 * Le devoir d'un film, avant la part du goût.
 * @param {EngineFilm} film Le film.
 * @param {number} currentYear Année en cours.
 * @return {number} Devoir brut, positif = plutôt un devoir.
 */
function smwOf(film: EngineFilm, currentYear: number): number {
  const genre = film.genreIds[0];
  const byGenre = genre !== undefined ? SMW_GENRE[genre] ?? 0 : 0;
  const age = film.year !== null ? Math.max(0, currentYear - film.year) : 0;
  return byGenre + age * SMW_PER_YEAR;
}

/**
 * La pénalité d'exposition : un film montré récemment recule, d'autant
 * plus que c'était récent. Le remontrer tout de suite dirait qu'on n'a pas
 * vu qu'il n'a pas été choisi.
 * @param {ExposureRecord | undefined} record Journal du film.
 * @param {number} now Instant présent.
 * @return {number} Pénalité, positive.
 */
function exposurePenalty(
    record: ExposureRecord | undefined, now: number,
): number {
  if (!record || record.lastShownAt === null) return 0;
  const days = Math.max(0, (now - record.lastShownAt) / DAY_MS);
  if (days >= EXPOSURE_MEMORY_DAYS) return 0;
  return EXPOSURE_PENALTY * Math.exp(-days / EXPOSURE_DECAY_DAYS);
}

/**
 * Classe les films éligibles.
 *
 * Les termes de goût et de soirée sont standardisés sur les éligibles
 * avant d'être pondérés : sans ça, le terme dont l'amplitude brute est la
 * plus grande déciderait seul, et les poids ne voudraient plus rien dire.
 * Les termes de circonstance (liste, exposition, découverte, hésitation)
 * restent en unités brutes : ce sont des décalages voulus, pas des
 * préférences à mettre en balance.
 * @param {EngineFilm[]} eligible Films éligibles.
 * @param {ScoreContext} ctx La soirée.
 * @return {ScoredFilm[]} Films classés, meilleur score en tête.
 */
export function scoreFilms(
    eligible: EngineFilm[], ctx: ScoreContext,
): ScoredFilm[] {
  const currentYear = new Date(ctx.now).getUTCFullYear();
  const feats = eligible.map((film) => features(film));
  const want = ctx.want === 'everyone' && ctx.situation.company === 'alone' ?
    null : ctx.want;
  const wantWeights = want ? WANT_WEIGHTS[want] : null;
  const energy = ctx.energy ? ENERGY_WEIGHTS[ctx.energy] : null;
  const hesitation = Math.min(1, Math.max(0, ctx.hesitations) / 4);
  const tasteBound = 1 + TASTE_GENRE_BONUS;

  const rawTaste = eligible.map((film) => tasteOf(film, ctx.loved));
  const rawLearned = eligible.map((film) => {
    let total = 0;
    for (const axis of ENGINE_AXES) {
      total += ctx.weights[axis] * film.axes[axis];
    }
    return total;
  });
  const rawWant = feats.map((f) =>
    wantWeights ? weightedFeatures(f, wantWeights) : 0);
  const rawEnergy = feats.map((f) => energy ?
    weightedFeatures(f, {cog: energy.cog, aff: energy.aff}) : 0);
  // Un pari est exempté du devoir : un film peu connu n'est pas « le
  // classique qu'on se doit de voir », c'est une découverte.
  const rawDuty = eligible.map((film, i) => feats[i].bet ? 0 :
    Math.max(0, smwOf(film, currentYear)) *
      (1 - clamp01(rawTaste[i] / tasteBound)));

  const zTaste = standardize(rawTaste);
  const zLearned = standardize(rawLearned);
  const zWant = standardize(rawWant);
  const zEnergy = standardize(rawEnergy);
  const zDuty = standardize(rawDuty);

  const scored = eligible.map((film, i) => {
    const bet = feats[i].bet;
    const terms: ScoreTerms = {
      taste: TERM_WEIGHTS.taste * zTaste[i],
      learned: TERM_WEIGHTS.learned * zLearned[i],
      want: TERM_WEIGHTS.want * zWant[i],
      energy: TERM_WEIGHTS.energy * zEnergy[i],
      duty: TERM_WEIGHTS.duty * zDuty[i],
      listed: film.listed ? LISTED_BONUS : 0,
      exposure: -exposurePenalty(ctx.exposure.get(film.id), ctx.now),
      novelty: energy && bet ? energy.novelty * 2 : 0,
      conservatism: CONSERVATISM_WEIGHT * hesitation * (bet ? -1 : 1),
      conforming: ctx.conforming && ctx.conforming.has(film.id) ?
        CONFORMING_BONUS : 0,
    };
    const score = Object.values(terms).reduce((sum, v) => sum + v, 0);
    return {film, score, terms};
  });
  return scored.sort((a, b) => b.score - a.score || a.film.id - b.film.id);
}

/* --------------------------------------------------------------------- *
 *  Les cinq
 * --------------------------------------------------------------------- */

/** Le poids de la ressemblance dans la composition (MMR). */
const MMR_SIMILARITY = 0.8;
/** Ce que coûte un troisième film du même genre principal. */
const THIRD_SAME_GENRE_PENALTY = 0.6;

/**
 * Compose les cinq : le meilleur film d'abord, puis, à chaque tour, celui
 * qui vaut le plus une fois retirée sa ressemblance aux films déjà pris.
 *
 * Cinq films proches ne font qu'un choix répété cinq fois. L'écart entre
 * eux est ce qui donne de la valeur au fait d'en proposer cinq, mais il ne
 * doit pas aller chercher loin dans le classement : le vivier de
 * composition s'arrête au haut du classement.
 * @param {ScoredFilm[]} ranked Films classés, meilleur en tête.
 * @param {number} count Nombre de films voulus.
 * @return {ScoredFilm[]} La sélection, dans l'ordre de présentation.
 */
export function composeFive(ranked: ScoredFilm[], count = 5): ScoredFilm[] {
  if (ranked.length === 0) return [];
  const poolSize = Math.max(26, Math.ceil(ranked.length * 0.4));
  const pool = ranked.slice(0, poolSize);
  const chosen: ScoredFilm[] = [pool[0]];
  const taken = new Set<number>([pool[0].film.id]);

  while (chosen.length < count) {
    let best: ScoredFilm | null = null;
    let bestValue = -Infinity;
    const hasListed = chosen.some((c) => c.film.listed);
    for (const candidate of pool) {
      if (taken.has(candidate.film.id)) continue;
      // Un seul film de la liste : les cinq sont le lieu où l'on découvre
      // aussi, la watchlist a déjà son onglet.
      if (candidate.film.listed && hasListed) continue;
      let closest = 0;
      for (const c of chosen) {
        closest = Math.max(
            closest, filmSimilarity(candidate.film.axes, c.film.axes));
      }
      const genre = candidate.film.genreIds[0];
      const sameGenre = genre === undefined ? 0 :
        chosen.filter((c) => c.film.genreIds[0] === genre).length;
      // Le deuxième film d'un genre est gratuit, le troisième se paie.
      const value = candidate.score - MMR_SIMILARITY * closest -
        (sameGenre >= 2 ? THIRD_SAME_GENRE_PENALTY : 0);
      if (value > bestValue) {
        bestValue = value;
        best = candidate;
      }
    }
    if (!best) break;
    chosen.push(best);
    taken.add(best.film.id);
  }
  return chosen;
}

/** Tout ce qu'il faut pour proposer des films. */
export interface RecommendInput {
  films: EngineFilm[];
  gallery: EngineGalleryFilm[];
  situation: Situation;
  want: Want | null;
  energy: Energy | null;
  comparisons: Comparison[];
  hesitations: number;
  exposure: Map<number, ExposureRecord>;
  now: number;
}

export interface Recommendation {
  films: ScoredFilm[];
  widened: Widening | null;
  eligibleCount: number;
  weights: EngineAxes;
}

/**
 * Le parcours complet : filtres, poids, score, composition.
 * @param {RecommendInput} input La soirée et son vivier.
 * @return {Recommendation} Les films proposés et ce qui a été élargi.
 */
export function recommendFive(input: RecommendInput): Recommendation {
  const excludedIds = new Set(input.gallery.map((film) => film.id));
  const filtered = applyFilters(input.films, {
    situation: input.situation,
    excludedIds,
    exposure: input.exposure,
    now: input.now,
  });
  const loved = input.gallery.filter((film) => film.loved);
  const axesById = new Map(input.gallery.map((film) => [film.id, film.axes]));
  const weights = buildWeights(
      loved.map((film) => film.axes),
      filtered.eligible.map((film) => film.axes),
      input.comparisons,
      axesById,
  );
  const ranked = scoreFilms(filtered.eligible, {
    situation: input.situation,
    want: input.want,
    energy: input.energy,
    hesitations: input.hesitations,
    loved,
    weights,
    exposure: input.exposure,
    now: input.now,
    conforming: filtered.widened ? filtered.conforming : null,
  });
  return {
    films: composeFive(ranked),
    widened: filtered.widened,
    eligibleCount: filtered.eligible.length,
    weights,
  };
}

export interface DailyPick {
  film: ScoredFilm | null;
  top: ScoredFilm[];
  widened: Widening | null;
}

/**
 * La proposition du jour : les cinq d'une soirée sans questions (le goût
 * et l'exposition seuls), et le film dont le rang suit le jour de l'année.
 * Tourner dans les cinq plutôt que prendre toujours le premier évite de
 * reproposer le même film tant que la galerie ne bouge pas.
 * @param {RecommendInput} input La soirée ; envie, énergie et comparaisons
 *   sont ignorées.
 * @param {number} dayOfYear Jour de l'année, 1 = 1er janvier.
 * @return {DailyPick} Le film du jour.
 */
export function pickDaily(input: RecommendInput, dayOfYear: number): DailyPick {
  const result = recommendFive({
    ...input, want: null, energy: null, comparisons: [], hesitations: 0,
  });
  const top = result.films;
  if (top.length === 0) return {film: null, top, widened: result.widened};
  const index = ((Math.floor(dayOfYear) % 5) + 5) % 5;
  return {
    film: top[index % top.length],
    top,
    widened: result.widened,
  };
}

/* --------------------------------------------------------------------- *
 *  Les comparaisons
 * --------------------------------------------------------------------- */

/** Au plus quatre comparaisons ; une par tranche de cinq films vus. */
export const COMPARISONS_MAX = 4;
const FILMS_PER_COMPARISON = 5;

/**
 * Combien de comparaisons la galerie permet ce soir. En deçà de cinq films
 * vus par comparaison, les mêmes affiches reviendraient d'un tour à
 * l'autre et la comparaison ne dirait plus rien.
 * @param {number} positionedCount Films vus positionnés.
 * @return {number} Nombre de comparaisons, 0 à 4.
 */
export function comparisonTotal(positionedCount: number): number {
  return Math.max(0, Math.min(COMPARISONS_MAX,
      Math.floor(positionedCount / FILMS_PER_COMPARISON)));
}

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
 * Un générateur pseudo-aléatoire déterministe (mulberry32). Le tirage des
 * affiches dépend de la personne, du jour et du tour : rouvrir l'écran
 * rend les mêmes affiches, le lendemain en rend d'autres.
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

/**
 * Tire `count` éléments distincts d'une liste.
 * @param {T[]} items Liste.
 * @param {number} count Nombre voulu.
 * @param {function(): number} random Tirage.
 * @return {T[]} Éléments tirés.
 */
function drawDistinct<T>(
    items: T[], count: number, random: () => number,
): T[] {
  const copy = [...items];
  const out: T[] = [];
  while (out.length < count && copy.length > 0) {
    const index = Math.floor(random() * copy.length);
    out.push(copy.splice(index, 1)[0]);
  }
  return out;
}

export interface PlanInput {
  gallery: EngineGalleryFilm[];
  /** Films déjà montrés pendant cette soirée, remplaçants compris. */
  shownIds: number[];
  history: Comparison[];
  round: number;
  /** Graine stable du jour : l'uid et la date. */
  seedKey: string;
  /**
   * La Porte : quand la galerie est épuisée, on reprend les films déjà
   * montrés, les plus anciens d'abord, au lieu de s'arrêter.
   */
  recycle: boolean;
}

export interface ComparisonPlan {
  axis: EngineAxis | null;
  films: EngineGalleryFilm[];
  /** Pour chacun des quatre, le film qui prend sa place s'il est gardé. */
  replacements: Map<number, EngineGalleryFilm>;
}

/** La part des films les moins récemment montrés qu'on garde, au moins 8. */
const PLAN_FRESH_SHARE = 0.6;
const PLAN_FRESH_MIN = 8;
/** La tranche de chaque extrémité de l'axe, au moins deux films. */
const PLAN_TAIL_SHARE = 0.2;

/**
 * Prépare une comparaison : quatre films vus, deux à chaque extrémité de
 * l'axe sur lequel on en sait le moins.
 *
 * L'axe choisi est celui où les coups de cœur varient le plus et où les
 * poids appris sont encore faibles : c'est là qu'une réponse apprend
 * quelque chose. Opposer deux films d'un bout à deux de l'autre rend la
 * réponse lisible, quel que soit le film gardé ou écarté.
 * @param {PlanInput} input Galerie, historique, tour.
 * @return {ComparisonPlan} Les quatre films et leurs remplaçants.
 */
export function planComparison(input: PlanInput): ComparisonPlan {
  const empty: ComparisonPlan = {
    axis: null, films: [], replacements: new Map(),
  };
  const shown = new Set(input.shownIds);
  const byRecency = (a: EngineGalleryFilm, b: EngineGalleryFilm): number => {
    // Jamais montré en tête ; puis du plus ancien au plus récent.
    const ta = a.posterLastShownAt ?? -Infinity;
    const tb = b.posterLastShownAt ?? -Infinity;
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.id - b.id;
  };

  let available = input.gallery
      .filter((film) => !shown.has(film.id))
      .sort(byRecency);
  if (input.recycle && available.length < PLAN_FRESH_MIN) {
    // Les films déjà montrés ce soir reviennent dans l'ordre où ils sont
    // passés : le premier montré est le moins récent.
    const byId = new Map(input.gallery.map((film) => [film.id, film]));
    const order = new Map(input.shownIds.map((id, i) => [id, i]));
    const recycled = [...shown]
        .map((id) => byId.get(id))
        .filter((film): film is EngineGalleryFilm => film !== undefined)
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    available = [...available, ...recycled];
  }
  if (available.length < 4) return empty;

  const keep = Math.min(available.length, Math.max(
      PLAN_FRESH_MIN, Math.ceil(available.length * PLAN_FRESH_SHARE)));
  const fresh = available.slice(0, keep);

  const loved = input.gallery.filter((film) => film.loved);
  const axesById = new Map(input.gallery.map((film) => [film.id, film.axes]));
  const weights = buildWeights(
      loved.map((film) => film.axes),
      input.gallery.map((film) => film.axes),
      input.history,
      axesById,
  );
  // Un seul coup de cœur n'a pas de variance : on lit alors la galerie.
  const spread = loved.length >= 2 ? loved : input.gallery;
  let axis: EngineAxis = TASTE_AXES[0];
  let bestValue = -Infinity;
  for (const candidate of TASTE_AXES) {
    const values = spread.map((film) => film.axes[candidate]);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance =
      values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / values.length;
    const value = variance / (1 + Math.abs(weights[candidate]));
    if (value > bestValue) {
      bestValue = value;
      axis = candidate;
    }
  }

  const sorted = [...fresh].sort((a, b) =>
    a.axes[axis] - b.axes[axis] || a.id - b.id);
  const tail = Math.min(
      Math.floor(sorted.length / 2),
      Math.max(2, Math.ceil(sorted.length * PLAN_TAIL_SHARE)));
  const low = sorted.slice(0, tail);
  const high = sorted.slice(sorted.length - tail);

  const random = seededRandom(`${input.seedKey}#${input.round}`);
  const picked = [
    ...drawDistinct(low, 2, random),
    ...drawDistinct(high, 2, random),
  ];
  const films = drawDistinct(picked, picked.length, random);
  const chosenIds = new Set(films.map((film) => film.id));

  // Le remplaçant se cherche d'abord parmi les films frais, puis dans tout
  // ce qui reste : il vaut mieux un film un peu récent qu'un trou.
  const spares = fresh.filter((film) => !chosenIds.has(film.id));
  const fallback = available.filter((film) => !chosenIds.has(film.id));
  const replacementPool = spares.length > 0 ? spares : fallback;
  const replacements = new Map<number, EngineGalleryFilm>();
  for (const film of films) {
    if (replacementPool.length === 0) break;
    const others = films.filter((other) => other.id !== film.id);
    const mean =
      others.reduce((s, other) => s + other.axes[axis], 0) / others.length;
    // Le plus éloigné des trois qui restent : la seconde question reste
    // contrastée sur l'axe qu'on cherche à trancher.
    let best = replacementPool[0];
    let bestGap = -Infinity;
    for (const spare of replacementPool) {
      const gap = Math.abs(spare.axes[axis] - mean);
      if (gap > bestGap) {
        bestGap = gap;
        best = spare;
      }
    }
    replacements.set(film.id, best);
  }

  return {axis, films, replacements};
}
