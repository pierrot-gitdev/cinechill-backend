/* ===================================================================== *
 *  La carte : les axes nommés
 *
 *  « Comme Heat, mais plus sombre » demande une direction de la carte qui
 *  veuille dire « sombre ». On l'apprend de comparaisons : deux films de la
 *  galerie, « Lequel est le plus sombre ? ». C'est l'étiquette la mieux
 *  mesurée pour un axe : sur MovieLens, une direction ajustée sur des
 *  comparaisons humaines range les films comme des juges à 0,5 à 0,7
 *  (gamma de Goodman-Kruskal), contre 0,2 pour des étiquettes de type
 *  mot-clé (Göpfert et al., WWW 2022).
 *
 *  La direction d se règle par une régression logistique sans constante sur
 *  les différences de positions des paires comparées, les « Pareil » mis de
 *  côté : P(a plus sombre que b) = σ(d · (ŷ_a − ŷ_b)), ŷ étant la position
 *  ramenée à la longueur 1 (comme l'affinité du soir, en cosinus).
 *
 *  Un axe ne sert qu'après trois contrôles, ceux de la proposition du 18
 *  octobre :
 *   1. au moins 70 % de paires dans le bon ordre, sur un cinquième des
 *      comparaisons mis de côté ;
 *   2. mieux que 200 axes ajustés sur des réponses mélangées ;
 *   3. le même classement d'une semaine à l'autre (corrélation des rangs
 *      d'au moins 0,9 sur les films les plus connus).
 *  Tant qu'il ne les passe pas, « Plus sombre » garde la règle de la fiche.
 *
 *  Module pur.
 * ===================================================================== */

import {Carte} from './model';
import {dot, solveSpd} from './linalg';

/** Une réponse : la paire, et le film désigné (null pour « Pareil »). */
export interface AxisAnswer {
  a: number;
  b: number;
  darker: number | null;
}

/** Un axe appris, et ses contrôles. */
export interface CarteAxis {
  /** Comparaisons utilisables (sans « Pareil », films de la carte). */
  n: number;
  /** La direction, de longueur 1, ou null faute de comparaisons. */
  direction: number[] | null;
  /** Part des paires mises de côté rangées dans le bon ordre. */
  heldOut: number | null;
  /** La meilleure des 200 directions ajustées sur des réponses mélangées. */
  shuffledBest: number | null;
  /** Corrélation des rangs avec l'axe de la semaine précédente. */
  stability: number | null;
  /** L'écart type des films le long de l'axe, pour les retouches. */
  spread: number | null;
  validated: boolean;
}

/** En deçà, on n'essaie même pas : le hasard ferait illusion. */
export const AXIS_MIN_ANSWERS = 200;
export const AXIS_MIN_HELD_OUT = 0.7;
export const AXIS_SHUFFLES = 200;
export const AXIS_MIN_STABILITY = 0.9;
/** La régularisation de la régression. */
const AXIS_LAMBDA = 1;
/** Les films sur lesquels se mesure la stabilité : les plus connus. */
const STABILITY_FILMS = 2000;

/**
 * La position d'un film ramenée à la longueur 1.
 * @param {Carte} carte La carte.
 * @param {number} row Rang du film.
 * @return {Float64Array} La direction du film.
 */
function unit(carte: Carte, row: number): Float64Array {
  const y = Float64Array.from(
      carte.vectors.subarray(row * carte.k, (row + 1) * carte.k));
  const n = Math.hypot(...y) || 1;
  for (let d = 0; d < carte.k; d++) y[d] /= n;
  return y;
}

/**
 * Les exemples d'apprentissage : une différence de positions par réponse,
 * orientée pour que le film le plus sombre vienne en premier.
 * @param {Carte} carte La carte.
 * @param {AxisAnswer[]} answers Les réponses.
 * @return {Array<Object>} Exemples `{x, key}`.
 */
