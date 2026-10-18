/**
 * Le moteur du deck Découvrir — tout ce qui se calcule sans réseau ni
 * Firestore.
 *
 * Une seule question le gouverne : « quel film cette personne a-t-elle le
 * plus de chances d'avoir vu, d'après tout ce qu'elle a dit jusqu'ici ? ».
 * La V1 répondait « le plus connu », et un goût pointu balayait à gauche
 * pendant des centaines de cartes : vingt « pas vu » sur un genre ne
 * retiraient que 1,8 point sur 100, moins que l'aléa ajouté à chaque carte.
 *
 * Trois pièces :
 *
 * 1. **Les familles.** Une famille est une requête TMDB nommée qui sait dire
 *    un style : genre, langue d'origine, période, parfois studio. Le genre
 *    seul ne distingue pas un anime d'un Pixar ni un polar coréen d'un
 *    thriller américain.
 * 2. **Le modèle de « déjà vu ».** Une affinité par famille et une pente de
 *    notoriété, propres à chaque personne, mises à jour à chaque décision
 *    par une régression logistique bayésienne en ligne (approximation de
 *    Laplace diagonale). La pente dit à quel point la personne ne connaît
 *    que le très connu ; elle apprend vite des refus sur les blockbusters.
 * 3. **Le choix des cartes.** Tirage de Thompson sur les familles, bonus des
 *    artéfacts en retard, et une part d'information tant qu'on repère.
 *
 * Les a priori sont posés à la main. Ils se régleront sur les décisions
 * agrégées des comptes Cinechill (`swipeLog`), jamais sur un modèle entraîné
 * à partir de contenu TMDB, que les conditions de l'API interdisent.
 */

/* ===================================================================== *
 *  Les films, tels que le moteur les voit
 * ===================================================================== */

/** Ce que le moteur sait d'un film : les champs de `/discover`. */
export interface FilmFeatures {
  genreIds: number[];
  /** Code ISO 639-1 de la langue d'origine, `null` s'il manque. */
  originalLanguage: string | null;
  year: number | null;
  voteCount: number | null;
  voteAverage: number | null;
  /**
   * Familles que seule la requête connaît (un studio ne se lit pas sur une
   * ligne de `/discover`) : posées par la source qui a ramené le film.
   */
  taggedFamilies?: string[];
}

/** Une famille : un style qu'on sait interroger et reconnaître. */
export interface Family {
  key: string;
  /** Probabilité a priori d'avoir vu le film le plus vu de la famille. */
  prior: number;
  /** Famille de niche : la seconde mosaïque de relance va la chercher. */
  niche: boolean;
  /**
   * Les paramètres `/discover/movie` propres à la famille. Une liste de
   * langues se tire au sort à chaque requête : TMDB ne garantit pas le « ou »
   * sur `with_original_language`.
   */
  query: {
    genres?: number[];
    withoutGenres?: number[];
    languages?: string[];
    fromYear?: number;
    toYear?: number;
    minAverage?: number;
    minVotes?: number;
    companies?: number[];
  };
  /** Reconnaît un film de la famille sur ses seuls champs. */
  matches?: (film: FilmFeatures) => boolean;
}

const has = (film: FilmFeatures, ...ids: number[]) =>
  film.genreIds.some((id) => ids.includes(id));
const lang = (film: FilmFeatures, ...codes: string[]) =>
  film.originalLanguage !== null && codes.includes(film.originalLanguage);
const yearAtLeast = (film: FilmFeatures, year: number) =>
  film.year !== null && film.year >= year;
const yearBefore = (film: FilmFeatures, year: number) =>
  film.year !== null && film.year < year;
const votes = (film: FilmFeatures) => film.voteCount ?? 0;
const average = (film: FilmFeatures) => film.voteAverage ?? 0;

/** Identifiant TMDB du studio A24, vérifié sur themoviedb.org/company/41077. */
const COMPANY_A24 = 41077;

/**
 * Les familles. L'ordre ne compte pas. Les a priori disent la part d'un
 * public francophone qui a vu le film **le plus vu** de chacune : élevée pour
 * le grand spectacle, basse pour le cinéma indien.
 *
 * `autres` n'est jamais interrogée : elle donne une affinité aux films qui
 * n'entrent dans aucune famille, pour que le modèle ait toujours de quoi
 * apprendre d'une décision.
 */
