/* ===================================================================== *
 *  Le moteur du soir sur la carte
 *
 *  Le goût durable d'une personne est un point de la carte et son
 *  incertitude, calculés depuis sa galerie (`placePerson`). Un soir peut
 *  s'en écarter : le point du soir part d'un nuage plus large, N(x, Σ + γ²I),
 *  puis chaque toucher le déplace et le resserre.
 *
 *  Deux sortes de touchers le déplacent.
 *
 *  Le film de départ (« Un film proche de Heat ») et le second film disent
 *  la cible du soir. Le point saute vers leur position, pour une part w
 *  (60 %, la part que le moteur d'aujourd'hui donne au film choisi), et le
 *  nuage se resserre d'autant.
 *  Un modèle de choix seul ne le ferait pas : prendre le film que le moteur
 *  préférait déjà ne lui apprend presque rien, et le point ne bougeait pas
 *  (mesuré le 18 octobre, `scripts/carte/evening-check.mjs`).
 *
 *  Les autres touchers sont des comparaisons : le film pris parmi les six
 *  de son écran, « Pile comme Heat », « Pas ceux-là », « Pas celui-là ».
 *  Ils suivent un modèle logit : la probabilité de prendre le film j est
 *  exp(y_j·μ/τ) / (exp(u₀/τ) + Σ exp(y_k·μ/τ)), « aucun » valant u₀. Le
 *  point se met à jour par une étape de Newton (approximation de Laplace) :
 *
 *      g = (y_choisi − ȳ) / τ        (« aucun » : g = −ȳ / τ)
 *      H = (Σ π_j y_j y_jᵀ − ȳ ȳᵀ) / τ²
 *      Λ ← Λ + H,   μ ← μ + Λ⁻¹ g
 *
 *  H a un rang au plus égal au nombre de films montrés : un toucher ne
 *  déplace le point que dans les directions que ces films couvrent, le reste
 *  garde la valeur du goût durable.
 *
 *  Les écrans et les cinq se remplissent par tirages de Thompson : on tire
 *  un point dans le nuage, on prend ce qui lui correspond le mieux. Plus le
 *  moteur hésite, plus il essaie autre chose ; et la fréquence d'un film sur
 *  cent tirages donne sa probabilité d'affichage, journalisée pour mesurer.
 *  Le nuage a 32 directions : tiré tel quel, il rendait des cinq presque
 *  au hasard. Les tirages se font dans un nuage réduit d'un facteur s.
 *
 *  Les réglages ont été choisis sur la vraie carte le 18 octobre, avec des
 *  soirées simulées (`scripts/carte/evening-check.mjs`) : le film choisi
 *  compte pour moitié des 20 premiers, l'écran « Plutôt du côté de… » est
 *  posé une fois sur trois, et la proposition change peu d'un tirage à
 *  l'autre.
 *
 *  Module pur : la carte, des rangs, des vecteurs ; rien de Firebase.
 * ===================================================================== */

import {Carte, GalleryMark, placePerson} from './model';
import {cholesky, dot, gaussian, inverseSpd, solveSpd} from './linalg';

/** Les réglages du soir. Ils seront ajustés sur les soirées journalisées. */
export interface EveningParams {
  /** σ² : l'échelle de l'incertitude du goût durable. */
  sigma2: number;
  /** w : la part de la cible du soir (film de départ, second film). */
  targetWeight: number;
  /**
   * s : l'échelle des tirages de Thompson dans le nuage. À 0,15, deux
   * tirages des cinq ont en moyenne 3,9 films en commun ; à 1, presque
   * aucun (mesuré le 18 octobre).
   */
  explore: number;
  /** γ : de combien un soir peut s'écarter du goût habituel. */
  gamma: number;
  /** τ : la netteté des choix ; plus petit, plus un toucher déplace. */
  tau: number;
  /** u₀ : ce que vaut « aucun de ceux-là » face aux films montrés. */
  u0: number;
  /**
   * β : le poids de la réception face à l'affinité, en écarts types. À 0,5,
   * avec la fiche à 1, la réception compte pour 20 % avec un film choisi,
   * comme dans le moteur d'aujourd'hui (`SHARES_WITH_ANCHOR`).
   */
  beta: number;
  /** δ : la pénalité de ressemblance entre deux films des cinq. */
  delta: number;
  /** η : le poids de la fiche (ressemblance au film choisi). */
  eta: number;
  /**
   * α : l'affinité d'un film est y·e / ‖y‖^α. La longueur d'une position dit
   * surtout combien le film revient dans les galeries et les listes de
   * recommandations : les grandes sagas y sont trois à cinq fois plus
   * longues que leurs voisins. À α = 0 (le produit), le point d'Interstellar
   * plaçait Star Wars : L'Ascension de Skywalker en tête et Interstellar
   * douzième (mesuré le 18 octobre).
   */
  normPower: number;
  /**
   * Le nombre de galeries à partir duquel la carte compte plus que la
   * fiche pour un film : le poids de la fiche vaut η · n₀ / (n₀ + n).
   */
  supportHalf: number;
}