export function axisExamples(
    carte: Carte, answers: AxisAnswer[],
): {x: Float64Array; key: number}[] {
  const out: {x: Float64Array; key: number}[] = [];
  for (const answer of answers) {
    if (answer.darker === null) continue;
    const ra = carte.index.get(answer.a);
    const rb = carte.index.get(answer.b);
    if (ra === undefined || rb === undefined || ra === rb) continue;
    const [dark, light] = answer.darker === answer.a ? [ra, rb] :
      answer.darker === answer.b ? [rb, ra] : [-1, -1];
    if (dark < 0) continue;
    const yd = unit(carte, dark);
    const yl = unit(carte, light);
    const x = Float64Array.from(yd, (v, d) => v - yl[d]);
    // La clé range une paire toujours du même côté de la coupe, quel que
    // soit l'ordre où elle a été posée.
    const lo = Math.min(answer.a, answer.b);
    const hi = Math.max(answer.a, answer.b);
    out.push({x, key: ((lo * 2654435761) ^ hi) >>> 0});
  }
  return out;
}

/**
 * La régression logistique sans constante, par la méthode de Newton.
 * Chaque exemple est orienté (le plus sombre en premier) ; `signs` peut le
 * retourner, pour les réponses mélangées.
 * @param {Float64Array[]} xs Les différences.
 * @param {number[]} signs +1 ou −1 par exemple.
 * @param {number} k Dimension.
 * @return {Float64Array} La direction (non normée).
 */
export function fitDirection(
    xs: Float64Array[], signs: number[], k: number,
): Float64Array {
  const w = new Float64Array(k);
  for (let iteration = 0; iteration < 12; iteration++) {
    const g = new Float64Array(k);
    const h = new Float64Array(k * k);
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      const s = signs[i];
      const z = s * dot(w, x, k);
      const p = 1 / (1 + Math.exp(-z));
      const r = (1 - p) * s;
      const curvature = p * (1 - p);
      for (let a = 0; a < k; a++) {
        g[a] += r * x[a];
        const xa = curvature * x[a];
        for (let b = 0; b < k; b++) h[a * k + b] += xa * x[b];
      }
    }
    for (let a = 0; a < k; a++) {
      g[a] -= AXIS_LAMBDA * w[a];
      h[a * k + a] += AXIS_LAMBDA;
    }
    const step = solveSpd(h, g, k);
    let size = 0;
    for (let a = 0; a < k; a++) {
      w[a] += step[a];
      size += step[a] * step[a];
    }
    if (size < 1e-12) break;
  }
  return w;
}

/**
 * La part d'exemples rangés dans le bon ordre par une direction.
 * @param {Float64Array} w La direction.
 * @param {Float64Array[]} xs Les différences.
 * @param {number[]} signs Les orientations.
 * @param {number} k Dimension.
 * @return {number} De 0 à 1.
 */
function agreement(
    w: Float64Array, xs: Float64Array[], signs: number[], k: number,
): number {
  if (xs.length === 0) return 0;
  let good = 0;
  xs.forEach((x, i) => {
    if (signs[i] * dot(w, x, k) > 0) good++;
  });
  return good / xs.length;
}

/**
 * La corrélation des rangs de deux listes de valeurs (Spearman).
 * @param {number[]} a Première liste.
 * @param {number[]} b Seconde liste, même longueur.
 * @return {number} De −1 à 1.
 */
export function rankCorrelation(a: number[], b: number[]): number {
  const ranks = (v: number[]) => {
    const order = v.map((x, i) => ({x, i})).sort((p, q) => p.x - q.x);
    const r = new Array<number>(v.length);
    order.forEach((entry, rank) => {
      r[entry.i] = rank;
    });
    return r;
  };
  const ra = ranks(a);
  const rb = ranks(b);
  const n = a.length;
  if (n < 2) return 0;
  const mean = (n - 1) / 2;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - mean) * (rb[i] - mean);
    da += (ra[i] - mean) ** 2;
    db += (rb[i] - mean) ** 2;
  }
  return num / Math.sqrt(da * db);
}