export const FAMILIES: Family[] = [
  {
    key: 'spectacle', prior: 0.55, niche: false,
    query: {genres: [28, 12, 878], languages: ['en'], fromYear: 2005,
      minVotes: 8000},
    matches: (f) => lang(f, 'en') && yearAtLeast(f, 2005) &&
      votes(f) >= 8000 && has(f, 28, 12, 878),
  },
  {
    key: 'classiques_80_90', prior: 0.45, niche: false,
    query: {languages: ['en'], fromYear: 1980, toYear: 1999, minVotes: 5000},
    matches: (f) => lang(f, 'en') && yearAtLeast(f, 1980) &&
      yearBefore(f, 2000) && votes(f) >= 5000,
  },
  {
    key: 'comedie_fr', prior: 0.4, niche: false,
    query: {genres: [35], languages: ['fr']},
    matches: (f) => lang(f, 'fr') && has(f, 35),
  },
  {
    key: 'auteur_fr', prior: 0.25, niche: false,
    query: {genres: [18], languages: ['fr'], minAverage: 7},
    matches: (f) => lang(f, 'fr') && has(f, 18) && average(f) >= 7,
  },
  {
    key: 'animation_famille', prior: 0.5, niche: false,
    query: {genres: [16], languages: ['en']},
    matches: (f) => lang(f, 'en') && has(f, 16),
  },
  {
    key: 'anime', prior: 0.25, niche: true,
    query: {genres: [16], languages: ['ja']},
    matches: (f) => lang(f, 'ja') && has(f, 16),
  },
  {
    key: 'coree', prior: 0.15, niche: true,
    query: {languages: ['ko']},
    matches: (f) => lang(f, 'ko'),
  },
  {
    key: 'asie', prior: 0.12, niche: true,
    query: {languages: ['ja', 'zh', 'cn'], withoutGenres: [16]},
    matches: (f) => lang(f, 'ja', 'zh', 'cn') && !has(f, 16),
  },
  {
    key: 'horreur_moderne', prior: 0.25, niche: false,
    query: {genres: [27], fromYear: 2000},
    matches: (f) => has(f, 27) && yearAtLeast(f, 2000),
  },
  {
    key: 'horreur_culte', prior: 0.2, niche: true,
    query: {genres: [27], toYear: 1999},
    matches: (f) => has(f, 27) && yearBefore(f, 2000),
  },
  {
    key: 'thriller_polar', prior: 0.4, niche: false,
    query: {genres: [53, 80], languages: ['en']},
    matches: (f) => lang(f, 'en') && has(f, 53, 80),
  },
  {
    key: 'scifi_culte', prior: 0.4, niche: false,
    query: {genres: [878], minAverage: 7.5},
    matches: (f) => has(f, 878) && average(f) >= 7.5,
  },
  {
    key: 'fantasy', prior: 0.4, niche: false,
    query: {genres: [14], minVotes: 3000},
    matches: (f) => has(f, 14) && votes(f) >= 3000,
  },
  {
    key: 'romance', prior: 0.3, niche: false,
    query: {genres: [10749]},
    matches: (f) => has(f, 10749),
  },
  {
    key: 'comedie_us', prior: 0.35, niche: false,
    query: {genres: [35], languages: ['en'], withoutGenres: [16]},
    matches: (f) => lang(f, 'en') && has(f, 35) && !has(f, 16),
  },
  {
    // Un studio ne se lit pas sur une ligne de `/discover` : la famille ne
    // se reconnaît qu'aux films que sa propre requête a ramenés.
    key: 'indep_us', prior: 0.15, niche: true,
    query: {companies: [COMPANY_A24]},
  },
  {
    key: 'europe', prior: 0.15, niche: true,
    query: {languages: ['it', 'es', 'de', 'da', 'sv', 'no']},
    matches: (f) => lang(f, 'it', 'es', 'de', 'da', 'sv', 'no'),
  },
  {
    key: 'inde', prior: 0.06, niche: true,
    query: {languages: ['hi', 'ta', 'te']},
    matches: (f) => lang(f, 'hi', 'ta', 'te'),
  },
  {
    key: 'guerre_histoire', prior: 0.3, niche: false,
    query: {genres: [10752, 36]},
    matches: (f) => has(f, 10752, 36),
  },
  {
    key: 'western', prior: 0.15, niche: true,
    query: {genres: [37]},
    matches: (f) => has(f, 37),
  },
  {
    key: 'classiques_anciens', prior: 0.15, niche: true,
    query: {toYear: 1969, minVotes: 2000},
    matches: (f) => yearBefore(f, 1970) && votes(f) >= 2000,
  },
  {
    key: 'famille_live', prior: 0.4, niche: false,
    query: {genres: [10751], withoutGenres: [16]},
    matches: (f) => has(f, 10751) && !has(f, 16),
  },
  {key: 'autres', prior: 0.3, niche: false, query: {}},
];

const FAMILY_BY_KEY = new Map(FAMILIES.map((family) => [family.key, family]));

/** Les familles qu'on peut interroger (toutes sauf `autres`). */
export const QUERYABLE_FAMILIES = FAMILIES.filter((f) => f.key !== 'autres');

/**
 * Les neuf familles de la première mosaïque : éloignées les unes des autres,
 * pour qu'une seule grille dise déjà dans quel coin chercher.
 */
export const START_GRID_FAMILIES = [
  'spectacle', 'comedie_fr', 'anime', 'coree', 'romance', 'horreur_moderne',
  'classiques_80_90', 'animation_famille', 'inde',
];

/**
 * Familles d'un film : celles qui le reconnaissent, plus celles que la
 * requête a posées. `autres` quand aucune ne le reconnaît.
 * @param {FilmFeatures} film Le film.
 * @return {string[]} Clés de familles, sans doublon.
 */
export function familiesOf(film: FilmFeatures): string[] {
  const keys = new Set<string>();
  for (const key of film.taggedFamilies ?? []) {
    if (FAMILY_BY_KEY.has(key)) keys.add(key);
  }
  for (const family of FAMILIES) {
    if (family.matches?.(film)) keys.add(family.key);
  }
  if (keys.size === 0) keys.add('autres');
  return Array.from(keys);
}

/**
 * Les paramètres `/discover/movie` d'une famille, sans le plancher de
 * notoriété ni la page, que l'appelant décide.
 * @param {Family} family La famille.
 * @param {function(): number} random Aléa, pour le tirage de la langue.
 * @return {Record<string, string>} Paramètres TMDB.
 */
export function familyDiscoverParams(
    family: Family, random: () => number = Math.random,
): Record<string, string> {
  const q = family.query;
  const params: Record<string, string> = {};
  if (q.genres) params['with_genres'] = q.genres.join('|');
  if (q.withoutGenres) params['without_genres'] = q.withoutGenres.join(',');
  if (q.languages && q.languages.length > 0) {
    params['with_original_language'] =
      q.languages[Math.floor(random() * q.languages.length)];
  }
  if (q.fromYear) params['primary_release_date.gte'] = `${q.fromYear}-01-01`;
  if (q.toYear) params['primary_release_date.lte'] = `${q.toYear}-12-31`;
  if (q.minAverage) params['vote_average.gte'] = String(q.minAverage);
  if (q.companies) params['with_companies'] = q.companies.join('|');
  return params;
}

