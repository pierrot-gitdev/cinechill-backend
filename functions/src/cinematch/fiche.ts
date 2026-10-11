/* ===================================================================== *
 *  CinéMatch : la fiche d'un film
 *
 *  Décrire un film par ce qu'un cinéphile regarde : ses genres, ses
 *  mots-clés, ceux qui l'ont fait, ceux qui y jouent, sa saga, sa décennie.
 *  Deux films se ressemblent par leurs points communs, et un point commun
 *  rare pèse plus qu'un point commun banal : partager Michael Mann dit
 *  beaucoup, partager « Drame » presque rien.
 *
 *  Pourquoi pas les huit axes : mesuré le 11 octobre 2026 sur douze films et
 *  leurs vraies fiches TMDB (une liste de bons conseils écrite d'avance pour
 *  chacun), les axes ne retrouvaient que 27 % de bons conseils parmi leurs
 *  cinq premiers, cette fiche 55 %. Les axes sont des moyennes de genres :
 *  deux polars y tombent au même point, et Le Voyage de Chihiro y ressemble
 *  plus à Mufasa qu'au Château ambulant.
 *
 *  Module pur, comme le moteur : des fiches en entrée, des notes en sortie.
 *  Rien ici n'appelle TMDB ni Firestore.
 * ===================================================================== */

/** Monte quand le contenu d'une fiche change : les anciennes se refont. */
export const FICHE_VERSION = 2;

/** Ce qu'on retient d'un film (ou d'une série) pour le comparer aux autres. */
export interface Fiche {
  id: number;
  /** Genres TMDB ; ceux d'une série sont ramenés aux genres de films. */
  genres: number[];
  /** Identifiants des mots-clés TMDB. */
  keywords: number[];
  /** Réalisation et scénario pour un film, création pour une série. */
  makers: number[];
  /**
   * Les auteurs de l'œuvre d'origine : la pièce, le roman, le film dont
   * celui-ci est le remake. Ils ne font pas la patte du film ; ils servent à
   * reconnaître le remake d'un film déjà vu.
   */
  sources?: number[];
  /** Les huit premiers rôles. */
  cast: number[];
  /** La saga, s'il y en a une. */
  collection: number | null;
  /** 1990 pour un film de 1995. */
  decade: number | null;
  voteAverage: number | null;
  voteCount: number | null;
}

type Family =
  'genres' | 'keywords' | 'makers' | 'cast' | 'collection' | 'decade';

/**
 * Ce que pèse chaque famille de points communs. Ce sont les poids du test
 * du 11 octobre : l'histoire (genres, mots-clés) compte entier, la main qui
 * a fait le film presque autant, les acteurs et la saga moitié moins, la
 * décennie un peu. Ils seront réglés sur les coups de cœur réels.
 */
const FAMILY_WEIGHTS: Record<Family, number> = {
  genres: 1, keywords: 1, makers: 0.8, cast: 0.4, collection: 0.4,
  decade: 0.3,
};
const FAMILIES = Object.keys(FAMILY_WEIGHTS) as Family[];
/** Les familles où un seul point commun suffit à compter entier. */
const OVERLAP_FAMILIES = new Set<Family>(['makers', 'collection']);
const WEIGHT_TOTAL =
  FAMILIES.reduce((sum, family) => sum + FAMILY_WEIGHTS[family], 0);

/**
 * Les crédits d'écriture qui désignent l'œuvre d'origine, pas le scénario du
 * film. Les versions italienne et allemande du Prénom créditent Delaporte et
 * de La Patellière comme « Theatre Play » : compter ces crédits comme la
 * patte du film faisait proposer ces remakes à qui avait vu le Prénom.
 */
const SOURCE_JOBS = new Set([
  'Novel', 'Book', 'Theatre Play', 'Original Film Writer', 'Characters',
  'Comic Book', 'Graphic Novel', 'Short Story', 'Author',
  'Original Series Creator', 'Idea',
]);

/** Au plus, pour qu'un film au générique fleuve ne dilue pas les autres. */
const MAX_MAKERS = 8;
const MAX_CAST = 8;

/* --------------------------------------------------------------------- *
 *  Lire une fiche TMDB
 * --------------------------------------------------------------------- */

