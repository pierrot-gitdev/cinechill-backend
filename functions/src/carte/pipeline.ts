/* ===================================================================== *
 *  La carte : rassembler ses films
 *
 *  Chaque semaine : la liste du catalogue (et la réception de chaque film),
 *  les plateformes françaises, puis les fiches. Une fiche lue il y a moins
 *  de cinq à sept mois est reprise de la carte précédente ; les autres sont
 *  relues chez TMDB, les films jamais lus d'abord. Le délai varie d'un film
 *  à l'autre pour que les relectures s'étalent sur les semaines au lieu de
 *  tomber toutes le même lundi, six mois après la première carte.
 *
 *  La lecture des fiches a un temps imparti : ce qui n'a pas pu être lu
 *  garde sa fiche précédente, ou attend la semaine suivante s'il n'en avait
 *  pas. Une carte un peu incomplète vaut mieux qu'une tâche qui échoue.
 * ===================================================================== */

import {
  CATALOGUE_MIN_RUNTIME, DiscoverPage, appProviderIds, carteFilmFromDetail,
  listCatalogue, listProviderFilms,
} from './catalog';
import {Carte, CarteFilm} from './model';

/** Ce dont la tâche a besoin chez TMDB. */
export interface CarteSource {
  discover(query: Record<string, string>): Promise<DiscoverPage>;
  /** La liste des plateformes de films en France. */
  providers(): Promise<{provider_id: number; provider_name: string}[]>;
  /** La fiche d'un film avec `CARTE_DETAIL_APPEND`, ou null s'il a
   *  disparu de TMDB. */
  movie(id: number): Promise<Record<string, unknown> | null>;
}

export interface GatherOptions {
  /** Le jour, compté depuis le 1er janvier 1970. */
  today: number;
  /** L'année en cours : la fin du catalogue. */
  lastYear: number;
  previous: Carte | null;
  /** Le temps accordé à la lecture des fiches, en millisecondes. */
  budgetMs: number;
  /** Appels TMDB en même temps. */
  concurrency: number;
  /** L'horloge, remplaçable pour les vérifications. */
  now?: () => number;
}

/** Ce que la tâche a fait, pour le journal. */
export interface GatherReport {
  listed: number;
  kept: number;
  fetched: number;
  /** Films sortis de TMDB depuis la dernière lecture. */
  gone: number;
  /** Fiches dont la lecture a échoué : la précédente est gardée. */
  failed: number;
  /** Films jamais lus, remis à la semaine suivante faute de temps. */
  deferred: number;
  providers: number[];
  onPlatforms: number;
}

/**
 * Au bout de combien de jours relire la fiche d'un film : entre 150 et 209,
 * selon son identifiant, sous les six mois permis par TMDB.
 * @param {number} id Identifiant TMDB.
 * @return {number} Jours.
 */
export function staleAfterDays(id: number): number {
  return 150 + (id % 60);
}

/**
 * Le jour d'une date, compté depuis le 1er janvier 1970.
 * @param {number} millis Date en millisecondes.
 * @return {number} Jour.
 */
export function dayOf(millis: number): number {
  return Math.floor(millis / 86_400_000);
}

/**
 * Rassemble les films de la carte.
 * @param {CarteSource} source TMDB.
 * @param {GatherOptions} options Jour, carte précédente, temps imparti.
 * @return {Promise<{films: CarteFilm[], report: GatherReport}>} Les films,
 *   triés par identifiant, et le compte rendu.
 */
export async function gatherFilms(
    source: CarteSource, options: GatherOptions,
): Promise<{films: CarteFilm[]; report: GatherReport}> {
  const discover = (query: Record<string, string>) => source.discover(query);
  const listed = await listCatalogue(
      discover, options.lastYear, options.concurrency);
  const providerIds = appProviderIds(await source.providers());
  const byProvider = await listProviderFilms(
      discover, providerIds, options.lastYear, options.concurrency);

  const previous = new Map<number, CarteFilm>();
  for (const film of options.previous?.films ?? []) previous.set(film.id, film);
  const ids = [...listed.keys()].sort((a, b) => a - b);
  const lastRead = (id: number) => previous.get(id)?.fetchedDay || -1;
  const toFetch = ids.filter((id) =>
    options.today - lastRead(id) >= staleAfterDays(id));
  toFetch.sort((a, b) => lastRead(a) - lastRead(b) || a - b);

  const fresh = new Map<number, CarteFilm | null>();
  let failed = 0;
  const clock = options.now ?? Date.now;
  const deadline = clock() + options.budgetMs;
  let next = 0;
  const worker = async () => {
    while (next < toFetch.length && clock() < deadline) {
      const id = toFetch[next++];
      try {
        const detail = await source.movie(id);
        fresh.set(id, detail ?
          carteFilmFromDetail(detail, [], options.today) : null);
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({length: options.concurrency}, worker));

  const films: CarteFilm[] = [];
  let kept = 0;
  let gone = 0;
  let deferred = 0;
  for (const id of ids) {
    let film: CarteFilm | undefined;
    if (fresh.has(id)) {
      const read = fresh.get(id);
      if (!read) {
        gone++;
        continue;
      }
      film = read;
    } else {
      film = previous.get(id);
      if (film) kept++;
    }
    if (!film) {
      deferred++;
      continue;
    }
    if (film.runtime !== null && film.runtime < CATALOGUE_MIN_RUNTIME) continue;
    const row = listed.get(id) as {voteCount: number; voteAverage: number};
    films.push({
      ...film,
      voteCount: row.voteCount || film.voteCount,
      voteAverage: row.voteAverage || film.voteAverage,
      providers: byProvider.get(id) ?? [],
    });
  }
  // Une lecture échouée qui n'avait pas de fiche précédente compte aussi
  // parmi les films remis à plus tard ; `failed` dit seulement combien.
  return {
    films,
    report: {
      listed: ids.length,
      kept,
      fetched: [...fresh.values()].filter((f) => f !== null).length,
      gone,
      failed,
      deferred,
      providers: providerIds,
      onPlatforms: films.filter((f) => f.providers.length > 0).length,
    },
  };
}
