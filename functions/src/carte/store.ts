/* ===================================================================== *
 *  La carte : la ranger dans Firestore et la relire
 *
 *  Une carte rangée, c'est un document `carteBuilds/{id}` (l'en-tête) et ses
 *  morceaux compressés dans `carteBuilds/{id}/chunks`. Le document
 *  `carte/current` désigne la carte en service ; il est écrit en dernier,
 *  si bien qu'un lecteur ne tombe jamais sur une carte à moitié écrite. On
 *  garde la carte précédente, le temps que les instances en service
 *  passent à la nouvelle ; les plus anciennes sont effacées.
 *
 *  Aucune donnée personnelle n'y entre : des films, leurs positions, et
 *  pour chacun le nombre de galeries qui le contiennent. Les règles
 *  Firestore ne donnent accès à ces collections qu'au serveur.
 * ===================================================================== */

import {Firestore, Timestamp} from 'firebase-admin/firestore';
import {
  CARTE_VERSION, Carte, DEFAULT_CARTE_PARAMS, EncodedCarte, GalleryMark,
  buildCarte, decodeCarte, encodeCarte,
} from './model';
import {CarteSource, GatherReport, dayOf, gatherFilms} from './pipeline';

const POINTER = 'carte/current';
const BUILDS = 'carteBuilds';
/** Le temps entre deux coups d'œil au pointeur, dans une instance. */
const RECHECK_MS = 10 * 60 * 1000;

/**
 * Les galeries de films de tous les comptes, une par compte, sans
 * identifiant : la carte n'a besoin que de savoir quels films vont ensemble.
 * @param {Firestore} db Firestore.
 * @return {Promise<Array<Array<GalleryMark>>>} Les galeries non vides.
 */
export async function readGalleries(db: Firestore): Promise<GalleryMark[][]> {
  const users = await db.collection('users').listDocuments();
  const out: GalleryMark[][] = [];
  for (let at = 0; at < users.length; at += 20) {
    const snaps = await Promise.all(users.slice(at, at + 20).map((ref) =>
      ref.collection('gallery').where('mediaType', '==', 'movie').get()));
    for (const snap of snaps) {
      const marks = snap.docs
          .map((doc) => ({
            id: Number(doc.get('tmdbId')),
            loved: doc.get('lovedAt') instanceof Timestamp,
            disliked: doc.get('dislikedAt') instanceof Timestamp,
          }))
          .filter((mark) => Number.isInteger(mark.id));
      if (marks.length > 0) out.push(marks);
    }
  }
  return out;
}

/**
 * Relit une carte rangée.
 * @param {Firestore} db Firestore.
 * @param {string} buildId Son identifiant.
 * @return {Promise<?Carte>} La carte, ou null si elle manque ou date d'un
 *   format précédent.
 */
async function readBuild(
    db: Firestore, buildId: string,
): Promise<Carte | null> {
  const ref = db.collection(BUILDS).doc(buildId);
  const [head, chunks] = await Promise.all([
    ref.get(),
    ref.collection('chunks').orderBy('__name__').get(),
  ]);
  if (!head.exists || head.get('version') !== CARTE_VERSION) return null;
  const manifest = head.data() as EncodedCarte['manifest'];
  if (chunks.size !== manifest.chunks) return null;
  return decodeCarte({
    manifest,
    chunks: chunks.docs.map((doc) => doc.get('data') as Buffer),
  });
}

/**
 * La carte en service, relue sans passer par la mémoire de l'instance.
 * @param {Firestore} db Firestore.
 * @return {Promise<?{buildId: string, carte: Carte}>} La carte, ou null.
 */
async function readCurrent(
    db: Firestore,
): Promise<{buildId: string; carte: Carte} | null> {
  const pointer = await db.doc(POINTER).get();
  const buildId = pointer.get('buildId');
  if (typeof buildId !== 'string') return null;
  const carte = await readBuild(db, buildId);
  return carte ? {buildId, carte} : null;
}

let memory: {buildId: string; carte: Carte} | null = null;
let checkedAt = 0;
let pending: Promise<Carte | null> | null = null;

/**
 * La carte en service, gardée en mémoire par l'instance : elle n'est relue
 * que lorsque le pointeur change, et le pointeur n'est regardé qu'une fois
 * toutes les dix minutes. Une erreur de lecture rend la carte déjà en
 * mémoire, ou null : l'appelant retombe alors sur la fiche.
 * @param {Firestore} db Firestore.
 * @return {Promise<?Carte>} La carte, ou null s'il n'y en a pas encore.
 */
