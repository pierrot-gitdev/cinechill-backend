/* ===================================================================== *
 *  La carte : la factorisation
 *
 *  Chaque film reçoit une position à k dimensions (32 par défaut), choisie
 *  pour expliquer à la fois trois tableaux :
 *
 *   - ce que nos utilisateurs ont dans leur galerie : vu, aimé, pas aimé ;
 *   - ce que TMDB recommande à qui a aimé chaque film, un spectateur type
 *     par film ;
 *   - ce que les films sont : les traits de leur fiche (genres, mots-clés,
 *     réalisateurs, acteurs, saga, décennie).
 *
 *  Les tableaux se factorisent ensemble (factorisation collective,
 *  Singh et Gordon, KDD 2008) : chaque trait de fiche y est traité comme un
 *  spectateur de plus, qui aurait vu tous les films qui le portent. Michael
 *  Mann est un spectateur qui a vu tous les films de Michael Mann. Un film
 *  que personne n'a encore dans sa galerie est donc placé par ses traits ; dès
 *  que des galeries le contiennent, ce sont elles qui le placent, et d'autant
 *  plus qu'elles sont nombreuses, sans part de mélange à régler.
 *
 *  La perte est celle des signaux implicites (Hu, Koren et Volinsky, ICDM
 *  2008) : pour chaque ligne r (une personne ou un trait) et chaque film i,
 *  une préférence p ∈ {0, 1} et une confiance c ≥ 1, sur toutes les cases,
 *  y compris celles qu'on n'a pas observées (p = 0, c = 1) :
 *
 *      Σ_r ω_r Σ_i c_ri (p_ri − x_r·y_i)²  +  λ (Σ‖x_r‖² + Σ‖y_i‖²)
 *
 *  Les moindres carrés alternés la minimisent sans jamais parcourir les cases
 *  non observées : leur part se résume à une matrice k × k (la somme des
 *  x xᵀ ou des y yᵀ), calculée une fois par passe.
 *
 *  Module pur : des tableaux en entrée, des tableaux en sortie.
 * ===================================================================== */

import {addOuter, addScaled, gaussian, rng, solveSpd} from './linalg';

/** Une case observée d'une ligne : un film, une préférence, une confiance. */
export interface Observation {
  item: number;
  /** 1 : vu, aimé, ou porte le trait ; 0 : « Pas aimé ». */
  p: 0 | 1;
  /** La confiance, au moins 1 ; une case non observée vaut 1. */
  c: number;
}

/** Une ligne de la factorisation : une personne ou un trait de fiche. */
export interface AlsRow {
  /** Le poids de la ligne : 1 pour une personne, la rareté pour un trait. */
  weight: number;
  obs: Observation[];
}

/** Les deux tableaux, rangés en lignes et en colonnes pour les deux passes. */
export interface AlsData {
  nItems: number;
  nRows: number;
  rowPtr: Int32Array;
  rowItem: Int32Array;
  rowP: Uint8Array;
  rowC: Float64Array;
  rowWeight: Float64Array;
  colPtr: Int32Array;
  colRow: Int32Array;
  colP: Uint8Array;
  colC: Float64Array;
}

export interface AlsOptions {
  /** La dimension de la carte. */
  k: number;
  /** La régularisation : retient près de zéro une position mal étayée. */
  lambda: number;
  /** Le nombre de passes alternées. */
  iterations: number;
  /** La graine du point de départ : même données, même carte. */
  seed: number;
}

export interface AlsResult {
  /** Positions des films, nItems × k, en ligne. */
  items: Float64Array;
  /** Positions des lignes (personnes puis traits), nRows × k. */
  rows: Float64Array;
}

/**
 * Range les lignes en deux index, par ligne et par film.
 * @param {number} nItems Nombre de films.
 * @param {AlsRow[]} rows Les lignes.
 * @return {AlsData} Les index.
 */
export function buildAlsData(nItems: number, rows: AlsRow[]): AlsData {
  const nRows = rows.length;
  let nnz = 0;
  for (const row of rows) nnz += row.obs.length;
  const rowPtr = new Int32Array(nRows + 1);
  const rowItem = new Int32Array(nnz);
  const rowP = new Uint8Array(nnz);
  const rowC = new Float64Array(nnz);
  const rowWeight = new Float64Array(nRows);
  const colCount = new Int32Array(nItems);
  let at = 0;
  rows.forEach((row, r) => {
    rowWeight[r] = row.weight;
    rowPtr[r] = at;
    for (const o of row.obs) {
      rowItem[at] = o.item;
      rowP[at] = o.p;
      rowC[at] = o.c;
      colCount[o.item]++;
      at++;
    }
  });
  rowPtr[nRows] = at;

  const colPtr = new Int32Array(nItems + 1);
  for (let i = 0; i < nItems; i++) colPtr[i + 1] = colPtr[i] + colCount[i];
  const fill = colPtr.slice(0, nItems);
  const colRow = new Int32Array(nnz);
  const colP = new Uint8Array(nnz);
  const colC = new Float64Array(nnz);
  for (let r = 0; r < nRows; r++) {
    for (let e = rowPtr[r]; e < rowPtr[r + 1]; e++) {
      const i = rowItem[e];
      const slot = fill[i]++;
      colRow[slot] = r;
      colP[slot] = rowP[e];
      colC[slot] = rowC[e];
    }
  }
  return {
    nItems, nRows, rowPtr, rowItem, rowP, rowC, rowWeight,
    colPtr, colRow, colP, colC,
  };
}