/**
 * Les réglages de départ, choisis pour que le film choisi compte pour
 * environ 60 % des cinq, comme le moteur d'aujourd'hui (voir
 * `scripts/carte/evening-check.mjs`, qui le mesure).
 */
export const DEFAULT_EVENING_PARAMS: EveningParams = {
  sigma2: 1,
  targetWeight: 0.6,
  explore: 0.15,
  gamma: 0.35,
  tau: 0.05,
  u0: 0,
  beta: 0.5,
  delta: 1,
  eta: 1,
  supportHalf: 20,
  normPower: 1,
};

/** Le point du soir : une moyenne et une précision (l'inverse du nuage). */
export interface EveningPoint {
  k: number;
  mean: Float64Array;
  precision: Float64Array;
}

/**
 * La position d'un film de la carte, en double précision.
 * @param {Carte} carte La carte.
 * @param {number} row Rang du film.
 * @return {Float64Array} Son vecteur.
 */
export function vectorOf(carte: Carte, row: number): Float64Array {
  return Float64Array.from(
      carte.vectors.subarray(row * carte.k, (row + 1) * carte.k));
}

/**
 * Le point de départ d'un soir : le goût durable, élargi de γ.
 * @param {Carte} carte La carte.
 * @param {GalleryMark[]} gallery La galerie.
 * @param {EveningParams} params Réglages.
 * @return {EveningPoint} Le point.
 */
export function eveningPrior(
    carte: Carte, gallery: GalleryMark[], params: EveningParams,
): EveningPoint {
  const {k} = carte;
  const placed = placePerson(carte, gallery);
  const cov = inverseSpd(Float64Array.from(placed.precision), k);
  for (let e = 0; e < k * k; e++) cov[e] *= params.sigma2;
  for (let d = 0; d < k; d++) cov[d * k + d] += params.gamma * params.gamma;
  return {k, mean: placed.mean, precision: inverseSpd(cov, k)};
}

const spreads = new WeakMap<Carte, {mean: Float64Array; n: number}>();

/**
 * L'étalement des notes que donne un point sur toute la carte : l'écart
 * type de y·v sur les films, √(vᵀ C v), C étant la covariance des positions.
 * @param {Carte} carte La carte.
 * @param {ArrayLike<number>} v Le point.
 * @return {number} L'écart type.
 */
export function spreadOf(carte: Carte, v: ArrayLike<number>): number {
  const {k} = carte;
  let cached = spreads.get(carte);
  if (!cached) {
    const mean = new Float64Array(k);
    const n = carte.films.length;
    for (let i = 0; i < n; i++) {
      for (let d = 0; d < k; d++) mean[d] += carte.vectors[i * k + d] / n;
    }
    cached = {mean, n};
    spreads.set(carte, cached);
  }
  let second = 0;
  for (let a = 0; a < k; a++) {
    for (let b = 0; b < k; b++) second += v[a] * carte.gram[a * k + b] * v[b];
  }
  const m = dot(cached.mean, v, k);
  return Math.sqrt(Math.max(0, second / cached.n - m * m));
}

/**
 * La cible du soir : le point saute, pour une part w, vers la moyenne des
 * positions des films choisis, et le nuage se resserre d'autant.
 *
 * Chaque cible est ramenée au même étalement que le point (même écart type
 * des notes sur la carte) : c'est ce qui fait de w la part du film choisi
 * dans le classement. Ramenée seulement à la même longueur, une galerie
 * entière, qui sépare les films bien plus nettement qu'un seul film,
 * gardait le dessus malgré w = 0,6 (mesuré le 18 octobre).
 * @param {Carte} carte La carte.
 * @param {EveningPoint} point Le point avant le film de départ.
 * @param {Float64Array[]} targets Les positions des films choisis.
 * @param {EveningParams} params Réglages.
 * @return {EveningPoint} Le point du soir.
 */
