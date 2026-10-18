/* ===================================================================== *
 *  La carte : ce qu'elle contient, comment elle se construit et se lit
 *
 *  Un film de la carte, c'est sa fiche (ce qu'il est), ce qu'il faut pour le
 *  filtrer le soir (durée, plateformes, réception) et sa position. Une
 *  personne n'est jamais rangée sur la carte : sa position se calcule à la
 *  demande depuis sa galerie, en une milliseconde, si bien qu'elle n'est
 *  jamais périmée (`placePerson`).
 *
 *  Module pur. La construction (traits, galeries, factorisation) et la
 *  lecture (proximité, position d'une personne) sont ici ; aller chercher
 *  les films chez TMDB et ranger la carte dans Firestore se fait dans
 *  `index.ts`.
 * ===================================================================== */

import {gunzipSync, gzipSync} from 'zlib';
import {AlsRow, buildAlsData, gram, trainAls} from './als';
import type {CarteAxis} from './axes';
import {
  addOuter, addScaled, dot, inverseSpd, solveSpd, symmetricEigen,
} from './linalg';

/** Monte quand le format de la carte change : les anciennes se refont. */
export const CARTE_VERSION = 1;

/** Un film de la carte. */
export interface CarteFilm {
  id: number;
  genres: number[];
  keywords: number[];
  /** Réalisation et scénario. */
  makers: number[];
  /** Auteurs de l'œuvre d'origine : pour écarter le remake d'un film vu. */
  sources: number[];
  cast: number[];
  collection: number | null;
  year: number | null;
  /** La date de sortie TMDB, `AAAA-MM-JJ` : un film encore en salle attend. */
  releaseDate?: string | null;
  runtime: number | null;
  voteCount: number;
  voteAverage: number;
  /** Plateformes françaises où il est inclus dans l'abonnement. */
  providers: number[];
  /**
   * Les films que TMDB recommande à qui a aimé celui-ci : la première page
   * de `/movie/{id}/recommendations`, calculée sur le comportement des
   * utilisateurs de TMDB. C'est le seul signal collaboratif dont la carte
   * dispose tant que nos galeries sont peu nombreuses ; le moteur
   * d'aujourd'hui en tire la moitié de ses candidats.
   */
  related?: number[];
  /**
   * Le jour (compté depuis le 1er janvier 1970) où sa fiche a été lue chez
   * TMDB. La carte sert de cache à ses propres fiches : TMDB en permet la
   * conservation six mois, la tâche hebdomadaire les relit avant.
   */
  fetchedDay?: number;
}

/** Les familles de traits d'une fiche. */
export type TraitFamily =
  'genres' | 'keywords' | 'makers' | 'cast' | 'collection' | 'decade';

/** Les réglages de la carte. */
export interface CarteParams {
  k: number;
  lambda: number;
  iterations: number;
  seed: number;
  /** Confiance d'un film vu, d'un coup de cœur, d'un « Pas aimé ». */
  confidenceSeen: number;
  confidenceLoved: number;
  confidenceDisliked: number;
  /** L'échelle des traits face aux personnes. */
  traitScale: number;
  /** La confiance d'un trait porté par un film. */
  traitConfidence: number;
  /** Le poids d'une liste de recommandations TMDB, face à une personne. */
  relatedWeight: number;
  /** La confiance d'un film dans une liste de recommandations. */
  relatedConfidence: number;
  /**
   * Ce que pèse chaque famille de traits, reprise des poids de la fiche du
   * 11 octobre. Ils sont un point de départ : la mesure A les réglera.
   */
  familyWeights: Record<TraitFamily, number>;
  /** Un trait porté par moins de films ne relie rien : il est ignoré. */
  minTraitFilms: number;
}

