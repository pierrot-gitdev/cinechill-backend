/* ===================================================================== *
 *  La carte : l'algèbre linéaire
 *
 *  Tout ce que la carte calcule se ramène à de petits systèmes symétriques
 *  définis positifs, de la taille de la carte (32 × 32) : la position d'un
 *  film ou d'une personne, et l'incertitude qui va avec. Une factorisation
 *  de Cholesky les résout ; rien de plus n'est nécessaire, et aucune
 *  bibliothèque n'est à maintenir pour si peu.
 *
 *  Les matrices sont des `Float64Array` en ligne (élément (i, j) à
 *  `i * k + j`). Module pur.
 * ===================================================================== */

/**
 * Ajoute `w · v vᵀ` à la matrice `a` (k × k), sur place.
 * @param {Float64Array} a Matrice k × k.
 * @param {ArrayLike<number>} v Vecteur de longueur k, lu à partir de `offset`.
 * @param {number} w Poids.
 * @param {number} k Dimension.
 * @param {number} offset Début du vecteur dans `v`.
 */
export function addOuter(
    a: Float64Array, v: ArrayLike<number>, w: number, k: number, offset = 0,
): void {
  for (let i = 0; i < k; i++) {
    const vi = w * v[offset + i];
    if (vi === 0) continue;
    const row = i * k;
    for (let j = 0; j < k; j++) a[row + j] += vi * v[offset + j];
  }
}

/**
 * Ajoute `w · v` au vecteur `b`, sur place.
 * @param {Float64Array} b Vecteur de longueur k.
 * @param {ArrayLike<number>} v Vecteur source, lu à partir de `offset`.
 * @param {number} w Poids.
 * @param {number} k Dimension.
 * @param {number} offset Début du vecteur dans `v`.
 */
export function addScaled(
    b: Float64Array, v: ArrayLike<number>, w: number, k: number, offset = 0,
): void {
  for (let i = 0; i < k; i++) b[i] += w * v[offset + i];
}

/**
 * Factorise sur place une matrice symétrique définie positive : à la sortie,
 * le triangle inférieur porte L telle que A = L Lᵀ. Un pivot nul ou négatif
 * (matrice dégénérée) est remonté à un epsilon : mieux vaut une position
 * approchée qu'un film sans position.
 * @param {Float64Array} a Matrice k × k, écrasée.
 * @param {number} k Dimension.
 */
export function cholesky(a: Float64Array, k: number): void {
  for (let j = 0; j < k; j++) {
    let d = a[j * k + j];
    for (let p = 0; p < j; p++) d -= a[j * k + p] * a[j * k + p];
    const pivot = Math.sqrt(d > 1e-12 ? d : 1e-12);
    a[j * k + j] = pivot;
    for (let i = j + 1; i < k; i++) {
      let s = a[i * k + j];
      for (let p = 0; p < j; p++) s -= a[i * k + p] * a[j * k + p];
      a[i * k + j] = s / pivot;
    }
  }
}

/**
 * Résout L Lᵀ x = b, L étant la sortie de `cholesky`.
 * @param {Float64Array} l Facteur de Cholesky (triangle inférieur).
 * @param {Float64Array} b Second membre, écrasé par la solution.
 * @param {number} k Dimension.
 * @return {Float64Array} La solution (le même tableau que `b`).
 */
export function cholSolveInPlace(
    l: Float64Array, b: Float64Array, k: number,
): Float64Array {
  for (let i = 0; i < k; i++) {
    let s = b[i];
    for (let p = 0; p < i; p++) s -= l[i * k + p] * b[p];
    b[i] = s / l[i * k + i];
  }
  for (let i = k - 1; i >= 0; i--) {
    let s = b[i];
    for (let p = i + 1; p < k; p++) s -= l[p * k + i] * b[p];
    b[i] = s / l[i * k + i];
  }
  return b;
}

/**
 * Résout A x = b pour A symétrique définie positive. `a` est écrasée.
 * @param {Float64Array} a Matrice k × k.
 * @param {Float64Array} b Second membre, écrasé par la solution.
 * @param {number} k Dimension.
 * @return {Float64Array} La solution.
 */