export function declareTargets(
    carte: Carte, point: EveningPoint, targets: Float64Array[],
    params: EveningParams,
): EveningPoint {
  const {k} = point;
  if (targets.length === 0) return point;
  const spread = spreadOf(carte, point.mean);
  const target = new Float64Array(k);
  for (const t of targets) {
    const own = spreadOf(carte, t) || 1;
    const scale = (spread > 0 ? spread / own : 1) / targets.length;
    for (let d = 0; d < k; d++) target[d] += scale * t[d];
  }
  const w = params.targetWeight;
  const mean = Float64Array.from(point.mean,
      (v, d) => (1 - w) * v + w * target[d]);
  const precision = Float64Array.from(point.precision, (v) => v / (1 - w));
  return {k, mean, precision};
}

/**
 * Un choix parmi des films montrés : le point se déplace vers le film pris
 * (ou s'éloigne de tous, si aucun ne l'a été) et se resserre dans les
 * directions que ces films couvrent.
 * @param {EveningPoint} point Le point du soir.
 * @param {Float64Array[]} shown Les vecteurs des films montrés.
 * @param {?number} chosen L'indice du film pris dans `shown`, ou null pour
 *   « aucun de ceux-là ».
 * @param {EveningParams} params Réglages.
 * @return {EveningPoint} Le point mis à jour.
 */
export function updateChoice(
    point: EveningPoint, shown: Float64Array[], chosen: number | null,
    params: EveningParams,
): EveningPoint {
  const {k} = point;
  if (shown.length === 0) return point;
  const {tau} = params;
  const utilities = shown.map((y) => dot(y, point.mean, k) / tau);
  const top = Math.max(params.u0 / tau, ...utilities);
  const weights = utilities.map((u) => Math.exp(u - top));
  const total = Math.exp(params.u0 / tau - top) +
    weights.reduce((s, w) => s + w, 0);
  const pi = weights.map((w) => w / total);
  const mean = new Float64Array(k);
  shown.forEach((y, j) => {
    for (let d = 0; d < k; d++) mean[d] += pi[j] * y[d];
  });
  const g = new Float64Array(k);
  for (let d = 0; d < k; d++) {
    g[d] = ((chosen === null ? 0 : shown[chosen][d]) - mean[d]) / tau;
  }
  const precision = Float64Array.from(point.precision);
  const t2 = tau * tau;
  shown.forEach((y, j) => {
    for (let a = 0; a < k; a++) {
      const ya = pi[j] * y[a] / t2;
      for (let b = 0; b < k; b++) precision[a * k + b] += ya * y[b];
    }
  });
  for (let a = 0; a < k; a++) {
    for (let b = 0; b < k; b++) {
      precision[a * k + b] -= mean[a] * mean[b] / t2;
    }
  }
  const step = solveSpd(Float64Array.from(precision), g, k);
  const next = Float64Array.from(point.mean);
  for (let d = 0; d < k; d++) next[d] += step[d];
  return {k, mean: next, precision};
}

/**
 * La probabilité de chaque réponse à un écran, au point du soir : chacun des
 * films montrés, puis « aucun ».
 * @param {EveningPoint} point Le point.
 * @param {Float64Array[]} shown Les vecteurs des films montrés.
 * @param {EveningParams} params Réglages.
 * @return {number[]} Probabilités, `shown.length + 1` valeurs.
 */
export function choiceProbabilities(
    point: EveningPoint, shown: Float64Array[], params: EveningParams,
): number[] {
  const u = [...shown.map((y) => dot(y, point.mean, point.k)), params.u0]
      .map((v) => v / params.tau);
  const top = Math.max(...u);
  const w = u.map((v) => Math.exp(v - top));
  const total = w.reduce((s, x) => s + x, 0);
  return w.map((x) => x / total);
}

/**
 * Un tirage dans le nuage du soir : μ + s L⁻ᵀ z, avec Λ = L Lᵀ.
 * @param {EveningPoint} point Le point.
 * @param {function(): number} random Tirage uniforme.
 * @param {number} scale L'échelle s du nuage.
 * @return {Float64Array} Un point tiré.
 */