/**
 * La somme pondérée des v vᵀ d'un ensemble de vecteurs : la part des cases
 * non observées, commune à toutes les lignes d'une passe.
 * @param {Float64Array} vectors n × k.
 * @param {number} n Nombre de vecteurs.
 * @param {number} k Dimension.
 * @param {?Float64Array} weights Poids par vecteur, ou null (tous à 1).
 * @return {Float64Array} k × k.
 */
export function gram(
    vectors: Float64Array, n: number, k: number,
    weights: Float64Array | null = null,
): Float64Array {
  const g = new Float64Array(k * k);
  for (let r = 0; r < n; r++) {
    const w = weights ? weights[r] : 1;
    if (w === 0) continue;
    addOuter(g, vectors, w, k, r * k);
  }
  return g;
}

/**
 * Entraîne la carte.
 * @param {AlsData} data Les deux tableaux.
 * @param {AlsOptions} options Dimension, régularisation, passes, graine.
 * @param {?Float64Array} init Positions de départ des films (la carte
 *   précédente), ou null pour un départ aléatoire.
 * @return {AlsResult} Les positions.
 */
export function trainAls(
    data: AlsData, options: AlsOptions, init: Float64Array | null = null,
): AlsResult {
  const {k, lambda, iterations} = options;
  const {nItems, nRows} = data;
  const items = new Float64Array(nItems * k);
  if (init && init.length === nItems * k) {
    items.set(init);
  } else {
    const random = rng(options.seed);
    const scale = 0.1 / Math.sqrt(k);
    for (let e = 0; e < items.length; e++) items[e] = scale * gaussian(random);
  }
  const rows = new Float64Array(nRows * k);
  const a = new Float64Array(k * k);
  const b = new Float64Array(k);

  for (let pass = 0; pass < iterations; pass++) {
    // Les lignes, films fixés.
    const gItems = gram(items, nItems, k);
    for (let r = 0; r < nRows; r++) {
      const w = data.rowWeight[r];
      a.set(gItems);
      b.fill(0);
      for (let e = data.rowPtr[r]; e < data.rowPtr[r + 1]; e++) {
        const i = data.rowItem[e];
        const c = data.rowC[e];
        if (c !== 1) addOuter(a, items, c - 1, k, i * k);
        if (data.rowP[e] === 1) addScaled(b, items, c, k, i * k);
      }
      for (let e = 0; e < k * k; e++) a[e] *= w;
      for (let d = 0; d < k; d++) {
        a[d * k + d] += lambda;
        b[d] *= w;
      }
      rows.set(solveSpd(a, b, k), r * k);
    }
    // Les films, lignes fixées.
    const gRows = gram(rows, nRows, k, data.rowWeight);
    for (let i = 0; i < nItems; i++) {
      a.set(gRows);
      b.fill(0);
      for (let e = data.colPtr[i]; e < data.colPtr[i + 1]; e++) {
        const r = data.colRow[e];
        const w = data.rowWeight[r];
        const c = data.colC[e];
        if (c !== 1) addOuter(a, rows, w * (c - 1), k, r * k);
        if (data.colP[e] === 1) addScaled(b, rows, w * c, k, r * k);
      }
      for (let d = 0; d < k; d++) a[d * k + d] += lambda;
      items.set(solveSpd(a, b, k), i * k);
    }
  }
  return {items, rows};
}

/**
 * La perte totale, pour les vérifications (coûteuse : elle parcourt toutes
 * les cases). Elle doit décroître d'une passe à l'autre.
 * @param {AlsData} data Les deux tableaux.
 * @param {AlsResult} result Les positions.
 * @param {number} k Dimension.
 * @param {number} lambda Régularisation.
 * @return {number} La perte.
 */
export function alsLoss(
    data: AlsData, result: AlsResult, k: number, lambda: number,
): number {
  let loss = 0;
  for (let r = 0; r < data.nRows; r++) {
    const w = data.rowWeight[r];
    const observed = new Map<number, number>();
    for (let e = data.rowPtr[r]; e < data.rowPtr[r + 1]; e++) {
      observed.set(data.rowItem[e], e);
    }
    for (let i = 0; i < data.nItems; i++) {
      let pred = 0;
      for (let d = 0; d < k; d++) {
        pred += result.rows[r * k + d] * result.items[i * k + d];
      }
      const e = observed.get(i);
      const p = e === undefined ? 0 : data.rowP[e];
      const c = e === undefined ? 1 : data.rowC[e];
      loss += w * c * (p - pred) * (p - pred);
    }
  }
  let norm = 0;
  for (const v of result.rows) norm += v * v;
  for (const v of result.items) norm += v * v;
  return loss + lambda * norm;
}