/**
 * Le plancher de notoriété propre à la famille, s'il est plus haut que
 * celui de la personne : « grand spectacle » n'a de sens qu'au-dessus de
 * 8 000 votes, quel que soit le profil.
 * @param {Family} family La famille.
 * @param {number} personal Plancher de la personne.
 * @return {number} Plancher à appliquer.
 */
export function familyVoteFloor(family: Family, personal: number): number {
  return Math.max(personal, family.query.minVotes ?? 0);
}

/* ===================================================================== *
 *  Le modèle de « déjà vu »
 * ===================================================================== */

/** Une affinité : moyenne et précision d'une loi normale sur un logit. */
export interface Belief {
  m: number;
  q: number;
}

/** Ce que le modèle sait d'une famille. */
export interface FamilyBelief extends Belief {
  /** Décisions observées dans la famille, pour la fermer après trois refus. */
  seen: number;
  skipped: number;
}

/** Le modèle d'une personne, persisté dans `preferences/swipeProfile`. */
export interface DeckModel {
  v: number;
  theta: Record<string, FamilyBelief>;
  /** Pente de notoriété : plus elle est forte, plus seul le connu est vu. */
  beta: Belief;
  /** Décisions apprises. */
  n: number;
  /**
   * Les dernières issues du deck, de la plus ancienne : 1 pour « vu » ou
   * « à voir », qui ne sont pas des cartes perdues, 0 pour « pas vu ».
   */
  recent: number[];
  /** Films à plus de 10 000 votes : vus et refusés. */
  big: {seen: number; skipped: number};
  /** La mosaïque de départ a été faite (ou passée). */
  startGridDone: boolean;
}

export const MODEL_VERSION = 2;
/** Précision a priori d'une famille : faible, pour apprendre vite. */
const THETA_PRIOR_PRECISION = 0.6;
const BETA_PRIOR_MEAN = 1.2;
const BETA_PRIOR_PRECISION = 1.5;
/** Fenêtre du rendement glissant, en cartes. */
export const RECENT_WINDOW = 15;
/** Seuil de « blockbuster » pour la règle du plancher. */
const BIG_VOTES = 10000;

/**
 * Logistique.
 * @param {number} z Logit.
 * @return {number} Probabilité.
 */
export function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Logit, borné pour qu'un a priori de 0 ou de 1 reste fini.
 * @param {number} p Probabilité.
 * @return {number} Logit.
 */
export function logit(p: number): number {
  const c = Math.min(0.99, Math.max(0.01, p));
  return Math.log(c / (1 - c));
}

/**
 * L'a priori d'une famille.
 * @param {string} key Clé de famille.
 * @return {FamilyBelief} Croyance initiale.
 */
function priorBelief(key: string): FamilyBelief {
  const prior = FAMILY_BY_KEY.get(key)?.prior ?? 0.3;
  return {m: logit(prior), q: THETA_PRIOR_PRECISION, seen: 0, skipped: 0};
}

/**
 * Un modèle vierge.
 * @return {DeckModel} Modèle.
 */
export function emptyModel(): DeckModel {
  return {
    v: MODEL_VERSION,
    theta: {},
    beta: {m: BETA_PRIOR_MEAN, q: BETA_PRIOR_PRECISION},
    n: 0,
    recent: [],
    big: {seen: 0, skipped: 0},
    startGridDone: false,
  };
}

/**
 * Lit un modèle persisté, en tolérant l'absence et les champs abîmés. Une
 * version inconnue repart de zéro plutôt que de mal lire.
 * @param {unknown} raw Valeur Firestore.
 * @return {DeckModel} Modèle.
 */
export function parseModel(raw: unknown): DeckModel {
  const model = emptyModel();
  if (!raw || typeof raw !== 'object') return model;
  const data = raw as Record<string, unknown>;
  if (data.v !== MODEL_VERSION) return model;
  const num = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

  if (data.theta && typeof data.theta === 'object') {
    for (const [key, value] of Object.entries(
        data.theta as Record<string, unknown>)) {
      if (!FAMILY_BY_KEY.has(key) || !value || typeof value !== 'object') {
        continue;
      }
      const belief = value as Record<string, unknown>;
      const prior = priorBelief(key);
      model.theta[key] = {
        m: num(belief.m, prior.m),
        q: Math.max(0.1, num(belief.q, prior.q)),
        seen: Math.max(0, num(belief.seen, 0)),
        skipped: Math.max(0, num(belief.skipped, 0)),
      };
    }
  }
  if (data.beta && typeof data.beta === 'object') {
    const beta = data.beta as Record<string, unknown>;
    model.beta = {
      m: num(beta.m, BETA_PRIOR_MEAN),
      q: Math.max(0.1, num(beta.q, BETA_PRIOR_PRECISION)),
    };
  }
  model.n = Math.max(0, num(data.n, 0));
  if (Array.isArray(data.recent)) {
    model.recent = data.recent
        .filter((v): v is number => v === 0 || v === 1)
        .slice(-RECENT_WINDOW);
  }
  if (data.big && typeof data.big === 'object') {
    const big = data.big as Record<string, unknown>;
    model.big = {
      seen: Math.max(0, num(big.seen, 0)),
      skipped: Math.max(0, num(big.skipped, 0)),
    };
  }
  model.startGridDone = data.startGridDone === true;
  return model;
}

/**
 * La croyance d'une famille, a priori compris.
 * @param {DeckModel} model Modèle.
 * @param {string} key Clé.
 * @return {FamilyBelief} Croyance.
 */
