// Export anonymisé des galeries et des soirées CinéMatch, en lecture seule.
//
// C'est la matière des mesures du moteur (mesure A : retrouver des coups de
// cœur cachés ; mesure C : la part des soirées réussies). Le script ne fait
// que lire : aucune écriture, aucun champ personnel (nom, e-mail, pseudo,
// titre recommandé à quelqu'un). Chaque compte devient un identifiant tiré
// d'un sel aléatoire propre à l'export : deux exports ne se recoupent pas,
// et rien ne ramène à la personne.
//
// Production, depuis `functions/`, après `gcloud auth application-default
// login` :
//   node scripts/carte/export-galleries.mjs /chemin/hors/du/depot/export.json
// Émulateur : poser FIRESTORE_EMULATOR_HOST et GCLOUD_PROJECT avant.

import {createRequire} from 'node:module';
import {createHash, randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';

const require = createRequire(import.meta.url);
const {initializeApp, applicationDefault} = require('firebase-admin/app');
const {getFirestore, Timestamp} = require('firebase-admin/firestore');

const out = process.argv[2];
if (!out) {
  console.error('Usage : node scripts/carte/export-galleries.mjs <fichier.json>');
  process.exit(2);
}

const projectId = process.env.GCLOUD_PROJECT || 'cinechill-a762b';
initializeApp(process.env.FIRESTORE_EMULATOR_HOST ?
  {projectId} : {projectId, credential: applicationDefault()});
const db = getFirestore();

const salt = randomBytes(16).toString('hex');
const anon = (uid) => createHash('sha256').update(salt + uid).digest('hex').slice(0, 12);
const millis = (v) => (v instanceof Timestamp ? v.toMillis() : null);

/** Un film de galerie : identifiant, avis, date d'entrée. */
function galleryRow(doc) {
  return {
    id: Number(doc.get('tmdbId')),
    type: doc.get('mediaType') === 'tv' ? 'tv' : 'movie',
    loved: doc.get('lovedAt') instanceof Timestamp,
    disliked: doc.get('dislikedAt') instanceof Timestamp,
    addedAt: millis(doc.get('addedAt')),
  };
}

/** Les événements d'une soirée, sans titres. */
function eveningRow(doc) {
  const events = (doc.get('events') ?? []).map((event) => {
    const copy = {...event, at: millis(event.at)};
    if (Array.isArray(copy.served)) {
      copy.served = copy.served.map((item) =>
        typeof item === 'object' && item !== null ?
          {id: item.id, rank: item.rank, score: item.score, source: item.source,
            propensity: item.propensity ?? null} :
          item);
    }
    return copy;
  });
  return {
    format: doc.get('format') ?? 'film',
    updatedAt: millis(doc.get('updatedAt')),
    launchedIds: doc.get('launchedIds') ?? [],
    verdicts: doc.get('verdicts') ?? {},
    events,
  };
}

const users = await db.collection('users').listDocuments();
const rows = [];
for (const userRef of users) {
  const [gallery, watchlist, evenings] = await Promise.all([
    userRef.collection('gallery').get(),
    userRef.collection('watchlist').get(),
    userRef.collection('cinematchEvenings').get(),
  ]);
  if (gallery.empty && evenings.empty) continue;
  rows.push({
    u: anon(userRef.id),
    gallery: gallery.docs.map(galleryRow).filter((r) => Number.isInteger(r.id)),
    watchlist: watchlist.docs
        .map((doc) => ({id: Number(doc.get('tmdbId')),
          type: doc.get('mediaType') === 'tv' ? 'tv' : 'movie'}))
        .filter((r) => Number.isInteger(r.id)),
    evenings: evenings.docs.map(eveningRow),
  });
}

writeFileSync(out, JSON.stringify({exportedAt: Date.now(), users: rows}));
const films = rows.reduce((n, r) => n + r.gallery.length, 0);
console.log(`${rows.length} comptes, ${films} films de galerie, ` +
  `${rows.reduce((n, r) => n + r.evenings.length, 0)} soirées → ${out}`);