/**
 * Les identifiants numériques d'une liste d'objets TMDB, sans doublon.
 * @param {unknown} raw Liste brute.
 * @param {function(Object): boolean} keep Filtre sur l'objet.
 * @return {number[]} Identifiants, dans l'ordre de TMDB.
 */
function idsOf(
    raw: unknown,
    keep: (item: Record<string, unknown>) => boolean = () => true,
): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (!keep(record)) continue;
    const id = record.id;
    if (typeof id === 'number' && Number.isInteger(id) && !out.includes(id)) {
      out.push(id);
    }
  }
  return out;
}

/**
 * La décennie d'une date TMDB.
 * @param {unknown} date Date `YYYY-MM-DD`.
 * @return {?number} 1990 pour 1995, ou null.
 */
function decadeOf(date: unknown): number | null {
  const year = Number(String(date ?? '').slice(0, 4));
  return Number.isInteger(year) && year > 1800 ?
    Math.floor(year / 10) * 10 : null;
}

/**
 * Un nombre de la fiche, ou null.
 * @param {unknown} value Valeur brute.
 * @return {?number} Nombre fini et positif, ou null.
 */
function positiveOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ?
    value : null;
}

/**
 * La fiche d'un film, depuis `/movie/{id}` avec `keywords` et `credits`.
 * @param {Record<string, unknown>} detail Fiche TMDB.
 * @return {Fiche} La fiche.
 */
export function ficheFromMovieDetail(detail: Record<string, unknown>): Fiche {
  const credits = (detail.credits ?? {}) as {crew?: unknown; cast?: unknown};
  const keywords = (detail.keywords ?? {}) as {keywords?: unknown};
  const collection = detail.belongs_to_collection as
    {id?: unknown} | null | undefined;
  return {
    id: Number(detail.id),
    genres: idsOf(detail.genres),
    keywords: idsOf(keywords.keywords),
    makers: idsOf(credits.crew, (member) => member.job === 'Director' ||
      (member.department === 'Writing' &&
        !SOURCE_JOBS.has(String(member.job))))
        .slice(0, MAX_MAKERS),
    sources: idsOf(credits.crew, (member) =>
      member.department === 'Writing' && SOURCE_JOBS.has(String(member.job))),
    cast: idsOf(credits.cast).slice(0, MAX_CAST),
    collection: typeof collection?.id === 'number' ? collection.id : null,
    decade: decadeOf(detail.release_date),
    voteAverage: positiveOrNull(detail.vote_average),
    voteCount: positiveOrNull(detail.vote_count),
  };
}

/**
 * La fiche d'une série, depuis `/tv/{id}` avec `keywords` et
 * `aggregate_credits`. Les créateurs tiennent lieu d'auteurs.
 * @param {Record<string, unknown>} detail Fiche TMDB.
 * @param {number[]} genres Genres déjà ramenés aux genres de films.
 * @return {Fiche} La fiche.
 */
export function ficheFromTvDetail(
    detail: Record<string, unknown>, genres: number[],
): Fiche {
  const keywords = (detail.keywords ?? {}) as {results?: unknown};
  const credits = (detail.aggregate_credits ?? detail.credits ?? {}) as
    {cast?: unknown};
  return {
    id: Number(detail.id),
    genres,
    keywords: idsOf(keywords.results),
    makers: idsOf(detail.created_by).slice(0, MAX_MAKERS),
    cast: idsOf(credits.cast).slice(0, MAX_CAST),
    collection: null,
    decade: decadeOf(detail.first_air_date),
    voteAverage: positiveOrNull(detail.vote_average),
    voteCount: positiveOrNull(detail.vote_count),
  };
}

/**
 * Une fiche de repli, quand seule la ligne de liste est connue : genres et
 * décennie. Elle compare mal, mais elle compare : un film de galerie dont
 * la fiche complète n'a pas encore été payée reste montrable.
 * @param {Object} row Ligne de liste ou document de galerie.
 * @param {number} row.id Identifiant TMDB.
 * @param {number[]} row.genreIds Genres.
 * @param {?string} row.releaseDate Date de sortie.
 * @return {Fiche} Fiche réduite.
 */