export function beliefOf(model: DeckModel, key: string): FamilyBelief {
  return model.theta[key] ?? priorBelief(key);
}

/**
 * Notoriété centrée : 0 à 10 000 votes, −1 à 1 000, +0,5 à 30 000.
 * @param {?number} voteCount Votes TMDB.
 * @return {number} Notoriété, bornée entre −3 et 2.
 */
export function notoriety(voteCount: number | null): number {
  const x = Math.log10(Math.max(1, voteCount ?? 0)) - 4;
  return Math.max(-3, Math.min(2, x));
}

/**
 * Une décision, dans le vocabulaire du modèle.
 *
 * `seen` = 1 pour « vu », 0 pour « pas vu ». Un « à voir » compte comme un
 * demi-« vu » sur l'affinité de famille seule : la personne ne l'a pas vu,
 * mais elle regarde ce genre de films, et c'est ce que dit l'affinité.
 */
export interface Observation {
  families: string[];
  voteCount: number | null;
  seen: 0 | 1;
  /** 1 pour une décision franche, 0,5 pour une case laissée vide. */
  weight: number;
  /** N'apprend que l'affinité (le « à voir »), pas la pente. */
  familiesOnly?: boolean;
  /** Une carte du deck : elle compte dans le rendement glissant. */
  fromDeck?: boolean;
  /** Une carte servie comme sonde : elle compte pour fermer une famille. */
  countsForClosing?: boolean;
}

/**
 * Apprend une décision. Un pas de régression logistique bayésienne avec une
 * approximation de Laplace diagonale : chaque paramètre garde une moyenne et
 * une précision, la précision croît avec l'information reçue, et le pas
 * rétrécit d'autant. Les premières décisions bougent donc beaucoup le
 * modèle, les centièmes presque plus.
 *
 * Chaque famille du film apprend comme si elle était seule. Un modèle
 * strictement additif partagerait le signal : un anime est aussi un film
 * de fantasy, et chacune des deux familles n'en recevait qu'un quart. Pour
 * un goût pointu, c'était trois fois plus de cartes avant que le moteur ose
 * servir de l'anime.
 * @param {DeckModel} model Modèle, modifié en place.
 * @param {Observation} obs La décision.
 */
export function learn(model: DeckModel, obs: Observation): void {
  const families = obs.families.length > 0 ? obs.families : ['autres'];
  const a = 1 / families.length;
  const x = notoriety(obs.voteCount);
  const slope = obs.familiesOnly ? 0 : model.beta.m * x;
  const beliefs = families.map((key) => beliefOf(model, key));

  families.forEach((key, index) => {
    const b = {...beliefs[index]};
    const pk = sigmoid(b.m + slope);
    b.q += pk * (1 - pk) * obs.weight;
    b.m += (obs.seen - pk) * obs.weight / b.q;
    if (obs.countsForClosing !== false) {
      if (obs.seen === 1) b.seen += obs.weight;
      else b.skipped += obs.weight;
    }
    model.theta[key] = b;
  });

  // La pente, elle, apprend de la prédiction d'ensemble.
  const p = sigmoid(beliefs.reduce((sum, b) => sum + a * b.m, 0) + slope);
  const g = (obs.seen - p) * obs.weight;
  const h = p * (1 - p) * obs.weight;
  if (!obs.familiesOnly) {
    model.beta = {
      q: model.beta.q + h * x * x,
      m: model.beta.m + g * x / (model.beta.q + h * x * x),
    };
    if ((obs.voteCount ?? 0) >= BIG_VOTES) {
      if (obs.seen === 1) model.big.seen += obs.weight;
      else model.big.skipped += obs.weight;
    }
  }

  if (obs.fromDeck) {
    model.recent = [...model.recent, obs.seen].slice(-RECENT_WINDOW);
  }
  model.n += obs.weight;
}

/**
 * Une famille pas encore vraiment sondée : moins d'une décision franche.
 *
 * Une case laissée vide dans une mosaïque n'est qu'une demi-décision. Elle
 * ne suffit pas à clore la recherche dans une famille : sur la première
 * mosaïque, une personne qui aime l'anime passe à côté du film d'anime une
 * fois sur trois, et la famille n'aurait plus jamais été proposée.
 * @param {DeckModel} model Modèle.
 * @param {string} key Famille.
 * @return {boolean} Vrai si la famille reste à sonder.
 */
export function isUntested(model: DeckModel, key: string): boolean {
  const b = model.theta[key];
  return !b || b.seen + b.skipped < 1;
}

/**
 * La personne a-t-elle une famille où elle voit des films ? Tant que non,
 * un recentrage n'a rien sur quoi se recentrer : il continue de chercher.
 * @param {DeckModel} model Modèle.
 * @return {boolean} Vrai si une famille a au moins un « vu » et 40 % de
 *   chances sur son film le plus vu.
 */
export function hasLikedFamily(model: DeckModel): boolean {
  return Object.values(model.theta)
      .some((b) => b.seen >= 1 && sigmoid(b.m) >= 0.4);
}

/**
 * Une famille est fermée après trois refus sans un seul « vu ». Elle ne
 * revient plus qu'au voisinage d'un film vu, jamais comme sonde.
 * @param {DeckModel} model Modèle.
 * @param {string} key Famille.
 * @return {boolean} Vrai si la famille est fermée.
 */
export function isClosed(model: DeckModel, key: string): boolean {
  const b = beliefOf(model, key);
  return b.skipped >= 3 && b.seen === 0;
}

/**
 * Le plancher de notoriété de la personne.
 *
 * C'était 3 000 votes pour tout le monde sous 30 films en galerie : le seuil
 * qui libérait un goût pointu dépendait de cartes qu'il balayait justement à
 * gauche. Il suit désormais la pente apprise, et tombe dès que la personne
 * refuse six blockbusters sur dix.
 * @param {DeckModel} model Modèle.
 * @return {number} Votes TMDB minimum.
 */