export function drawPoint(
    point: EveningPoint, random: () => number, scale = 1,
): Float64Array {
  const {k} = point;
  const l = Float64Array.from(point.precision);
  cholesky(l, k);
  const x = new Float64Array(k);
  for (let d = 0; d < k; d++) x[d] = gaussian(random);
  // Lᵀ x = z, en remontant.
  for (let i = k - 1; i >= 0; i--) {
    let s = x[i];
    for (let p = i + 1; p < k; p++) s -= l[p * k + i] * x[p];
    x[i] = s / l[i * k + i];
  }
  for (let d = 0; d < k; d++) x[d] = point.mean[d] + scale * x[d];
  return x;
}

/**
 * Remplit un écran de films de la galerie par tirages de Thompson : pour
 * chaque place, un point tiré dans le nuage, et le film qui lui correspond
 * le mieux, sans doublon ni deux films de la même saga.
 * @param {Carte} carte La carte.
 * @param {number[]} rows Les films possibles (rangs de la carte).
 * @param {EveningPoint} point Le point du soir.
 * @param {number} count Nombre de places.
 * @param {EveningParams} params Réglages.
 * @param {function(): number} random Tirage uniforme.
 * @return {number[]} Les rangs retenus, dans l'ordre des tirages.
 */
export function drawScreen(
    carte: Carte, rows: number[], point: EveningPoint, count: number,
    params: EveningParams, random: () => number,
): number[] {
  const out: number[] = [];
  const sagas = new Set<number>();
  const left = new Set(rows);
  while (out.length < count && left.size > 0) {
    const e = drawPoint(point, random, params.explore);
    let best = -1;
    let bestScore = -Infinity;
    for (const row of left) {
      const s = dot(carte.vectors, e, carte.k, row * carte.k, 0);
      if (s > bestScore || (s === bestScore && row < best)) {
        best = row;
        bestScore = s;
      }
    }
    left.delete(best);
    const saga = carte.films[best].collection;
    if (saga !== null && sagas.has(saga)) continue;
    if (saga !== null) sagas.add(saga);
    out.push(best);
  }
  return out;
}

/** Les candidats des cinq, préparés une fois pour tous les tirages. */
export interface Candidates {
  rows: number[];
  /** La réception de chaque candidat (note lissée par les votes). */
  reception: Float64Array;
  /**
   * La ressemblance de fiche de chaque candidat aux films choisis, de 0 à 1,
   * ou null sans film choisi.
   */
  fiche: Float64Array | null;
  /** Le poids de la fiche pour chacun : η · n₀ / (n₀ + n). */
  ficheWeight: Float64Array;
  /** L'avance d'un film qui tient la soirée quand il a fallu élargir. */
  bonus: Float64Array;
  /** Les normes de leurs positions, pour les cosinus. */
  norms: Float64Array;
}

/**
 * Des valeurs centrées réduites, sur les indices donnés.
 * @param {ArrayLike<number>} raw Valeurs.
 * @param {number[]} at Les indices pris en compte.
 * @return {Map<number, number>} Indice → écart à la moyenne, en écarts types.
 */
function standardizeAt(
    raw: ArrayLike<number>, at: number[],
): Map<number, number> {
  const n = Math.max(1, at.length);
  const mean = at.reduce((s, i) => s + raw[i], 0) / n;
  const sd = Math.sqrt(at.reduce((s, i) => s + (raw[i] - mean) ** 2, 0) / n) ||
    1;
  return new Map(at.map((i) => [i, (raw[i] - mean) / sd]));
}

/**
 * Prépare les candidats.
 *
 * La fiche pèse η · n₀ / (n₀ + n), n étant le nombre de galeries qui
 * contiennent le candidat. Sans galeries, la carte est faite des fiches et
 * des recommandations de TMDB : elle retrouve les voisinages mais perd une
 * part de l'identité précise d'un film (un même réalisateur). Mesuré le 18
 * octobre sur les listes de référence, la carte seule plaçait 22 films
 * attendus dans les 20 premiers contre 31 pour la fiche ; le mélange en
 * place 33, et 50 dans les 50 premiers contre 36. C'est la règle D1 : la
 * fiche place les films que nos galeries ne connaissent pas encore, et
 * s'efface à mesure qu'elles en parlent.
 * @param {Carte} carte La carte.
 * @param {number[]} rows Les films qui passent les filtres du soir.
 * @param {function(number): number} receptionOf Réception d'un rang.
 * @param {?function(number): number} similarityOf Ressemblance de fiche
 *   d'un rang aux films choisis, ou null sans film choisi.
 * @param {?function(number): number} bonusOf Avance d'un rang, ou null.
 * @param {EveningParams} params Réglages.
 * @return {Candidates} Les candidats.
 */