/**
 * Les réglages de départ. La dimension et la régularisation suivent les
 * bancs publics à notre échelle (ML-1M, 32 dimensions ; Rendle et al., 2022).
 * Les confiances disent qu'un « vu » pèse peu (il dit surtout la notoriété),
 * qu'un coup de cœur pèse beaucoup et qu'un « Pas aimé » repousse. Les poids
 * des familles de traits sont ceux de la fiche.
 *
 * Le poids de la fiche face aux galeries (ω, `traitScale`) est réglé sur
 * les recommandations de TMDB (`scripts/carte/tune.mjs`, 18 octobre 2026) :
 * un cinquième de 600 listes caché, la carte en retrouvait 26 % dans ses 50
 * premiers films avec ω = 1, et 48 % avec ω entre 0,03 et 0,1 (50 % parmi
 * les films peu connus, contre 13 %). À ω = 1, la fiche couvrait tout signal
 * collaboratif, nos galeries comprises. Tous seront réglés sur nos données
 * par la mesure A dès qu'il y en aura assez.
 */
export const DEFAULT_CARTE_PARAMS: CarteParams = {
  k: 32,
  lambda: 1,
  iterations: 10,
  seed: 20261018,
  confidenceSeen: 3,
  confidenceLoved: 16,
  confidenceDisliked: 6,
  traitScale: 0.05,
  traitConfidence: 8,
  relatedWeight: 1,
  relatedConfidence: 4,
  familyWeights: {
    genres: 1, keywords: 1, makers: 0.8, cast: 0.4, collection: 0.4,
    decade: 0.3,
  },
  minTraitFilms: 2,
};

/** Un film d'une galerie, tel que la carte le lit. */
export interface GalleryMark {
  id: number;
  loved: boolean;
  disliked: boolean;
}

/** La carte. */
export interface Carte {
  version: number;
  builtAt: number;
  params: CarteParams;
  k: number;
  films: CarteFilm[];
  /** Positions, films × k, en ligne. */
  vectors: Float32Array;
  /** Nombre de galeries qui contiennent le film (vu ou aimé). */
  support: Int32Array;
  /** Σ y yᵀ sur tous les films : la part commune de toute position. */
  gram: Float64Array;
  /** Identifiant TMDB → rang dans `films`. */
  index: Map<number, number>;
  /** Les axes nommés appris cette semaine (`axes.ts`), par nom. */
  axes?: Record<string, CarteAxis>;
}

/**
 * Les traits d'un film, famille par famille.
 * @param {CarteFilm} film Le film.
 * @return {Array<[TraitFamily, string]>} Traits.
 */
function traitsOf(film: CarteFilm): [TraitFamily, string][] {
  const out: [TraitFamily, string][] = [];
  for (const g of film.genres) out.push(['genres', String(g)]);
  for (const kw of film.keywords) out.push(['keywords', String(kw)]);
  for (const m of film.makers) out.push(['makers', String(m)]);
  for (const c of film.cast) out.push(['cast', String(c)]);
  if (film.collection !== null) {
    out.push(['collection', String(film.collection)]);
  }
  if (film.year !== null) {
    out.push(['decade', String(Math.floor(film.year / 10) * 10)]);
  }
  return out;
}

/**
 * Les lignes de traits : un spectateur par trait, poids = rareté × famille.
 * @param {CarteFilm[]} films Les films.
 * @param {CarteParams} params Réglages.
 * @return {AlsRow[]} Lignes.
 */
