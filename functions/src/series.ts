/**
 * Les séries — tout ce qui se calcule sans réseau ni Firestore.
 *
 * Le modèle tient en une phrase : **une saison est un film**. L'unité rangée
 * en galerie comme en watchlist est la saison (`tv-1399-s2`), jamais la série,
 * qui n'est qu'un dossier de saisons au même titre qu'une saga est un dossier
 * de films. Une saison passe de la watchlist à la galerie une seule fois, dans
 * un seul sens : il n'existe pas d'état « en cours ». Le prochain épisode à
 * lancer est un champ facultatif de la watchlist, pas un état de l'objet.
 *
 * Les séries sont tenues à l'écart de CinéMatch : rien ici n'est lu par le
 * moteur, et les lectures de bibliothèque du moteur ne voient que les films.
 */

/**
 * Les genres TV de TMDB, ramenés au vocabulaire des films.
 *
 * TMDB tient deux listes de genres, et la TV fusionne ce que le cinéma sépare :
 * « Action & Adventure », « Sci-Fi & Fantasy ». Ranger ces identifiants tels
 * quels donnerait à la galerie un genre que sa barre ne sait pas nommer, et
 * casserait le compte des genres. On les ramène donc aux genres de films au
 * moment où la saison entre en bibliothèque. Les formats sans histoire
 * (actualités, téléréalité, talk-show) n'apportent aucun genre.
 */
export const TV_GENRE_MAP: Record<number, number[]> = {
  10759: [28, 12],
  10765: [878, 14],
  10768: [10752],
  10762: [10751],
  10766: [18],
  10763: [],
  10764: [],
  10767: [],
};

/**
 * Normalise une liste de genres TV en genres de films, sans doublon.
 * @param {unknown} raw Liste brute renvoyée par TMDB.
 * @return {number[]} Genres de films, dans l'ordre de leur première venue.
 */
export function normalizeTvGenres(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const value of raw) {
    const id = typeof value === 'number' ? value :
      typeof (value as {id?: unknown})?.id === 'number' ?
        (value as {id: number}).id : null;
    if (id === null) continue;
    for (const mapped of TV_GENRE_MAP[id] ?? [id]) {
      if (!out.includes(mapped)) out.push(mapped);
    }
  }
  return out;
}

/**
 * L'identifiant d'une saison en bibliothèque.
 * @param {number} tvId Identifiant TMDB de la série.
 * @param {number} season Numéro de la saison.
 * @return {string} `tv-{tvId}-s{season}`.
 */
export function seasonEntryId(tvId: number, season: number): string {
  return `tv-${tvId}-s${season}`;
}

/**
 * Lit un identifiant de saison. Refuse tout le reste, y compris `tv-1399`
 * seul : on ne range jamais une série entière.
 * @param {unknown} raw Identifiant reçu.
 * @return {?{tvId: number, season: number}} Série et saison, ou null.
 */
export function parseSeasonEntryId(
    raw: unknown,
): {tvId: number; season: number} | null {
  if (typeof raw !== 'string') return null;
  const match = /^tv-(\d+)-s(\d+)$/.exec(raw);
  if (!match) return null;
  const tvId = Number(match[1]);
  const season = Number(match[2]);
  if (tvId <= 0 || season <= 0) return null;
  return {tvId, season};
}

/**
 * La médiane, et non la moyenne : un pilote de 75 minutes ne doit pas faire
 * passer une série de 45 minutes pour une série d'une heure.
 * @param {number[]} values Valeurs positives.
 * @return {?number} Médiane arrondie, ou null sans valeur.
 */
export function median(values: number[]): number | null {
  const sorted = values
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? sorted[middle] :
    (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value);
}

/** Ce que la bibliothèque retient d'une saison. */
export interface SeasonSummary {
  /** Nombre d'épisodes annoncés, diffusés ou non. */
  episodes: number;
  /** Durée médiane d'un épisode, en minutes. */
  episodeRuntime: number | null;
  /** Épisodes déjà diffusés à la date du calcul. */
  airedEpisodes: number;
  /** Date du prochain épisode à diffuser, `YYYY-MM-DD`, ou null. */
  nextAirDate: string | null;
}

/**
 * Résume la liste d'épisodes d'une saison.
 * @param {unknown} rawEpisodes Champ `episodes` de `/tv/{id}/season/{n}`.
 * @param {string} today Date du jour, `YYYY-MM-DD`.
 * @return {SeasonSummary} Le résumé.
 */
export function summarizeSeason(
    rawEpisodes: unknown, today: string,
): SeasonSummary {
  const episodes = Array.isArray(rawEpisodes) ?
    rawEpisodes as {runtime?: unknown; air_date?: unknown}[] : [];
  const runtimes: number[] = [];
  let aired = 0;
  let nextAirDate: string | null = null;
  for (const episode of episodes) {
    if (typeof episode.runtime === 'number') runtimes.push(episode.runtime);
    const airDate = typeof episode.air_date === 'string' && episode.air_date ?
      episode.air_date : null;
    if (airDate !== null && airDate <= today) {
      aired++;
    } else if (airDate !== null &&
      (nextAirDate === null || airDate < nextAirDate)) {
      nextAirDate = airDate;
    }
  }
  return {
    episodes: episodes.length,
    episodeRuntime: median(runtimes),
    airedEpisodes: aired,
    nextAirDate,
  };
}

/** Une saison telle que la fiche d'une série la liste. */
export interface SeasonListing {
  season_number: number;
  name: string;
  episode_count: number;
  air_date: string | null;
  poster_path: string | null;
  vote_average: number | null;
}

/**
 * Les saisons d'une série, sans les spéciaux.
 *
 * La saison 0 regroupe les épisodes de Noël, les making-of et les pilotes non
 * retenus : elle ne porte pas d'histoire, et la ranger fausserait les comptes.
 * @param {unknown} raw Champ `seasons` de `/tv/{id}`.
 * @return {SeasonListing[]} Saisons numérotées, dans l'ordre.
 */
export function listSeasons(raw: unknown): SeasonListing[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[])
      .filter((s) => typeof s.season_number === 'number' &&
        (s.season_number as number) > 0)
      .map((s) => ({
        season_number: s.season_number as number,
        name: typeof s.name === 'string' ? s.name : '',
        episode_count: typeof s.episode_count === 'number' ?
          s.episode_count : 0,
        air_date: typeof s.air_date === 'string' && s.air_date ?
          s.air_date : null,
        poster_path: typeof s.poster_path === 'string' ? s.poster_path : null,
        vote_average: typeof s.vote_average === 'number' &&
          s.vote_average > 0 ? s.vote_average : null,
      }))
      .sort((a, b) => a.season_number - b.season_number);
}

/**
 * Le nombre de saisons déjà commencées à la date du jour : c'est ce qu'on
 * peut prétendre avoir vu, et donc ce que le deck propose de ranger.
 * @param {SeasonListing[]} seasons Saisons de la série.
 * @param {string} today Date du jour, `YYYY-MM-DD`.
 * @return {number} Saisons dont le premier épisode est sorti.
 */
export function airedSeasonCount(
    seasons: SeasonListing[], today: string,
): number {
  return seasons.filter((s) => s.air_date !== null && s.air_date <= today)
      .length;
}