/**
 * La position de chaque film le long d'un axe.
 * @param {Carte} carte La carte.
 * @param {ArrayLike<number>} direction La direction, de longueur 1.
 * @return {Float64Array} Une valeur par film.
 */
export function projections(
    carte: Carte, direction: ArrayLike<number>,
): Float64Array {
  const out = new Float64Array(carte.films.length);
  for (let row = 0; row < carte.films.length; row++) {
    out[row] = dot(unit(carte, row), direction, carte.k);
  }
  return out;
}

/**
 * Apprend un axe et le soumet à ses trois contrôles.
 * @param {Carte} carte La carte de la semaine.
 * @param {AxisAnswer[]} answers Toutes les réponses reçues.
 * @param {?{carte: Carte, axis: ?CarteAxis}} previous La carte et l'axe de
 *   la semaine précédente, pour la stabilité.
 * @param {function(): number} random Tirage uniforme (réponses mélangées).
 * @return {CarteAxis} L'axe.
 */
export function buildAxis(
    carte: Carte, answers: AxisAnswer[],
    previous: {carte: Carte; axis: CarteAxis | null | undefined} | null,
    random: () => number,
): CarteAxis {
  const {k} = carte;
  const examples = axisExamples(carte, answers);
  const empty: CarteAxis = {
    n: examples.length, direction: null, heldOut: null, shuffledBest: null,
    stability: null, spread: null, validated: false,
  };
  if (examples.length < AXIS_MIN_ANSWERS) return empty;

  const train = examples.filter((e) => e.key % 5 !== 0);
  const test = examples.filter((e) => e.key % 5 === 0);
  const ones = (n: number) => new Array<number>(n).fill(1);
  const fitted = fitDirection(train.map((e) => e.x), ones(train.length), k);
  const heldOut = agreement(fitted, test.map((e) => e.x), ones(test.length), k);

  // Des réponses mélangées : chaque paire garde ses films, mais son sens
  // est tiré à pile ou face.
  let shuffledBest = 0;
  for (let t = 0; t < AXIS_SHUFFLES; t++) {
    const signs = examples.map(() => (random() < 0.5 ? 1 : -1));
    const trainSigns = signs.filter((_, i) => examples[i].key % 5 !== 0);
    const testSigns = signs.filter((_, i) => examples[i].key % 5 === 0);
    const w = fitDirection(train.map((e) => e.x), trainSigns, k);
    shuffledBest = Math.max(shuffledBest,
        agreement(w, test.map((e) => e.x), testSigns, k));
  }

  const all = fitDirection(examples.map((e) => e.x), ones(examples.length), k);
  const length = Math.hypot(...all) || 1;
  const direction = Array.from(all, (v) => v / length);
  const along = projections(carte, direction);
  const mean = along.reduce((s, v) => s + v, 0) / along.length;
  const spread = Math.sqrt(along.reduce((s, v) => s + (v - mean) ** 2, 0) /
    along.length);

  let stability: number | null = null;
  const before = previous?.axis?.direction;
  if (previous && before) {
    const known = carte.films
        .map((film, row) => ({film, row}))
        .filter(({film}) => previous.carte.index.has(film.id))
        .sort((a, b) => b.film.voteCount - a.film.voteCount)
        .slice(0, STABILITY_FILMS);
    const now = known.map(({row}) => along[row]);
    const then = known.map(({film}) => dot(
        unit(previous.carte, previous.carte.index.get(film.id) as number),
        before, k));
    stability = rankCorrelation(now, then);
  }

  return {
    n: examples.length,
    direction,
    heldOut,
    shuffledBest,
    stability,
    spread,
    validated: heldOut >= AXIS_MIN_HELD_OUT && heldOut > shuffledBest &&
      stability !== null && stability >= AXIS_MIN_STABILITY,
  };
}