export function prepareCandidates(
    carte: Carte, rows: number[], receptionOf: (row: number) => number,
    similarityOf: ((row: number) => number) | null,
    bonusOf: ((row: number) => number) | null, params: EveningParams,
): Candidates {
  return {
    rows,
    reception: Float64Array.from(rows, receptionOf),
    fiche: similarityOf ? Float64Array.from(rows, similarityOf) : null,
    ficheWeight: Float64Array.from(rows, (row) => params.eta *
      params.supportHalf / (params.supportHalf + carte.support[row])),
    bonus: bonusOf ? Float64Array.from(rows, bonusOf) :
      new Float64Array(rows.length),
    norms: Float64Array.from(rows, (row) => Math.sqrt(
        dot(carte.vectors, carte.vectors, carte.k, row * carte.k,
            row * carte.k)) || 1),
  };
}

/** Les candidats notés en détail, comme le vivier du moteur d'aujourd'hui. */
const SCORE_POOL = 200;
/** Le plafond d'un écart de réception, en écarts types (`TERM_CLAMP`). */
const RECEPTION_CLAMP = 2;

/**
 * La note de chaque candidat pour un point, en deux temps, comme le moteur
 * d'aujourd'hui qui choisit d'abord un vivier de films proches puis les
 * note entre eux :
 *
 *  1. les 200 premiers par affinité (y·e) et ressemblance de fiche, sur
 *     tout le catalogue ;
 *  2. entre eux seulement : l'affinité, la fiche et la réception, centrées
 *     réduites sur ce vivier, la réception plafonnée à deux écarts types.
 *
 * Notées sur tout le catalogue, les affinités des meilleurs films
 * atteignaient sept écarts types : la réception ne départageait plus rien
 * parmi eux. Les autres candidats valent −∞.
 * @param {Carte} carte La carte.
 * @param {Candidates} c Les candidats.
 * @param {ArrayLike<number>} e Le point.
 * @param {EveningParams} params Réglages.
 * @return {Float64Array} Notes, dans l'ordre de `c.rows`.
 */
export function scoreCandidates(
    carte: Carte, c: Candidates, e: ArrayLike<number>, params: EveningParams,
): Float64Array {
  const n = c.rows.length;
  const all = Array.from({length: n}, (_, i) => i);
  const affinity = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    affinity[i] = dot(carte.vectors, e, carte.k, c.rows[i] * carte.k, 0) /
      Math.pow(c.norms[i], params.normPower);
  }
  const zAll = standardizeAt(affinity, all);
  const fAll = c.fiche ? standardizeAt(c.fiche, all) : null;
  const first = (i: number) => (zAll.get(i) as number) +
    (fAll ? c.ficheWeight[i] * (fAll.get(i) as number) : 0) + c.bonus[i];
  const pool = all.sort((a, b) => first(b) - first(a) || a - b)
      .slice(0, SCORE_POOL);
  const zPool = standardizeAt(affinity, pool);
  const fPool = c.fiche ? standardizeAt(c.fiche, pool) : null;
  const rPool = standardizeAt(c.reception, pool);
  const out = new Float64Array(n).fill(-Infinity);
  for (const i of pool) {
    const reception = Math.max(-RECEPTION_CLAMP,
        Math.min(RECEPTION_CLAMP, rPool.get(i) as number));
    out[i] = (zPool.get(i) as number) +
      (fPool ? c.ficheWeight[i] * (fPool.get(i) as number) : 0) +
      params.beta * reception + c.bonus[i];
  }
  return out;
}

/** Au-delà, un candidat n'a aucune chance d'entrer dans les cinq. */
const COMPOSE_SHORTLIST = 200;

/**
 * Compose les cinq : à chaque place, le meilleur candidat une fois retirée
 * sa ressemblance au plus proche des films déjà retenus (δ × cosinus), une
 * saga une fois.
 * @param {Carte} carte La carte.
 * @param {Candidates} c Les candidats.
 * @param {Float64Array} notes Leurs notes.
 * @param {number} count Nombre voulu.
 * @param {EveningParams} params Réglages.
 * @return {number[]} Indices dans `c.rows`, dans l'ordre.
 */