export function thinFiche(row: {
  id: number; genreIds: number[]; releaseDate: string | null;
}): Fiche {
  return {
    id: row.id, genres: [...row.genreIds], keywords: [], makers: [], cast: [],
    collection: null, decade: decadeOf(row.releaseDate), voteAverage: null,
    voteCount: null,
  };
}

/**
 * Vrai si l'objet stocké ressemble à une fiche de la version courante.
 * @param {unknown} raw Valeur lue dans Firestore.
 * @return {boolean} Vrai si elle est utilisable telle quelle.
 */
export function isFiche(raw: unknown): raw is Fiche {
  if (typeof raw !== 'object' || raw === null) return false;
  const f = raw as Record<string, unknown>;
  return typeof f.id === 'number' && Array.isArray(f.genres) &&
    Array.isArray(f.keywords) && Array.isArray(f.makers) &&
    Array.isArray(f.cast);
}

/* --------------------------------------------------------------------- *
 *  Rareté et ressemblance
 * --------------------------------------------------------------------- */

/**
 * Les valeurs d'une famille, en chaînes (une saga et un genre peuvent
 * porter le même nombre).
 * @param {Fiche} fiche La fiche.
 * @param {Family} family La famille.
 * @return {string[]} Valeurs.
 */
function traitsOf(fiche: Fiche, family: Family): string[] {
  switch (family) {
    case 'genres': return fiche.genres.map(String);
    case 'keywords': return fiche.keywords.map(String);
    case 'makers': return fiche.makers.map(String);
    case 'cast': return fiche.cast.map(String);
    case 'collection':
      return fiche.collection === null ? [] : [String(fiche.collection)];
    case 'decade': return fiche.decade === null ? [] : [String(fiche.decade)];
  }
}

/**
 * Combien de films portent chaque point commun, dans un ensemble de
 * référence. C'est ce qui dit qu'un point commun est rare.
 *
 * La référence doit être neutre : la galerie et le catalogue général, jamais
 * les films réunis autour du film choisi. Constaté le 11 octobre sur
 * émulateur : mesurée sur les candidats d'un soir « proche du Voyage de
 * Chihiro », où la recherche par réalisateur ramène dix Miyazaki, la
 * signature de Miyazaki devenait banale et ne pesait plus rien.
 *
 * Chaque famille a sa propre taille : une fiche réduite (genres, décennie)
 * compte pour les genres mais pas pour les acteurs qu'elle ne connaît pas.
 */
export interface Rarity {
  sizes: Record<Family, number>;
  counts: Map<string, number>;
}

/**
 * Compte les points communs d'un ensemble de fiches (une fois par film).
 * @param {Fiche[]} fiches Les films de référence.
 * @return {Rarity} La rareté.
 */