export function traitRows(films: CarteFilm[], params: CarteParams): AlsRow[] {
  const members = new Map<string, {family: TraitFamily; items: number[]}>();
  films.forEach((film, i) => {
    const seen = new Set<string>();
    for (const [family, value] of traitsOf(film)) {
      const key = `${family}|${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let entry = members.get(key);
      if (!entry) {
        entry = {family, items: []};
        members.set(key, entry);
      }
      entry.items.push(i);
    }
  });
  const n = films.length;
  const rows: AlsRow[] = [];
  for (const entry of members.values()) {
    if (entry.items.length < params.minTraitFilms) continue;
    // La rareté de la fiche : un trait que portent peu de films pèse plus.
    const idf = Math.log((n + 1) / (entry.items.length + 0.5));
    const weight = params.traitScale * params.familyWeights[entry.family] *
      Math.max(0, idf);
    if (weight <= 0) continue;
    rows.push({
      weight,
      obs: entry.items.map((item) =>
        ({item, p: 1, c: params.traitConfidence})),
    });
  }
  return rows;
}

/**
 * Les lignes des recommandations TMDB : chaque film et ce que TMDB
 * recommande à qui l'a aimé forment une galerie de plus, celle d'un
 * spectateur type de ce film. Seuls comptent les films de la carte.
 * @param {CarteFilm[]} films Les films.
 * @param {Map<number, number>} index Identifiant → rang.
 * @param {CarteParams} params Réglages.
 * @return {AlsRow[]} Lignes.
 */
export function relatedRows(
    films: CarteFilm[], index: Map<number, number>, params: CarteParams,
): AlsRow[] {
  const rows: AlsRow[] = [];
  if (!(params.relatedWeight > 0)) return rows;
  films.forEach((film, i) => {
    const items = new Set<number>();
    for (const id of film.related ?? []) {
      const row = index.get(id);
      if (row !== undefined && row !== i) items.add(row);
    }
    if (items.size === 0) return;
    items.add(i);
    rows.push({
      weight: params.relatedWeight,
      obs: [...items].map((item) => ({item, p: 1 as const,
        c: params.relatedConfidence})),
    });
  });
  return rows;
}

/**
 * Les observations d'une galerie, en rangs de la carte.
 * @param {GalleryMark[]} gallery La galerie.
 * @param {Map<number, number>} index Identifiant → rang.
 * @param {CarteParams} params Réglages.
 * @return {Array<Object>} Observations `{item, p, c}`.
 */
export function galleryObservations(
    gallery: GalleryMark[], index: Map<number, number>, params: CarteParams,
): {item: number; p: 0 | 1; c: number}[] {
  const out: {item: number; p: 0 | 1; c: number}[] = [];
  const seen = new Set<number>();
  for (const mark of gallery) {
    const item = index.get(mark.id);
    if (item === undefined || seen.has(item)) continue;
    seen.add(item);
    if (mark.disliked) {
      out.push({item, p: 0, c: params.confidenceDisliked});
    } else {
      out.push({
        item, p: 1,
        c: mark.loved ? params.confidenceLoved : params.confidenceSeen,
      });
    }
  }
  return out;
}

/**
 * Construit la carte : traits et galeries, puis factorisation.
 * @param {CarteFilm[]} films Les films, dans l'ordre de la carte.
 * @param {Array<Array<GalleryMark>>} galleries Une galerie par personne.
 * @param {CarteParams} params Réglages.
 * @param {?Carte} previous La carte précédente : ses positions servent de
 *   point de départ, ce qui la garde stable d'une semaine à l'autre.
 * @return {Carte} La carte.
 */
export function buildCarte(
    films: CarteFilm[],
    galleries: GalleryMark[][],
    params: CarteParams = DEFAULT_CARTE_PARAMS,
    previous: Carte | null = null,
): Carte {
  const index = new Map(films.map((film, i) => [film.id, i]));
  const support = new Int32Array(films.length);
  const userRows: AlsRow[] = [];
  for (const gallery of galleries) {
    const obs = galleryObservations(gallery, index, params);
    if (obs.length === 0) continue;
    for (const o of obs) if (o.p === 1) support[o.item]++;
    userRows.push({weight: 1, obs});
  }
  const rows = [
    ...userRows, ...relatedRows(films, index, params),
    ...traitRows(films, params),
  ];
  const data = buildAlsData(films.length, rows);

  let init: Float64Array | null = null;
  if (previous && previous.k === params.k) {
    const start = new Float64Array(films.length * params.k);
    let reused = 0;
    films.forEach((film, i) => {
      const old = previous.index.get(film.id);
      if (old === undefined) return;
      reused++;
      for (let d = 0; d < params.k; d++) {
        start[i * params.k + d] = previous.vectors[old * params.k + d];
      }
    });
    // Une carte trop différente ne sert pas de départ : les films nouveaux,
    // à zéro, tireraient toute la carte vers l'origine.
    if (reused >= films.length / 2) init = start;
  }
  const result = trainAls(data, params, init);
  const items = previous && previous.k === params.k ?
    alignTo(result.items, films, previous) : result.items;
  const vectors = Float32Array.from(items);
  return {
    version: CARTE_VERSION,
    builtAt: Date.now(),
    params,
    k: params.k,
    films,
    vectors,
    support,
    gram: gram(Float64Array.from(vectors), films.length, params.k),
    index,
  };
}

/**
 * Recale une carte neuve sur la précédente. Une factorisation est définie à
 * une rotation près : tourner toutes les positions ne change aucune note.
 * Sans recalage, les directions de la carte (les axes nommés, « plus
 * sombre ») pourraient changer de sens d'une semaine à l'autre. On cherche
 * donc la rotation R qui rapproche le plus les films communs de leur
 * ancienne place (problème de Procruste orthogonal) : R = M (MᵀM)^-½, avec
 * M = Σ y_neuf y_ancienᵀ. Une rotation ne change ni les proximités entre
 * films, ni les notes des personnes, recalculées à la demande.
 * @param {Float64Array} items Positions neuves, films × k.
 * @param {CarteFilm[]} films Les films, dans l'ordre de `items`.
 * @param {Carte} previous La carte précédente.
 * @return {Float64Array} Positions recalées (ou inchangées si trop peu de
 *   films communs pour fixer la rotation).
 */
export function alignTo(
    items: Float64Array, films: CarteFilm[], previous: Carte,
): Float64Array {
  const k = previous.k;
  const m = new Float64Array(k * k);
  let shared = 0;
  films.forEach((film, i) => {
    const old = previous.index.get(film.id);
    if (old === undefined) return;
    shared++;
    for (let a = 0; a < k; a++) {
      const ya = items[i * k + a];
      for (let b = 0; b < k; b++) {
        m[a * k + b] += ya * previous.vectors[old * k + b];
      }
    }
  });
  if (shared < 4 * k) return items;
  // MᵀM = V S² Vᵀ, donc (MᵀM)^-½ = V S⁻¹ Vᵀ.
  const mtm = new Float64Array(k * k);
  for (let a = 0; a < k; a++) {
    for (let b = 0; b < k; b++) {
      let s = 0;
      for (let r = 0; r < k; r++) s += m[r * k + a] * m[r * k + b];
      mtm[a * k + b] = s;
    }
  }
  const {values, vectors} = symmetricEigen(mtm, k);
  const top = Math.max(...values);
  if (!(top > 0) || Math.min(...values) < 1e-10 * top) return items;
  const invSqrt = new Float64Array(k * k);
  for (let a = 0; a < k; a++) {
    for (let b = 0; b < k; b++) {
      let s = 0;
      for (let e = 0; e < k; e++) {
        s += vectors[a * k + e] * vectors[b * k + e] / Math.sqrt(values[e]);
      }
      invSqrt[a * k + b] = s;
    }
  }
  const rotation = new Float64Array(k * k);
  for (let a = 0; a < k; a++) {
    for (let b = 0; b < k; b++) {
      let s = 0;
      for (let e = 0; e < k; e++) s += m[a * k + e] * invSqrt[e * k + b];
      rotation[a * k + b] = s;
    }
  }
  const out = new Float64Array(items.length);
  for (let i = 0; i < films.length; i++) {
    for (let b = 0; b < k; b++) {
      let s = 0;
      for (let a = 0; a < k; a++) s += items[i * k + a] * rotation[a * k + b];
      out[i * k + b] = s;
    }
  }
  return out;
}

/* --------------------------------------------------------------------- *
 *  Lire la carte
 * --------------------------------------------------------------------- */

/**
 * La norme d'une position.
 * @param {Carte} carte La carte.
 * @param {number} row Rang du film.
 * @return {number} Norme.
 */
export function norm(carte: Carte, row: number): number {
  return Math.sqrt(dot(carte.vectors, carte.vectors, carte.k,
      row * carte.k, row * carte.k));
}

/**
 * La proximité de deux films sur la carte, de −1 à 1 : le cosinus de leurs
 * positions. Le cosinus et non le produit : la longueur d'une position dit
 * surtout combien le film est connu, pas à quoi il ressemble.
 * @param {Carte} carte La carte.
 * @param {number} a Rang du premier film.
 * @param {number} b Rang du second.
 * @return {number} Proximité.
 */
export function proximity(carte: Carte, a: number, b: number): number {
  const na = norm(carte, a);
  const nb = norm(carte, b);
  if (!(na > 0 && nb > 0)) return 0;
  return dot(carte.vectors, carte.vectors, carte.k,
      a * carte.k, b * carte.k) / (na * nb);
}

/**
 * La proximité d'un film à un point quelconque de la carte, de −1 à 1.
 * @param {Carte} carte La carte.
 * @param {number} row Rang du film.
 * @param {ArrayLike<number>} point Le point (k valeurs).
 * @param {number} pointNorm Sa norme, calculée une fois.
 * @return {number} Proximité.
 */
export function proximityTo(
    carte: Carte, row: number, point: ArrayLike<number>, pointNorm: number,
): number {
  const n = norm(carte, row);
  if (!(n > 0 && pointNorm > 0)) return 0;
  return dot(carte.vectors, point, carte.k, row * carte.k, 0) /
    (n * pointNorm);
}

/** Une personne placée sur la carte : un point, et son incertitude. */
export interface Placement {
  /** Le point, k valeurs. */
  mean: Float64Array;
  /**
   * La précision (l'inverse de l'incertitude), k × k : grande dans les
   * directions que la galerie a explorées, faible ailleurs.
   */
  precision: Float64Array;
  /** Le nombre de films de la galerie présents sur la carte. */
  count: number;
}

/**
 * Place une personne sur la carte depuis sa galerie : la passe « lignes » de
 * la factorisation, films fixés, pour elle seule. C'est une régression
 * régularisée, donc une régression bayésienne : la même formule donne le
 * point et son incertitude.
 * @param {Carte} carte La carte.
 * @param {GalleryMark[]} gallery Sa galerie.
 * @return {Placement} Sa position.
 */
export function placePerson(carte: Carte, gallery: GalleryMark[]): Placement {
  const {k, params} = carte;
  const precision = Float64Array.from(carte.gram);
  const b = new Float64Array(k);
  const obs = galleryObservations(gallery, carte.index, params);
  for (const o of obs) {
    if (o.c !== 1) addOuter(precision, carte.vectors, o.c - 1, k, o.item * k);
    if (o.p === 1) addScaled(b, carte.vectors, o.c, k, o.item * k);
  }
  for (let d = 0; d < k; d++) precision[d * k + d] += params.lambda;
  const mean = solveSpd(Float64Array.from(precision), b, k);
  return {mean, precision, count: obs.length};
}

/**
 * L'incertitude d'une position : l'inverse de sa précision.
 * @param {Float64Array} precision Précision k × k.
 * @param {number} k Dimension.
 * @return {Float64Array} Covariance k × k.
 */
export function covarianceOf(precision: Float64Array, k: number): Float64Array {
  return inverseSpd(Float64Array.from(precision), k);
}

/**
 * Les films les plus proches d'un film, du plus proche au moins proche.
 * @param {Carte} carte La carte.
 * @param {number} row Rang du film.
 * @param {number} count Nombre voulu.
 * @param {function(number): boolean} keep Filtre sur le rang.
 * @return {Array<{row: number, proximity: number}>} Voisins.
 */
export function neighbors(
    carte: Carte, row: number, count: number,
    keep: (row: number) => boolean = () => true,
): {row: number; proximity: number}[] {
  const out: {row: number; proximity: number}[] = [];
  for (let i = 0; i < carte.films.length; i++) {
    if (i === row || !keep(i)) continue;
    out.push({row: i, proximity: proximity(carte, row, i)});
  }
  out.sort((a, b) => b.proximity - a.proximity || a.row - b.row);
  return out.slice(0, count);
}

/* --------------------------------------------------------------------- *
 *  Ranger la carte
 * --------------------------------------------------------------------- */

/** Une carte rangée : un en-tête et des morceaux compressés. */
export interface EncodedCarte {
  manifest: {
    version: number;
    builtAt: number;
    k: number;
    count: number;
    params: CarteParams;
    chunks: number;
    axes?: Record<string, CarteAxis>;
  };
  chunks: Buffer[];
}

/** La taille d'un morceau, sous la limite d'un document Firestore (1 Mio). */
const CHUNK_BYTES = 900_000;

/**
 * Range la carte : les films en colonnes JSON, les positions en base64
 * (Float32), le tout compressé puis coupé en morceaux.
 * @param {Carte} carte La carte.
 * @return {EncodedCarte} La carte rangée.
 */
export function encodeCarte(carte: Carte): EncodedCarte {
  const f = carte.films;
  const columns = {
    id: f.map((x) => x.id),
    genres: f.map((x) => x.genres),
    keywords: f.map((x) => x.keywords),
    makers: f.map((x) => x.makers),
    sources: f.map((x) => x.sources),
    cast: f.map((x) => x.cast),
    collection: f.map((x) => x.collection),
    year: f.map((x) => x.year),
    releaseDate: f.map((x) => x.releaseDate ?? null),
    runtime: f.map((x) => x.runtime),
    voteCount: f.map((x) => x.voteCount),
    voteAverage: f.map((x) => Math.round(x.voteAverage * 100) / 100),
    providers: f.map((x) => x.providers),
    related: f.map((x) => x.related ?? []),
    fetchedDay: f.map((x) => x.fetchedDay ?? 0),
    support: Array.from(carte.support),
    vectors: Buffer.from(carte.vectors.buffer, carte.vectors.byteOffset,
        carte.vectors.byteLength).toString('base64'),
  };
  const packed = gzipSync(Buffer.from(JSON.stringify(columns), 'utf8'));
  const chunks: Buffer[] = [];
  for (let at = 0; at < packed.length; at += CHUNK_BYTES) {
    chunks.push(packed.subarray(at, at + CHUNK_BYTES));
  }
  return {
    manifest: {
      version: carte.version, builtAt: carte.builtAt, k: carte.k,
      count: f.length, params: carte.params, chunks: chunks.length,
      ...(carte.axes ? {axes: carte.axes} : {}),
    },
    chunks,
  };
}

/**
 * Relit une carte rangée.
 * @param {EncodedCarte} encoded La carte rangée.
 * @return {Carte} La carte.
 */
export function decodeCarte(encoded: EncodedCarte): Carte {
  const text = gunzipSync(Buffer.concat(encoded.chunks)).toString('utf8');
  const c = JSON.parse(text) as Record<string, unknown[]> & {vectors: string};
  const n = (c.id as number[]).length;
  const films: CarteFilm[] = [];
  for (let i = 0; i < n; i++) {
    films.push({
      id: (c.id as number[])[i],
      genres: (c.genres as number[][])[i],
      keywords: (c.keywords as number[][])[i],
      makers: (c.makers as number[][])[i],
      sources: (c.sources as number[][])[i],
      cast: (c.cast as number[][])[i],
      collection: (c.collection as (number | null)[])[i],
      year: (c.year as (number | null)[])[i],
      releaseDate: (c.releaseDate as (string | null)[] | undefined)?.[i] ??
        null,
      runtime: (c.runtime as (number | null)[])[i],
      voteCount: (c.voteCount as number[])[i],
      voteAverage: (c.voteAverage as number[])[i],
      providers: (c.providers as number[][])[i],
      related: (c.related as number[][] | undefined)?.[i] ?? [],
      fetchedDay: (c.fetchedDay as number[] | undefined)?.[i] ?? 0,
    });
  }
  const bytes = Buffer.from(c.vectors, 'base64');
  const vectors = new Float32Array(bytes.buffer.slice(
      bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const k = encoded.manifest.k;
  return {
    version: encoded.manifest.version,
    builtAt: encoded.manifest.builtAt,
    params: encoded.manifest.params,
    k,
    films,
    vectors,
    support: Int32Array.from(c.support as number[]),
    gram: gram(Float64Array.from(vectors), n, k),
    index: new Map(films.map((film, i) => [film.id, i])),
    ...(encoded.manifest.axes ? {axes: encoded.manifest.axes} : {}),
  };
}