export function currentCarte(db: Firestore): Promise<Carte | null> {
  if (memory && Date.now() - checkedAt < RECHECK_MS) {
    return Promise.resolve(memory.carte);
  }
  if (!pending) {
    pending = (async () => {
      try {
        const pointer = await db.doc(POINTER).get();
        const buildId = pointer.get('buildId');
        if (typeof buildId !== 'string') {
          checkedAt = Date.now();
          return memory?.carte ?? null;
        }
        if (memory?.buildId !== buildId) {
          const carte = await readBuild(db, buildId);
          if (carte) memory = {buildId, carte};
        }
        checkedAt = Date.now();
        return memory?.carte ?? null;
      } catch {
        return memory?.carte ?? null;
      } finally {
        pending = null;
      }
    })();
  }
  return pending;
}

/**
 * Range une carte, la met en service, et efface les cartes plus anciennes
 * que la précédente.
 * @param {Firestore} db Firestore.
 * @param {Carte} carte La carte.
 * @param {?string} previousId La carte qu'elle remplace, gardée.
 * @return {Promise<string>} L'identifiant de la carte rangée.
 */
export async function saveCarte(
    db: Firestore, carte: Carte, previousId: string | null,
): Promise<string> {
  const encoded = encodeCarte(carte);
  const buildId = String(carte.builtAt);
  const ref = db.collection(BUILDS).doc(buildId);
  for (let i = 0; i < encoded.chunks.length; i++) {
    await ref.collection('chunks').doc(String(i).padStart(3, '0'))
        .set({data: encoded.chunks[i]});
  }
  await ref.set({...encoded.manifest, createdAt: Timestamp.now()});
  await db.doc(POINTER).set({
    buildId, builtAt: carte.builtAt, count: carte.films.length,
    version: CARTE_VERSION,
  });
  const keep = new Set([buildId, previousId]);
  for (const old of await db.collection(BUILDS).listDocuments()) {
    if (keep.has(old.id)) continue;
    await db.recursiveDelete(old);
  }
  return buildId;
}

export interface CarteBuildResult {
  buildId: string;
  films: number;
  galleries: number;
  report: GatherReport;
  /** Le temps de chaque partie, en millisecondes. */
  timings: {gather: number; galleries: number; factorize: number; save: number};
}

/**
 * La tâche hebdomadaire : rassembler les films, lire les galeries,
 * construire la carte, la ranger.
 *
 * Elle refuse de remplacer une carte par une carte qui a perdu plus d'un
 * film sur cinq : c'est le signe d'une panne chez TMDB pendant la lecture,
 * pas d'un catalogue qui aurait fondu en une semaine.
 * @param {Firestore} db Firestore.
 * @param {CarteSource} source TMDB.
 * @param {{budgetMs: number, concurrency: number}} options Temps imparti
 *   aux fiches et appels simultanés.
 * @return {Promise<CarteBuildResult>} Ce qui a été fait.
 */
export async function runCarteBuild(
    db: Firestore, source: CarteSource,
    options: {budgetMs: number; concurrency: number},
): Promise<CarteBuildResult> {
  const started = Date.now();
  const previous = await readCurrent(db);
  const {films, report} = await gatherFilms(source, {
    today: dayOf(started),
    lastYear: new Date(started).getUTCFullYear(),
    previous: previous?.carte ?? null,
    budgetMs: options.budgetMs,
    concurrency: options.concurrency,
  });
  const gathered = Date.now();
  if (films.length === 0) throw new Error('carte: aucun film rassemblé');
  if (previous && films.length < 0.8 * previous.carte.films.length) {
    throw new Error(`carte: ${films.length} films contre ` +
      `${previous.carte.films.length} la semaine précédente`);
  }
  const galleries = await readGalleries(db);
  const read = Date.now();
  const carte = buildCarte(films, galleries, DEFAULT_CARTE_PARAMS,
      previous?.carte ?? null);
  const factorized = Date.now();
  const buildId = await saveCarte(db, carte, previous?.buildId ?? null);
  memory = null;
  return {
    buildId,
    films: films.length,
    galleries: galleries.length,
    report,
    timings: {
      gather: gathered - started,
      galleries: read - gathered,
      factorize: factorized - read,
      save: Date.now() - factorized,
    },
  };
}