export function solveSpd(
    a: Float64Array, b: Float64Array, k: number,
): Float64Array {
  cholesky(a, k);
  return cholSolveInPlace(a, b, k);
}

/**
 * L'inverse d'une matrice symétrique définie positive. `a` est écrasée.
 * @param {Float64Array} a Matrice k × k.
 * @param {number} k Dimension.
 * @return {Float64Array} A⁻¹, nouvelle matrice.
 */
export function inverseSpd(a: Float64Array, k: number): Float64Array {
  cholesky(a, k);
  const out = new Float64Array(k * k);
  const col = new Float64Array(k);
  for (let j = 0; j < k; j++) {
    col.fill(0);
    col[j] = 1;
    cholSolveInPlace(a, col, k);
    for (let i = 0; i < k; i++) out[i * k + j] = col[i];
  }
  return out;
}

/**
 * Valeurs et vecteurs propres d'une matrice symétrique, par la méthode de
 * Jacobi (rotations successives qui annulent les termes hors diagonale).
 * Lente pour de grandes matrices, exacte et sans surprise pour 32 × 32.
 * @param {Float64Array} m Matrice k × k symétrique (non modifiée).
 * @param {number} k Dimension.
 * @return {{values: Float64Array, vectors: Float64Array}} Valeurs propres,
 *   et vecteurs propres en colonnes (élément (i, j) : composante i du
 *   j-ième vecteur).
 */
export function symmetricEigen(
    m: Float64Array, k: number,
): {values: Float64Array; vectors: Float64Array} {
  const a = Float64Array.from(m);
  const v = new Float64Array(k * k);
  for (let i = 0; i < k; i++) v[i * k + i] = 1;
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < k; p++) {
      for (let q = p + 1; q < k; q++) off += a[p * k + q] * a[p * k + q];
    }
    if (off < 1e-22) break;
    for (let p = 0; p < k; p++) {
      for (let q = p + 1; q < k; q++) {
        const apq = a[p * k + q];
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (a[q * k + q] - a[p * k + p]) / (2 * apq);
        const t = Math.sign(theta || 1) /
          (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let r = 0; r < k; r++) {
          const arp = a[r * k + p];
          const arq = a[r * k + q];
          a[r * k + p] = c * arp - s * arq;
          a[r * k + q] = s * arp + c * arq;
        }
        for (let r = 0; r < k; r++) {
          const apr = a[p * k + r];
          const aqr = a[q * k + r];
          a[p * k + r] = c * apr - s * aqr;
          a[q * k + r] = s * apr + c * aqr;
        }
        for (let r = 0; r < k; r++) {
          const vrp = v[r * k + p];
          const vrq = v[r * k + q];
          v[r * k + p] = c * vrp - s * vrq;
          v[r * k + q] = s * vrp + c * vrq;
        }
      }
    }
  }
  const values = new Float64Array(k);
  for (let i = 0; i < k; i++) values[i] = a[i * k + i];
  return {values, vectors: v};
}

/**
 * Le produit scalaire de deux vecteurs de longueur k.
 * @param {ArrayLike<number>} a Premier vecteur, lu à partir de `ao`.
 * @param {ArrayLike<number>} b Second vecteur, lu à partir de `bo`.
 * @param {number} k Dimension.
 * @param {number} ao Début de `a`.
 * @param {number} bo Début de `b`.
 * @return {number} Le produit.
 */
export function dot(
    a: ArrayLike<number>, b: ArrayLike<number>, k: number, ao = 0, bo = 0,
): number {
  let s = 0;
  for (let i = 0; i < k; i++) s += a[ao + i] * b[bo + i];
  return s;
}

/**
 * Un générateur pseudo-aléatoire reproductible (mulberry32), pour que deux
 * calculs de carte sur les mêmes données donnent la même carte.
 * @param {number} seed Graine entière.
 * @return {function(): number} Tirage uniforme dans [0, 1[.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Un tirage gaussien centré réduit (Box-Muller).
 * @param {function(): number} random Tirage uniforme.
 * @return {number} Tirage N(0, 1).
 */
export function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