export function compose(
    carte: Carte, c: Candidates, notes: Float64Array, count: number,
    params: EveningParams,
): number[] {
  const order = Array.from(notes.keys())
      .filter((i) => notes[i] > -Infinity)
      .sort((a, b) => notes[b] - notes[a] || c.rows[a] - c.rows[b])
      .slice(0, COMPOSE_SHORTLIST);
  const chosen: number[] = [];
  const sagas = new Set<number>();
  const closest = new Float64Array(order.length).fill(-Infinity);
  const k = carte.k;
  while (chosen.length < count) {
    let best = -1;
    let bestValue = -Infinity;
    order.forEach((i, at) => {
      if (closest[at] === Infinity) return;
      const saga = carte.films[c.rows[i]].collection;
      if (saga !== null && sagas.has(saga)) return;
      const penalty = chosen.length === 0 ? 0 :
        params.delta * Math.max(0, closest[at]);
      const value = notes[i] - penalty;
      if (value > bestValue) {
        best = at;
        bestValue = value;
      }
    });
    if (best < 0) break;
    const i = order[best];
    chosen.push(i);
    closest[best] = Infinity;
    const saga = carte.films[c.rows[i]].collection;
    if (saga !== null) sagas.add(saga);
    const ri = c.rows[i] * k;
    order.forEach((j, at) => {
      if (closest[at] === Infinity) return;
      const cos = dot(carte.vectors, carte.vectors, k, ri, c.rows[j] * k) /
        (c.norms[i] * c.norms[j]);
      if (cos > closest[at]) closest[at] = cos;
    });
  }
  return chosen;
}

/** Les cinq tirés, et la probabilité d'affichage de chaque film montré. */
export interface Slate {
  /** Rangs de la carte, dans l'ordre. */
  rows: number[];
  /** Fréquence de chaque film montré dans les cinq, sur tous les tirages. */
  propensity: Map<number, number>;
  /** Le classement complet du premier tirage, pour remplacer un film. */
  ranked: number[];
}

/**
 * Les cinq d'un soir : un tirage dans le nuage, puis la composition. Cent
 * tirages de plus mesurent la probabilité d'affichage de chaque film.
 * @param {Carte} carte La carte.
 * @param {Candidates} c Les candidats.
 * @param {EveningPoint} point Le point du soir.
 * @param {number} count Nombre voulu.
 * @param {EveningParams} params Réglages.
 * @param {function(): number} random Tirage uniforme.
 * @param {number} draws Tirages pour la probabilité d'affichage.
 * @return {Slate} Les cinq.
 */
export function drawSlate(
    carte: Carte, c: Candidates, point: EveningPoint, count: number,
    params: EveningParams, random: () => number, draws = 100,
): Slate {
  const notesOf = (e: Float64Array) => scoreCandidates(carte, c, e, params);
  const first = notesOf(drawPoint(point, random, params.explore));
  const picked = compose(carte, c, first, count, params);
  const counts = new Map<number, number>();
  for (let t = 0; t < draws; t++) {
    for (const i of compose(carte, c,
        notesOf(drawPoint(point, random, params.explore)), count, params)) {
      counts.set(i, (counts.get(i) ?? 0) + 1);
    }
  }
  const propensity = new Map<number, number>();
  for (const i of picked) {
    propensity.set(c.rows[i], (counts.get(i) ?? 0) / Math.max(1, draws));
  }
  const ranked = Array.from(first.keys())
      .sort((a, b) => first[b] - first[a] || c.rows[a] - c.rows[b])
      .map((i) => c.rows[i]);
  return {rows: picked.map((i) => c.rows[i]), propensity, ranked};
}

/**
 * Les cinq au point même, sans tirage : pour comparer deux réponses
 * possibles à un écran.
 * @param {Carte} carte La carte.
 * @param {Candidates} c Les candidats.
 * @param {EveningPoint} point Le point.
 * @param {number} count Nombre voulu.
 * @param {EveningParams} params Réglages.
 * @return {number[]} Rangs de la carte.
 */
export function expectedSlate(
    carte: Carte, c: Candidates, point: EveningPoint, count: number,
    params: EveningParams,
): number[] {
  return compose(carte, c, scoreCandidates(carte, c, point.mean, params),
      count, params).map((i) => c.rows[i]);
}