export function voteFloor(model: DeckModel): number {
  const big = model.big;
  const bigTotal = big.seen + big.skipped;
  const shunsBlockbusters = big.skipped >= 6 &&
    big.seen / Math.max(1, bigTotal) < 0.4;
  if (model.beta.m < 0.5) return 300;
  if (shunsBlockbusters || model.beta.m < 0.9) return 800;
  return 2000;
}

/**
 * Rendement glissant : part de « vu » sur les `window` dernières cartes du
 * deck, ou `null` s'il y en a moins.
 * @param {number[]} recent Issues, de la plus ancienne.
 * @param {number} window Taille de la fenêtre.
 * @return {?number} Rendement.
 */
export function rollingYield(recent: number[], window = 10): number | null {
  if (recent.length < window) return null;
  const slice = recent.slice(-window);
  return slice.reduce((sum, v) => sum + v, 0) / window;
}

/* ===================================================================== *
 *  Les phases et le choix des cartes
 * ===================================================================== */

export type DeckPhase = 'reperage' | 'recolte' | 'finitions';
export type DeckMode = 'normal' | 'recentrage';

/**
 * La phase. Le repérage dure les vingt premières décisions ; les finitions
 * commencent à 70 films, quand les artéfacts en retard prennent le pas et
 * que les genres de CinéMatch encore jamais sondés passent, même quand le
 * rendement est bas.
 * @param {DeckModel} model Modèle.
 * @param {number} gallerySize Films en galerie.
 * @return {DeckPhase} Phase.
 */
export function phaseOf(model: DeckModel, gallerySize: number): DeckPhase {
  if (gallerySize >= 70) return 'finitions';
  if (model.n < 20 && gallerySize < 30) return 'reperage';
  return 'recolte';
}

/** Un candidat, tel que le vivier le garde. */
export interface DeckCandidate extends FilmFeatures {
  id: number;
  source: string;
  /** Films vus ou adorés qui le recommandent. */
  neighborCount: number;
}

/** Ce que le choix d'un lot doit savoir de la personne. */
export interface LotContext {
  model: DeckModel;
  phase: DeckPhase;
  mode: DeckMode;
  gallerySize: number;
  lovedCount: number;
  watchlistSize: number;
  /** Genres distincts de la galerie. */
  galleryGenreCount: number;
  /** Rendement glissant sur dix cartes, `null` avant dix cartes. */
  rolling: number | null;
  random: () => number;
}

/** Un candidat noté. */
export interface ScoredCandidate extends DeckCandidate {
  families: string[];
  /** Probabilité estimée d'avoir vu le film, sans tirage. */
  pSeen: number;
  /** Valeur du tirage, ce qui ordonne le lot. */
  value: number;
  /** Ce que la carte vient chercher. */
  kind: 'main' | 'promesse' | 'coverage' | 'explore' | 'reserve';
}

/**
 * Tirage normal (Box-Muller).
 * @param {function(): number} random Source d'aléa uniforme.
 * @return {number} Tirage N(0, 1).
 */
