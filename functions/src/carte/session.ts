/* ===================================================================== *
 *  Le moteur du soir : relire la soirée, entrelacer deux moteurs
 *
 *  Les points d'entrée de CinéMatch ne gardent rien entre deux appels. Le
 *  point du soir se recalcule donc à chaque appel, depuis le journal de la
 *  soirée (`cinematchEvenings/{eveningId}`, voir `journalEvening`), qui
 *  garde chaque écran montré, et depuis la demande en cours :
 *
 *   - « Pas ceux-là » sur l'écran « Un film proche de… » : aucun des six ;
 *   - le film de départ, pris parmi les six de son écran ;
 *   - « Plutôt du côté de… » : le second film, pris parmi ses voisins et le
 *     film de départ ; « Pile comme Heat », c'est le film de départ pris
 *     parmi eux ;
 *   - « Pas celui-là » : un film des cinq écarté, aucun d'un écran d'un
 *     seul film. Refuser un film ce soir ne dit pas qu'on ne l'aimera
 *     jamais : il ne déplace que le point du soir.
 *
 *  Un film vu (« Déjà vu ») ne dit rien du soir : il sort des candidats, il
 *  ne déplace pas le point.
 *
 *  Module pur.
 * ===================================================================== */

/** Un toucher relu : les films montrés, le film pris (ou aucun). */
export interface Touch {
  kind: 'none-of-screen' | 'anchor' | 'second' | 'same' | 'refused';
  shown: number[];
  chosen: number | null;
}

/** Ce que la demande en cours ajoute au journal. */
export interface TouchRequest {
  anchorId: number | null;
  secondId: number | null;
  /** « Pas celui-là » de cet appel. */
  refusedIds: number[];
}

/**
 * Les identifiants d'une liste du journal : des nombres (`starters`,
 * `near`) ou des objets `{id}` (`picks`, `replace`).
 * @param {unknown} raw Liste brute.
 * @return {number[]} Identifiants.
 */
function idsOf(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const item of raw) {
    const id = typeof item === 'number' ? item :
      typeof item === 'object' && item !== null ?
        Number((item as {id?: unknown}).id) : NaN;
    if (Number.isInteger(id) && id > 0 && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Les touchers d'une soirée, dans l'ordre où ils déplacent le point : les
 * écrans refusés, le film de départ, le second film, les films écartés.
 * @param {Array<Object>} events Les événements du journal, dans l'ordre.
 * @param {TouchRequest} request La demande en cours.
 * @return {Touch[]} Les touchers.
 */
export function touchesFromJournal(
    events: Record<string, unknown>[], request: TouchRequest,
): Touch[] {
  const touches: Touch[] = [];
  let lastStarters: number[] | null = null;
  let anchorScreen: number[] | null = null;
  let nearScreen: number[] | null = null;
  const refused: number[] = [];
  for (const event of events) {
    if (event.type === 'starters') {
      const served = idsOf(event.served);
      // Une page demandée avec des films déjà montrés, c'est « Pas ceux-là ».
      if (Number(event.afterShown) > 0 && lastStarters &&
          lastStarters.length > 0) {
        touches.push({kind: 'none-of-screen', shown: lastStarters,
          chosen: null});
      }
      lastStarters = served;
      if (request.anchorId !== null && served.includes(request.anchorId)) {
        anchorScreen = served;
      }
    } else if (event.type === 'near' &&
        Number(event.anchorId) === request.anchorId) {
      nearScreen = idsOf(event.served);
    } else if (event.type === 'replace') {
      for (const id of idsOf(event.refusedIds)) {
        if (!refused.includes(id)) refused.push(id);
      }
    }
  }
  // Les écrans refusés après celui du film de départ ne le précèdent pas :
  // seuls comptent ceux d'avant lui. Ils sont déjà dans l'ordre.
  if (request.anchorId !== null) {
    const anchor = request.anchorId;
    touches.push({kind: 'anchor', shown: anchorScreen ?? [anchor],
      chosen: anchor});
    if (nearScreen && nearScreen.length > 0) {
      const shown = [...nearScreen.filter((id) => id !== anchor), anchor];
      if (request.secondId === null) {
        touches.push({kind: 'same', shown, chosen: anchor});
      } else if (shown.includes(request.secondId)) {
        touches.push({kind: 'second', shown, chosen: request.secondId});
      } else {
        touches.push({kind: 'second', shown: [request.secondId],
          chosen: request.secondId});
      }
    } else if (request.secondId !== null) {
      touches.push({kind: 'second', shown: [request.secondId],
        chosen: request.secondId});
    }
  }
  for (const id of request.refusedIds) {
    if (!refused.includes(id)) refused.push(id);
  }
  for (const id of refused) {
    touches.push({kind: 'refused', shown: [id], chosen: null});
  }
  return touches;
}

/** Un film des cinq entrelacés, et le moteur qui l'a apporté. */
export interface Drafted {
  id: number;
  team: string;
}

/**
 * L'entrelacement par équipes (Radlinski, Kurup et Joachims, 2008). Les
 * deux moteurs choisissent tour à tour, comme deux capitaines : celui qui a
 * le moins de films choisit le suivant (à pile ou face s'ils sont à
 * égalité), et prend son meilleur film pas encore retenu. Le film lancé dit
 * quel moteur a gagné la soirée ; sur beaucoup de soirées, on sait lequel
 * est le meilleur avec bien moins de données qu'un test A/B (Chapelle et
 * al., 2012).
 * @param {number[]} first Le classement du premier moteur.
 * @param {number[]} second Le classement du second.
 * @param {[string, string]} names Les noms des deux moteurs.
 * @param {number} count Nombre de films voulus.
 * @param {function(): number} random Tirage uniforme.
 * @param {function(number): ?number} sagaOf La saga d'un film : une saga
 *   n'entre qu'une fois.
 * @return {Drafted[]} Les films, dans l'ordre.
 */
export function teamDraft(
    first: number[], second: number[], names: [string, string],
    count: number, random: () => number,
    sagaOf: (id: number) => number | null = () => null,
): Drafted[] {
  const out: Drafted[] = [];
  const taken = new Set<number>();
  const sagas = new Set<number>();
  const lists = [first, second];
  const cursor = [0, 0];
  const picks = [0, 0];
  const nextOf = (team: number): number | null => {
    const list = lists[team];
    while (cursor[team] < list.length) {
      const id = list[cursor[team]++];
      if (taken.has(id)) continue;
      const saga = sagaOf(id);
      if (saga !== null && sagas.has(saga)) continue;
      return id;
    }
    return null;
  };
  while (out.length < count) {
    const preferred = picks[0] < picks[1] ? 0 : picks[1] < picks[0] ? 1 :
      random() < 0.5 ? 0 : 1;
    let team = preferred;
    let id = nextOf(team);
    if (id === null) {
      team = 1 - preferred;
      id = nextOf(team);
    }
    if (id === null) break;
    taken.add(id);
    const saga = sagaOf(id);
    if (saga !== null) sagas.add(saga);
    picks[team]++;
    out.push({id, team: names[team]});
  }
  return out;
}