/**
 * Combien de films une réponse à un écran changerait dans les cinq, en
 * moyenne pondérée par la probabilité de chaque réponse. C'est la règle du
 * 13 octobre rendue calculable : un écran dont la réponse probable change
 * moins de trois films sur cinq ne mérite pas d'être posé.
 * @param {number[]} base Les cinq sans l'écran.
 * @param {Array<Array<number>>} answers Les cinq après chaque réponse.
 * @param {number[]} probabilities La probabilité de chaque réponse.
 * @return {number} Films changés, de 0 à 5.
 */
export function expectedChange(
    base: number[], answers: number[][], probabilities: number[],
): number {
  const before = new Set(base);
  let total = 0;
  let mass = 0;
  answers.forEach((slate, a) => {
    const p = probabilities[a] ?? 0;
    total += p * slate.filter((row) => !before.has(row)).length;
    mass += p;
  });
  return mass > 0 ? total / mass : 0;
}

/**
 * Le point du soir depuis ses touchers (voir `session.ts`) : les écrans
 * refusés avant le film de départ, la cible (film de départ et second
 * film), les comparaisons qui les accompagnent, puis les films écartés.
 * @param {Carte} carte La carte.
 * @param {EveningPoint} prior Le goût durable élargi (`eveningPrior`).
 * @param {Array<Object>} touches Les touchers, `{kind, shown, chosen}`.
 * @param {function(number): ?Float64Array} vectorFor La position d'un film
 *   (de la carte ou déduite de sa fiche), ou null.
 * @param {EveningParams} params Réglages.
 * @return {EveningPoint} Le point du soir.
 */
export function eveningFromTouches(
    carte: Carte, prior: EveningPoint,
    touches: {kind: string; shown: number[]; chosen: number | null}[],
    vectorFor: (id: number) => Float64Array | null, params: EveningParams,
): EveningPoint {
  const choose = (point: EveningPoint,
      touch: {shown: number[]; chosen: number | null}): EveningPoint => {
    const ids = touch.shown.filter((id) => vectorFor(id) !== null);
    if (touch.chosen !== null && !ids.includes(touch.chosen)) return point;
    const vectors = ids.map((id) => vectorFor(id) as Float64Array);
    return updateChoice(point, vectors,
        touch.chosen === null ? null : ids.indexOf(touch.chosen), params);
  };
  let point = prior;
  for (const t of touches) {
    if (t.kind === 'none-of-screen') point = choose(point, t);
  }
  const targets: Float64Array[] = [];
  for (const t of touches) {
    if ((t.kind === 'anchor' || t.kind === 'second') && t.chosen !== null) {
      const y = vectorFor(t.chosen);
      if (y) targets.push(y);
    }
  }
  point = declareTargets(carte, point, targets, params);
  for (const t of touches) {
    if (t.kind === 'anchor' || t.kind === 'second' || t.kind === 'same') {
      point = choose(point, t);
    }
  }
  for (const t of touches) {
    if (t.kind === 'refused') point = choose(point, t);
  }
  return point;
}

/**
 * La position d'un film absent de la carte (moins de 150 votes, ou trop
 * court), déduite des films de la carte qui lui ressemblent le plus par la
 * fiche : la moyenne de leurs positions, pondérée par la ressemblance.
 * @param {Carte} carte La carte.
 * @param {function(number): number} similarityTo Ressemblance de fiche entre
 *   le film et un rang de la carte, de 0 à 1.
 * @param {number} neighbours Films de la carte retenus.
 * @return {?Float64Array} La position, ou null si rien ne lui ressemble.
 */
export function foldIn(
    carte: Carte, similarityTo: (row: number) => number, neighbours = 20,
): Float64Array | null {
  const best: {row: number; s: number}[] = [];
  for (let row = 0; row < carte.films.length; row++) {
    const s = similarityTo(row);
    if (!(s > 0)) continue;
    if (best.length < neighbours) {
      best.push({row, s});
      best.sort((a, b) => b.s - a.s);
    } else if (s > best[best.length - 1].s) {
      best[best.length - 1] = {row, s};
      best.sort((a, b) => b.s - a.s);
    }
  }
  if (best.length === 0) return null;
  const out = new Float64Array(carte.k);
  let total = 0;
  for (const {row, s} of best) {
    total += s;
    for (let d = 0; d < carte.k; d++) {
      out[d] += s * carte.vectors[row * carte.k + d];
    }
  }
  for (let d = 0; d < carte.k; d++) out[d] /= total;
  return out;
}