export function buildRarity(fiches: Fiche[]): Rarity {
  const counts = new Map<string, number>();
  const sizes = Object.fromEntries(FAMILIES.map((f) => [f, 0])) as
    Record<Family, number>;
  const seen = new Set<number>();
  for (const fiche of fiches) {
    if (seen.has(fiche.id)) continue;
    seen.add(fiche.id);
    for (const family of FAMILIES) {
      const values = new Set(traitsOf(fiche, family));
      if (values.size > 0) sizes[family]++;
      for (const value of values) {
        const key = `${family}|${value}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return {sizes, counts};
}

/**
 * Le poids d'un point commun : d'autant plus fort qu'il est rare dans la
 * référence. Un trait absent de la référence est le plus rare de tous.
 * @param {Rarity} rarity La rareté.
 * @param {Family} family Sa famille.
 * @param {string} value Sa valeur.
 * @return {number} Poids, positif.
 */
function traitWeight(rarity: Rarity, family: Family, value: string): number {
  const size = rarity.sizes[family];
  const count = rarity.counts.get(`${family}|${value}`) ?? 0;
  return Math.log((size + 1) / (count + 0.5));
}

/** Une fiche prête à comparer : ses valeurs, leur poids, sa norme. */
interface Profile {
  sets: Record<Family, Map<string, number>>;
  norms: Record<Family, number>;
}

/**
 * Prépare une fiche pour des comparaisons répétées.
 * @param {Fiche} fiche La fiche.
 * @param {Rarity} rarity La rareté de la soirée.
 * @return {Profile} Le profil.
 */
function profileOf(fiche: Fiche, rarity: Rarity): Profile {
  const sets = {} as Record<Family, Map<string, number>>;
  const norms = {} as Record<Family, number>;
  for (const family of FAMILIES) {
    const weights = new Map<string, number>();
    let norm = 0;
    for (const value of new Set(traitsOf(fiche, family))) {
      const weight = traitWeight(rarity, family, value);
      weights.set(value, weight);
      norm += weight * weight;
    }
    sets[family] = weights;
    norms[family] = norm;
  }
  return {sets, norms};
}

/**
 * Ressemblance de deux profils, de 0 à 1 : famille par famille, la part des
 * points communs dans l'ensemble des traits des deux films, chaque trait
 * pesant selon sa rareté.
 * @param {Profile} a Premier film.
 * @param {Profile} b Second film.
 * @return {number} Ressemblance.
 */
function profileSimilarity(a: Profile, b: Profile): number {
  let total = 0;
  for (const family of FAMILIES) {
    const left = a.sets[family];
    const right = b.sets[family];
    if (left.size === 0 || right.size === 0) continue;
    const denominator = Math.sqrt(a.norms[family] * b.norms[family]);
    if (!(denominator > 0)) continue;
    let shared = 0;
    const [small, large] = left.size <= right.size ?
      [left, right] : [right, left];
    for (const [value, weight] of small) {
      if (large.has(value)) shared += weight * weight;
    }
    // L'auteur et la saga : les partager compte entier, quel que soit le
    // nombre de coauteurs. Collateral a trois scénaristes et Miami Vice un
    // seul ; à Michael Mann égal, le premier ne doit pas ressembler moins à
    // Heat pour autant.
    const scale = OVERLAP_FAMILIES.has(family) ?
      Math.min(a.norms[family], b.norms[family]) : denominator;
    total += FAMILY_WEIGHTS[family] * Math.min(1, shared / scale);
  }
  return total / WEIGHT_TOTAL;
}

/**
 * Un comparateur de fiches pour une soirée : il prépare chaque fiche une
 * fois, puis compare autant qu'on veut.
 */
export class FicheComparer {
  private readonly profiles = new Map<number, Profile>();

  /**
   * @param {Rarity} rarity La rareté de la soirée.
   */
  constructor(private readonly rarity: Rarity) {}

  /**
   * Ressemblance de deux fiches, de 0 à 1.
   * @param {Fiche} a Premier film.
   * @param {Fiche} b Second film.
   * @return {number} Ressemblance.
   */
  similarity(a: Fiche, b: Fiche): number {
    if (a.id === b.id) return 1;
    return profileSimilarity(this.profile(a), this.profile(b));
  }

  /**
   * Le profil d'une fiche, préparé une fois.
   * @param {Fiche} fiche La fiche.
   * @return {Profile} Son profil.
   */
  private profile(fiche: Fiche): Profile {
    let profile = this.profiles.get(fiche.id);
    if (!profile) {
      profile = profileOf(fiche, this.rarity);
      this.profiles.set(fiche.id, profile);
    }
    return profile;
  }
}

/* --------------------------------------------------------------------- *
 *  Les styles
 * --------------------------------------------------------------------- */

/** Les dix styles de l'écran « Tu as envie de quoi ce soir ? ». */
export type StyleKey =
  'thriller' | 'action' | 'scifi' | 'comedy' | 'drama' | 'romance' |
  'horror' | 'animation' | 'history' | 'documentary';

/**
 * Chaque style et les genres TMDB qui le font. Un film appartient à tous
 * les styles dont il porte un genre : Heat est à la fois un thriller et un
 * film d'action. L'ordre est celui d'affichage à égalité de films.
 */
export const STYLES: {key: StyleKey; genres: number[]}[] = [
  {key: 'thriller', genres: [53, 80, 9648]},
  {key: 'action', genres: [28, 12, 37]},
  {key: 'scifi', genres: [878, 14]},
  {key: 'comedy', genres: [35]},
  {key: 'drama', genres: [18, 10402]},
  {key: 'romance', genres: [10749]},
  {key: 'horror', genres: [27]},
  {key: 'animation', genres: [16, 10751]},
  {key: 'history', genres: [10752, 36]},
  {key: 'documentary', genres: [99]},
];

/**
 * Lit une clé de style.
 * @param {unknown} raw Valeur reçue.
 * @return {?StyleKey} Le style, ou null.
 */
export function styleKeyOf(raw: unknown): StyleKey | null {
  return STYLES.find((style) => style.key === raw)?.key ?? null;
}

/**
 * Les genres d'un style.
 * @param {StyleKey} key Le style.
 * @return {number[]} Genres TMDB de films.
 */
export function styleGenres(key: StyleKey): number[] {
  return STYLES.find((style) => style.key === key)?.genres ?? [];
}

/**
 * Vrai si le style est le genre principal du film : le premier genre que
 * TMDB lui donne en fait partie.
 * @param {number[]} genreIds Genres du film, dans l'ordre de TMDB.
 * @param {StyleKey} key Le style.
 * @return {boolean} Vrai si c'est son genre principal.
 */
export function isCoreStyle(genreIds: number[], key: StyleKey): boolean {
  return genreIds.length > 0 && styleGenres(key).includes(genreIds[0]);
}

/**
 * Vrai si un film appartient au style.
 * @param {number[]} genreIds Genres du film.
 * @param {StyleKey} key Le style.
 * @return {boolean} Vrai s'il en porte un genre.
 */
export function inStyle(genreIds: number[], key: StyleKey): boolean {
  const genres = styleGenres(key);
  return genreIds.some((id) => genres.includes(id));
}

/* --------------------------------------------------------------------- *
 *  Les six films d'un style
 * --------------------------------------------------------------------- */

export interface VariedOptions {
  /** Tirage stable du jour, pour que rouvrir l'écran rende les mêmes. */
  random: () => number;
  /** Les coups de cœur : montrés en priorité. */
  loved: Set<number>;
  /** Les films montrés ces quatorze derniers jours : en dernier. */
  recent: Set<number>;
  /**
   * Les films dont c'est le genre principal : d'abord eux. TMDB range aussi
   * Whiplash parmi les thrillers ; c'est Heat qu'on attend sous ce nom.
   */
  core: Set<number>;
}

/**
 * Ordonne des films pour qu'ils soient variés : on part d'un coup de cœur,
 * puis on prend à chaque fois celui qui ressemble le moins aux films déjà
 * pris. Six films presque identiques ne laisseraient pas choisir ; six films
 * différents d'un même style, si.
 * @param {Fiche[]} fiches Les films du style.
 * @param {FicheComparer} comparer Le comparateur de la soirée.
 * @param {VariedOptions} options Tirage, coups de cœur, films récents.
 * @return {number[]} Identifiants, dans l'ordre où les montrer.
 */
export function orderVaried(
    fiches: Fiche[], comparer: FicheComparer, options: VariedOptions,
): number[] {
  const rest = [...fiches];
  const order: Fiche[] = [];
  const bonus = (fiche: Fiche): number =>
    (options.loved.has(fiche.id) ? 0.15 : 0) +
    (options.core.has(fiche.id) ? 0.3 : 0) -
    (options.recent.has(fiche.id) ? 1 : 0);
  // Le premier : un coup de cœur du genre principal, pas montré récemment,
  // tiré au sort.
  const openers = rest.filter((fiche) => options.loved.has(fiche.id) &&
    options.core.has(fiche.id) && !options.recent.has(fiche.id));
  const fresh = rest.filter((fiche) => !options.recent.has(fiche.id));
  const firstPool = openers.length > 0 ? openers : fresh.length > 0 ?
    fresh : rest;
  if (firstPool.length === 0) return [];
  const first = firstPool[Math.floor(options.random() * firstPool.length)];
  order.push(first);
  rest.splice(rest.indexOf(first), 1);

  const closest = new Map<number, number>(
      rest.map((fiche) => [fiche.id, comparer.similarity(fiche, first)]));
  while (rest.length > 0) {
    let best = 0;
    let bestValue = -Infinity;
    rest.forEach((fiche, index) => {
      // Un brin de hasard départage les films également éloignés.
      const value = 1 - (closest.get(fiche.id) ?? 0) + bonus(fiche) +
        options.random() * 0.02;
      if (value > bestValue) {
        bestValue = value;
        best = index;
      }
    });
    const next = rest.splice(best, 1)[0];
    order.push(next);
    for (const fiche of rest) {
      closest.set(fiche.id, Math.max(closest.get(fiche.id) ?? 0,
          comparer.similarity(fiche, next)));
    }
  }
  return order.map((fiche) => fiche.id);
}

/* --------------------------------------------------------------------- *
 *  Le classement des cinq
 * --------------------------------------------------------------------- */

/** La note moyenne qu'on prête à un film dont on ne sait rien. */
const RECEPTION_PRIOR = 6.5;
/** Le poids de cette note prêtée, en votes. */
const RECEPTION_PRIOR_VOTES = 300;

/**
 * La réception d'un film : sa note TMDB, tirée vers une note moyenne tant
 * qu'il a peu de votes. Un 8,5 sur quarante votes ne vaut pas un 8,1 sur
 * vingt mille.
 * @param {Fiche} fiche La fiche.
 * @return {number} Note sur 10.
 */
export function receptionOf(fiche: Fiche): number {
  const votes = fiche.voteCount ?? 0;
  const average = fiche.voteAverage ?? RECEPTION_PRIOR;
  return (average * votes + RECEPTION_PRIOR * RECEPTION_PRIOR_VOTES) /
    (votes + RECEPTION_PRIOR_VOTES);
}

/** Un film candidat, et ce qui le décale hors de la ressemblance. */
export interface PickCandidate {
  fiche: Fiche;
  /** Dans la watchlist. */
  listed: boolean;
  /** Décalage en unités brutes : exposition, et pour une série son format. */
  shift: number;
}

/** Ce qui fait la note d'un candidat, pour le journal. */
export interface PickTerms {
  /** Ressemblance brute au film choisi, de 0 à 1 (non pondérée). */
  similarity: number;
  anchor: number;
  taste: number;
  reception: number;
  listed: number;
  shift: number;
}

export interface RankedPick {
  fiche: Fiche;
  listed: boolean;
  score: number;
  terms: PickTerms;
}

/** L'avantage d'un film de la watchlist, comme dans le moteur v2. */
const LISTED_BONUS = 0.3;

/**
 * Les parts de la note : avec un film choisi, la ressemblance à ce film
 * d'abord (l'envie du soir), puis aux coups de cœur (le goût), puis la
 * réception. Sans film choisi (« Peu importe », proposition du jour), le
 * goût prend la place de l'envie.
 *
 * Réglées le 11 octobre sur les douze films de référence : à 30 % de goût,
 * les coups de cœur tiraient la proposition loin du film choisi (Batman
 * Begins parmi les films proches du Voyage de Chihiro, pour quelqu'un qui
 * aime The Dark Knight) ; à 20 %, ils départagent sans détourner. La
 * réception est montée à 20 % après l'essai sur les vraies listes de TMDB :
 * à 10 %, Hacker (5,4/10) passait devant Collateral (7,2/10) pour Heat.
 */
const SHARES_WITH_ANCHOR = {anchor: 0.6, taste: 0.2, reception: 0.2};
/**
 * Sans film choisi, la réception pèse davantage : le goût seul, lu dans les
 * voisinages des coups de cœur, ramenait des films faibles (Mortal Engines,
 * un téléfilm d'animation) au seul motif qu'ils ressemblaient à Mad Max.
 */
const SHARES_WITHOUT_ANCHOR = {anchor: 0, taste: 0.6, reception: 0.4};
/**
 * Les termes de goût et de réception sont bornés : la suite d'un coup de
 * cœur (Batman Begins pour qui aime The Dark Knight) sortait à trois écarts
 * types et emportait la proposition, même loin du film choisi.
 */
const TERM_CLAMP = 2;
const SHARES_RECEPTION_ONLY = {anchor: 0, taste: 0, reception: 1};

/**
 * Centre et réduit une série. Une série constante rend des zéros.
 * @param {number[]} values Valeurs.
 * @return {number[]} Valeurs centrées réduites.
 */
function standardize(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const sd = Math.sqrt(
      values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / n);
  if (!(sd > 1e-9)) return values.map(() => 0);
  return values.map((v) => (v - mean) / sd);
}

/**
 * La ressemblance d'un film aux coups de cœur : la moyenne de ses trois
 * meilleures ressemblances. Trois et non une : proche d'un seul coup de
 * cœur, c'est une coïncidence ; proche de trois, c'est un goût.
 * @param {Fiche} fiche Le film.
 * @param {Fiche[]} loved Les coups de cœur.
 * @param {FicheComparer} comparer Le comparateur.
 * @return {number} Ressemblance, 0 sans coup de cœur.
 */
function tasteOf(
    fiche: Fiche, loved: Fiche[], comparer: FicheComparer,
): number {
  if (loved.length === 0) return 0;
  const sims = loved.map((other) => comparer.similarity(fiche, other))
      .sort((a, b) => b - a)
      .slice(0, 3);
  return sims.reduce((sum, v) => sum + v, 0) / sims.length;
}

/**
 * Classe les candidats d'une soirée.
 * @param {PickCandidate[]} candidates Les films disponibles, filtrés.
 * @param {?Fiche} anchor Le film choisi, ou null.
 * @param {Fiche[]} loved Les coups de cœur.
 * @param {FicheComparer} comparer Le comparateur de la soirée.
 * @return {RankedPick[]} Films classés, meilleur en tête.
 */
export function rankPicks(
    candidates: PickCandidate[],
    anchor: Fiche | null,
    loved: Fiche[],
    comparer: FicheComparer,
): RankedPick[] {
  const shares = anchor ? SHARES_WITH_ANCHOR :
    loved.length > 0 ? SHARES_WITHOUT_ANCHOR : SHARES_RECEPTION_ONLY;
  const rawAnchor = candidates.map((c) =>
    anchor ? comparer.similarity(anchor, c.fiche) : 0);
  const rawTaste = candidates.map((c) => tasteOf(c.fiche, loved, comparer));
  const rawReception = candidates.map((c) => receptionOf(c.fiche));
  const clamp = (v: number): number =>
    Math.max(-TERM_CLAMP, Math.min(TERM_CLAMP, v));
  const zAnchor = standardize(rawAnchor);
  const zTaste = standardize(rawTaste).map(clamp);
  const zReception = standardize(rawReception).map(clamp);

  return candidates.map((c, i) => {
    const terms: PickTerms = {
      similarity: rawAnchor[i],
      anchor: shares.anchor * zAnchor[i],
      taste: shares.taste * zTaste[i],
      reception: shares.reception * zReception[i],
      listed: c.listed ? LISTED_BONUS : 0,
      shift: c.shift,
    };
    const score = terms.anchor + terms.taste + terms.reception +
      terms.listed + terms.shift;
    return {fiche: c.fiche, listed: c.listed, score, terms};
  }).sort((a, b) => b.score - a.score || a.fiche.id - b.fiche.id);
}

/**
 * La composition n'écarte que les doublons : un second film de la même
 * saga, ou un quasi-double (ressemblance au-delà du seuil). Proposer cinq
 * Ghibli à qui veut un film proche du Voyage de Chihiro n'est pas un défaut ;
 * pousser la variété plus loin faisait entrer Thor parmi les films proches
 * du Prénom.
 */
const COMPOSE_SAGA_PENALTY = 1.0;
const COMPOSE_SIMILARITY = 1.0;
const COMPOSE_SIMILARITY_FROM = 0.45;
/** Les candidats parmi lesquels se compose la sélection, au moins. */
const COMPOSE_POOL_MIN = 12;
/**
 * Sans film choisi seulement : ce que coûte un troisième film du même
 * premier genre. Avec un film choisi, le genre partagé est voulu.
 */
const THIRD_SAME_GENRE_PENALTY = 0.6;

/**
 * Compose les cinq : le meilleur d'abord, puis à chaque tour celui qui vaut
 * le plus une fois retirée sa ressemblance aux films déjà pris. Cinq films
 * presque identiques ne font qu'un choix répété cinq fois. Un seul film de
 * la watchlist : elle a déjà son onglet.
 * @param {RankedPick[]} ranked Films classés.
 * @param {FicheComparer} comparer Le comparateur de la soirée.
 * @param {number} count Nombre de films voulus.
 * @param {boolean} varyGenres Vrai sans film choisi : varier les genres.
 * @return {RankedPick[]} La sélection, dans l'ordre de présentation.
 */
export function composePicks(
    ranked: RankedPick[], comparer: FicheComparer, count = 5,
    varyGenres = false,
): RankedPick[] {
  if (ranked.length === 0) return [];
  // La variété se cherche parmi les meilleurs seulement : chercher plus bas
  // faisait entrer un film sans rapport (Thor : Ragnarok parmi les films
  // proches du Prénom) au seul motif qu'il ne ressemblait à aucun autre.
  const pool = ranked.slice(0, Math.max(COMPOSE_POOL_MIN, count * 3));
  const chosen: RankedPick[] = [pool[0]];
  while (chosen.length < count) {
    let best: RankedPick | null = null;
    let bestValue = -Infinity;
    const hasListed = chosen.some((c) => c.listed);
    for (const candidate of pool) {
      if (chosen.includes(candidate)) continue;
      if (candidate.listed && hasListed) continue;
      let closest = 0;
      for (const c of chosen) {
        closest = Math.max(closest,
            comparer.similarity(candidate.fiche, c.fiche));
      }
      const saga = candidate.fiche.collection;
      const sameSaga = saga !== null &&
        chosen.some((c) => c.fiche.collection === saga);
      const genre = candidate.fiche.genres[0];
      const sameGenre = !varyGenres || genre === undefined ? 0 :
        chosen.filter((c) => c.fiche.genres[0] === genre).length;
      const value = candidate.score -
        (sameSaga ? COMPOSE_SAGA_PENALTY : 0) -
        COMPOSE_SIMILARITY * Math.max(0, closest - COMPOSE_SIMILARITY_FROM) -
        (sameGenre >= 2 ? THIRD_SAME_GENRE_PENALTY : 0);
      if (value > bestValue) {
        bestValue = value;
        best = candidate;
      }
    }
    if (!best) break;
    chosen.push(best);
  }
  return chosen;
}

/**
 * Vrai si le film est le remake d'un film déjà vu : il crédite comme œuvre
 * d'origine quelqu'un qui a fait un film de la galerie.
 * @param {Fiche} candidate Le candidat.
 * @param {Set<number>} seenMakers Auteurs des films vus.
 * @return {boolean} Vrai pour un remake à écarter.
 */
export function isRemakeOfSeen(
    candidate: Fiche, seenMakers: Set<number>,
): boolean {
  return (candidate.sources ?? []).some((id) => seenMakers.has(id));
}

/* --------------------------------------------------------------------- *
 *  Chercher autour du film choisi
 * --------------------------------------------------------------------- */

/**
 * Les mots-clés qui ne disent rien d'un film : ils traînent sur des milliers
 * de fiches (« d'après un roman », « scène après le générique »). Chercher
 * des films voisins par eux ramènerait n'importe quoi.
 */
const GENERIC_KEYWORDS = new Set<number>([
  818, // based on novel or book
  9663, // sequel
  179431, // duringcreditsstinger
  179430, // aftercreditsstinger
  187056, // woman director
  9672, // based on true story
  281237, // independent film
  5565, // biography
  158718, // lgbt
]);

/**
 * Les mots-clés du film choisi les plus propres à le retrouver : ceux qui
 * ne sont pas génériques, les plus rares d'abord.
 * @param {Fiche} anchor Le film choisi.
 * @param {Rarity} rarity Une rareté, si on en a une ; sinon l'ordre de TMDB.
 * @param {number} count Nombre voulu.
 * @return {number[]} Identifiants de mots-clés.
 */
export function anchorKeywords(
    anchor: Fiche, rarity: Rarity | null, count = 4,
): number[] {
  const usable = anchor.keywords.filter((id) => !GENERIC_KEYWORDS.has(id));
  if (!rarity) return usable.slice(0, count);
  // Le moins de films de référence d'abord : c'est le plus distinctif.
  return [...usable]
      .sort((a, b) =>
        (rarity.counts.get(`keywords|${a}`) ?? 0) -
        (rarity.counts.get(`keywords|${b}`) ?? 0))
      .slice(0, count);
}