function gaussian(random: () => number): number {
  const u = Math.max(1e-12, random());
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Un tirage par famille, une fois par lot : c'est la famille qu'on tire, pas
 * le film (Thompson sampling).
 * @param {DeckModel} model Modèle.
 * @param {function(): number} random Source d'aléa.
 * @param {number} temperature Part du bruit gardée, de 0 à 1.
 * @return {Map<string, number>} Affinité tirée par famille.
 */
export function drawFamilies(
    model: DeckModel, random: () => number, temperature = 1,
): Map<string, number> {
  const draws = new Map<string, number>();
  for (const family of FAMILIES) {
    const b = beliefOf(model, family.key);
    draws.set(family.key,
        b.m + temperature * gaussian(random) / Math.sqrt(b.q));
  }
  return draws;
}

/**
 * Le bruit du tirage selon la phase.
 *
 * Plein pendant le repérage, où l'on cherche. Réduit de moitié ensuite :
 * un refus sur un film peu probable n'apporte presque pas d'information au
 * modèle (c'est juste), si bien que l'incertitude des familles écartées
 * décroît lentement, et un tirage plein continuerait de les servir une
 * carte sur trois. Nul en recentrage, où l'on ne cherche plus.
 * @param {DeckPhase} phase Phase.
 * @param {DeckMode} mode Mode.
 * @return {number} Température du tirage.
 */
export function drawTemperature(phase: DeckPhase, mode: DeckMode): number {
  if (mode === 'recentrage') return 0;
  return phase === 'reperage' ? 1 : 0.5;
}

/**
 * Ce qui s'ajoute au logit et ne s'apprend pas : le voisinage. La décennie
 * de naissance y comptait aussi ; les familles d'époque apprennent la même
 * chose des réponses, sans rien demander (retirée le 19 oct. 2026).
 * @param {DeckCandidate} c Candidat.
 * @return {number} Terme additif.
 */
function fixedTerms(c: DeckCandidate): number {
  return 0.8 * Math.log2(1 + c.neighborCount);
}

/**
 * Probabilité estimée d'avoir vu un film, sans tirage.
 * @param {DeckModel} model Modèle.
 * @param {DeckCandidate} c Candidat.
 * @param {string[]} families Ses familles.
 * @return {number} Probabilité.
 */
export function pSeenOf(
    model: DeckModel, c: DeckCandidate, families: string[],
): number {
  const a = 1 / families.length;
  const theta = families.reduce((s, k) => s + a * beliefOf(model, k).m, 0);
  return sigmoid(theta + model.beta.m * notoriety(c.voteCount) +
    fixedTerms(c));
}

/**
 * Combien de fois on relève les votes TMDB d'un film en français, pour une
 * application en français.
 *
 * Les votes TMDB comptent un public mondial et anglophone : un grand succès
 * français y reçoit bien moins de votes qu'un film américain vu par autant
 * de Français, de l'ordre de vingt fois moins. On ne relève que de quatre
 * fois, parce que la correction vaut pour tout film en français, petit ou
 * grand, sans savoir lequel a eu un vrai public : un facteur de vingt ferait
 * passer un film confidentiel pour un classique. Le modèle apprend le reste
 * des « vu » et « pas vu » de chacun. À recaler sur le journal du deck
 * (`swipeLog`).
 */
export const FRENCH_VOTE_FACTOR = 4;

/**
 * Les votes d'un film tels que le moteur les lit pour un public français :
 * relevés de `FRENCH_VOTE_FACTOR` quand le film est en français (langue
 * d'origine TMDB), inchangés sinon.
 * @param {?string} originalLanguage Langue d'origine TMDB, ISO 639-1.
 * @param {?number} voteCount Votes TMDB.
 * @return {?number} Votes à lire.
 */
export function frenchVotes(
    originalLanguage: string | null, voteCount: number | null,
): number | null {
  if (originalLanguage !== 'fr' || voteCount === null) return voteCount;
  return Math.round(voteCount * FRENCH_VOTE_FACTOR);
}

/**
 * Notoriété ramenée entre 0 et 1 : une sonde n'informe que sur un film connu.
 * @param {?number} voteCount Votes.
 * @return {number} Entre 0 et 1.
 */
function notoriety01(voteCount: number | null): number {
  const x = (Math.log10(Math.max(1, voteCount ?? 0)) - 2.5) / 2;
  return Math.max(0, Math.min(1, x));
}

/** Rythme attendu des artéfacts, pour 100 films en galerie. */
const COEUR_PER_100 = 12;
const PROMESSE_TARGET = 10;
const EVENTAIL_TARGET = 6;

/**
 * Note les candidats.
 * @param {DeckCandidate[]} candidates Vivier, déjà purgé des exclusions.
 * @param {LotContext} ctx Contexte.
 * @return {ScoredCandidate[]} Candidats notés, par valeur décroissante.
 */
export function scoreCandidates(
    candidates: DeckCandidate[], ctx: LotContext,
): ScoredCandidate[] {
  const draws = drawFamilies(ctx.model, ctx.random,
      drawTemperature(ctx.phase, ctx.mode));
  // L'information ne vaut que pour une famille encore jamais sondée : c'est
  // là que peut se cacher tout un pan du goût de la personne. Elle ne
  // s'éteint pas quand le rendement baisse, au contraire : un rendement bas
  // dit justement qu'on cherche au mauvais endroit. Une fois toutes les
  // familles sondées, elle ne pèse plus rien d'elle-même.
  const searching = ctx.mode === 'recentrage' && !hasLikedFamily(ctx.model);
  const lambda = ctx.mode === 'recentrage' ? (searching ? 0.6 : 0) :
    ctx.phase === 'reperage' ? 0.6 : 0.35;
  // La dette du Cœur : à 50 films, on attend six coups de cœur. Elle ne
  // pèse qu'à partir de quatre de retard, et plafonne.
  const expectedLoved = COEUR_PER_100 * ctx.gallerySize / 100;
  const coeurDebt = Math.max(0, Math.min(1,
      (expectedLoved - ctx.lovedCount) / 4));

  return candidates.map((c) => {
    const families = familiesOf(c);
    const a = 1 / families.length;
    const fixed = fixedTerms(c);
    const x = notoriety(c.voteCount);
    const thetaMean = families
        .reduce((s, k) => s + a * beliefOf(ctx.model, k).m, 0);
    const thetaDraw = families
        .reduce((s, k) => s + a * (draws.get(k) ?? 0), 0);
    const pSeen = sigmoid(thetaMean + ctx.model.beta.m * x + fixed);
    const pDraw = sigmoid(thetaDraw + ctx.model.beta.m * x + fixed);

    const info = families.filter((k) => isUntested(ctx.model, k)).length *
      a * notoriety01(c.voteCount);
    const cult = (c.voteAverage ?? 0) >= 7.8 && (c.voteCount ?? 0) >= 3000;
    const bonus = cult ? 0.4 * coeurDebt : 0;

    return {
      ...c,
      families,
      pSeen,
      value: pDraw * (1 + bonus) + lambda * info,
      kind: 'main' as const,
    };
  }).sort((l, r) => r.value - l.value);
}

/** Taille d'un lot, et de sa réserve de cartes sûres. */
export const LOT_SIZE = 10;
export const RESERVE_SIZE = 5;
/** Cartes d'un lot pouvant partager un genre, au plus. */
const LOT_GENRE_CAP = 4;

/**
 * Cartes d'un lot pouvant venir d'une même famille, au plus.
 *
 * Une famille jamais sondée n'a droit qu'à une carte : sa réponse arrive
 * avant la seconde, et quatre « grand spectacle » d'affilée pour une
 * personne qui n'en voit pas coûtaient quatre cartes pour une information.
 * Une famille où la personne voit plus d'un film sur deux peut prendre six
 * cartes : la variété ne vaut rien si elle se paie en films que personne
 * n'a vus. Les autres, trois.
 * @param {DeckModel} model Modèle.
 * @param {string} key Famille.
 * @param {boolean} recentrage Mode recentrage.
 * @return {number} Plafond.
 */
function familyCap(model: DeckModel, key: string, recentrage: boolean): number {
  if (isUntested(model, key)) return 1;
  if (sigmoid(beliefOf(model, key).m) >= 0.5) return recentrage ? 7 : 6;
  return 3;
}

/** Un lot composé. */
export interface Lot {
  cards: ScoredCandidate[];
  reserve: ScoredCandidate[];
}

/**
 * Compose un lot : les cartes réservées aux artéfacts et à l'exploration,
 * le reste par valeur, sous plafonds de genre et de famille, puis la
 * réserve de cartes sûres que l'app garde de côté contre les séries de
 * refus.
 * @param {ScoredCandidate[]} scored Candidats notés, par valeur décroissante.
 * @param {LotContext} ctx Contexte.
 * @return {Lot} Le lot et sa réserve.
 */
export function composeLot(scored: ScoredCandidate[], ctx: LotContext): Lot {
  const picked: ScoredCandidate[] = [];
  const used = new Set<number>();
  const genreLoad = new Map<number, number>();
  const familyLoad = new Map<string, number>();
  const recentrage = ctx.mode === 'recentrage';
  // Un recentrage se resserre sur peu de familles : il leur laisse la place.
  const genreCap = recentrage ? LOT_GENRE_CAP + 2 : LOT_GENRE_CAP;

  // Une famille fermée ne revient qu'au voisinage d'un film vu.
  const allowed = scored.filter((c) =>
    c.neighborCount > 0 || !c.families.every((k) => isClosed(ctx.model, k)));

  const fits = (c: ScoredCandidate, relaxed: boolean) => relaxed ||
    c.genreIds.every((id) => (genreLoad.get(id) ?? 0) < genreCap) &&
    c.families.every((k) =>
      (familyLoad.get(k) ?? 0) < familyCap(ctx.model, k, recentrage));
  const take = (c: ScoredCandidate, kind: ScoredCandidate['kind']) => {
    picked.push({...c, kind});
    used.add(c.id);
    for (const id of c.genreIds) {
      genreLoad.set(id, (genreLoad.get(id) ?? 0) + 1);
    }
    for (const k of c.families) {
      familyLoad.set(k, (familyLoad.get(k) ?? 0) + 1);
    }
  };
  const firstOf = (pred: (c: ScoredCandidate) => boolean) =>
    allowed.find((c) => !used.has(c.id) && pred(c));

  if (!recentrage) {
    // La Promesse : un film désirable qu'on n'a probablement pas vu. Le
    // refus y coûte peu, il ouvre souvent un balayage vers le haut.
    if (ctx.watchlistSize < PROMESSE_TARGET && ctx.phase !== 'reperage') {
      const promesse = firstOf((c) => c.source === 'promesse' &&
        c.pSeen >= 0.2 && c.pSeen <= 0.65);
      if (promesse) take(promesse, 'promesse');
    }
    // La couverture des genres de CinéMatch, trois sondes par genre puis
    // plus rien ; et l'Éventail s'il manque encore des genres à 50 films.
    // Sous un rendement d'un film sur deux, la sonde attend : elle coûterait
    // une carte à qui en perd déjà beaucoup. Mais pas au-delà de 70 films :
    // un genre jamais sondé à l'arrivée aux cent films est un genre dont
    // CinéMatch ne sait rien, pas même qu'il est absent. Les finitions sont
    // le moment de le demander, à une carte par lot.
    const eventailShort = ctx.gallerySize >= 50 &&
      ctx.galleryGenreCount < EVENTAIL_TARGET;
    if (eventailShort || ctx.phase === 'finitions' ||
      ctx.rolling === null || ctx.rolling >= 0.5) {
      const coverage = firstOf((c) => c.source === 'coverage');
      if (coverage) take(coverage, 'coverage');
    }
    // Une carte d'exploration au plus par lot, quand le rendement le permet.
    if (ctx.phase !== 'reperage' && ctx.rolling !== null &&
      ctx.rolling >= 0.6) {
      const explore = allowed
          .filter((c) => !used.has(c.id) && c.neighborCount === 0)
          .sort((l, r) => familyUncertainty(ctx.model, r) -
            familyUncertainty(ctx.model, l))[0];
      if (explore) take(explore, 'explore');
    }
  }

  // En recentrage, seulement ce qui a de bonnes chances d'être vu. Sauf
  // si rien n'a encore plu : on n'a alors rien à resserrer, et l'on sonde
  // les familles inconnues par leurs films les plus vus.
  const searching = recentrage && !hasLikedFamily(ctx.model);
  const main = recentrage && !searching ?
    allowed.filter((c) => c.pSeen >= 0.45 || c.neighborCount > 0) :
    allowed;
  for (const relaxed of [false, true]) {
    for (const c of main) {
      if (picked.length >= LOT_SIZE) break;
      if (used.has(c.id) || !fits(c, relaxed)) continue;
      take(c, 'main');
    }
  }
  // Un recentrage sans assez de candidats sûrs se complète au plus probable
  // plutôt que de rendre un lot court.
  if (picked.length < LOT_SIZE) {
    const fallback = allowed.filter((c) => !used.has(c.id))
        .sort((l, r) => r.pSeen - l.pSeen);
    for (const c of fallback) {
      if (picked.length >= LOT_SIZE) break;
      take(c, 'main');
    }
  }

  // La réserve : les plus probables, une par famille d'abord. Une réserve
  // de cinq films de la même famille ne protège de rien quand c'est cette
  // famille que la personne vient de refuser trois fois. Ce qui reste de
  // place se complète au plus probable, même dans une famille déjà prise :
  // un film peu probable d'une autre famille ne protège de rien non plus.
  const rest = allowed.filter((c) => !used.has(c.id))
      .sort((l, r) => r.pSeen - l.pSeen);
  const reserve: ScoredCandidate[] = [];
  const reserveFamilies = new Set<string>();
  for (const c of rest) {
    if (reserve.length >= RESERVE_SIZE) break;
    if (c.families.some((k) => reserveFamilies.has(k))) continue;
    reserve.push({...c, kind: 'reserve'});
    for (const k of c.families) reserveFamilies.add(k);
  }
  for (const c of rest) {
    if (reserve.length >= RESERVE_SIZE) break;
    if (reserve.some((r) => r.id === c.id)) continue;
    reserve.push({...c, kind: 'reserve'});
  }
  reserve.sort((l, r) => r.pSeen - l.pSeen);

  return {cards: orderLot(picked), reserve};
}

/**
 * L'incertitude moyenne des familles d'un candidat, rapportée à sa
 * notoriété : une sonde vaut ce qu'elle apprend.
 * @param {DeckModel} model Modèle.
 * @param {ScoredCandidate} c Candidat.
 * @return {number} Incertitude.
 */
function familyUncertainty(model: DeckModel, c: ScoredCandidate): number {
  const a = 1 / c.families.length;
  return c.families.reduce((s, k) => s + a / beliefOf(model, k).q, 0) *
    notoriety01(c.voteCount);
}

/**
 * Ordonne le lot : la valeur d'abord, en évitant deux cartes de la même
 * famille ou du même genre d'affilée, et en ne posant pas deux cartes
 * risquées à la suite.
 * @param {ScoredCandidate[]} cards Cartes.
 * @return {ScoredCandidate[]} Cartes ordonnées.
 */
export function orderLot(cards: ScoredCandidate[]): ScoredCandidate[] {
  const remaining = [...cards].sort((l, r) => r.value - l.value);
  const ordered: ScoredCandidate[] = [];
  while (remaining.length > 0) {
    const previous = ordered[ordered.length - 1];
    let bestIndex = 0;
    let best = -Infinity;
    remaining.forEach((c, index) => {
      let penalty = 0;
      if (previous) {
        if (c.families.some((k) => previous.families.includes(k))) {
          penalty += 0.15;
        }
        if (c.genreIds.filter((g) => previous.genreIds.includes(g))
            .length >= 2) penalty += 0.1;
        if (c.pSeen < 0.4 && previous.pSeen < 0.4) penalty += 0.2;
      }
      const adjusted = c.value - penalty;
      if (adjusted > best) {
        best = adjusted;
        bestIndex = index;
      }
    });
    ordered.push(remaining[bestIndex]);
    remaining.splice(bestIndex, 1);
  }
  return ordered;
}

/* ===================================================================== *
 *  Les mosaïques
 * ===================================================================== */

export type GridStage =
  | 'start1' | 'start2' | 'start3' | 'relance1' | 'relance2';

/** Affiches d'une mosaïque. */
export const GRID_SIZE = 9;

/**
 * Les familles d'une mosaïque, avec le nombre de films à prendre dans
 * chacune, dans l'ordre d'affichage.
 *
 * - `start1` : neuf familles éloignées, une affiche chacune.
 * - `start2`, `start3` : on resserre autour des familles où la personne a
 *   coché, et on garde quelques familles encore jamais sondées.
 * - `relance1` : les familles les plus incertaines, jamais fermées.
 * - `relance2` : les familles de niche.
 * @param {GridStage} stage Étape.
 * @param {DeckModel} model Modèle.
 * @param {function(): number} random Source d'aléa.
 * @return {Array<{key: string, count: number}>} Familles et affiches.
 */
export function gridPlan(
    stage: GridStage, model: DeckModel, random: () => number,
): {key: string; count: number}[] {
  if (stage === 'start1') {
    return START_GRID_FAMILIES.map((key) => ({key, count: 1}));
  }
  const open = QUERYABLE_FAMILIES.filter((f) => !isClosed(model, f.key));
  const untested = open.filter((f) => {
    const b = beliefOf(model, f.key);
    return b.seen + b.skipped === 0;
  });
  const liked = open
      .filter((f) => beliefOf(model, f.key).seen > 0)
      .sort((l, r) => beliefOf(model, r.key).m - beliefOf(model, l.key).m);

  const plan = new Map<string, number>();
  const add = (key: string, count: number) =>
    plan.set(key, (plan.get(key) ?? 0) + count);
  const total = () => Array.from(plan.values()).reduce((s, n) => s + n, 0);

  if (stage === 'start2' || stage === 'start3') {
    const exploit = stage === 'start2' ? 5 : 6;
    // Deux affiches par famille aimée, en commençant par la plus aimée.
    for (const family of liked) {
      if (total() >= exploit) break;
      add(family.key, Math.min(2, exploit - total()));
    }
    for (const family of shuffle(untested, random)) {
      if (total() >= GRID_SIZE) break;
      if (!plan.has(family.key)) add(family.key, 1);
    }
  } else {
    const pool = stage === 'relance2' ?
      open.filter((f) => f.niche) :
      [...open].sort((l, r) =>
        1 / beliefOf(model, r.key).q - 1 / beliefOf(model, l.key).q);
    for (const family of stage === 'relance2' ? shuffle(pool, random) : pool) {
      if (total() >= GRID_SIZE) break;
      if (!plan.has(family.key)) add(family.key, 1);
    }
  }
  // Ce qui manque encore se complète sur les familles ouvertes.
  for (const family of shuffle(open, random)) {
    if (total() >= GRID_SIZE) break;
    if (!plan.has(family.key)) add(family.key, 1);
  }
  return Array.from(plan.entries()).map(([key, count]) => ({key, count}));
}

/**
 * Copie mélangée (Fisher-Yates).
 * @param {T[]} items Éléments.
 * @param {function(): number} random Source d'aléa.
 * @return {T[]} Copie mélangée.
 */
export function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
