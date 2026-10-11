// Remplit `searchPrefixes` sur les profils publics qui existaient avant lui.
//
// claimHandle et setPublicName écrivent désormais ce champ, mais les profils
// créés avant ne le portent pas : sans ce rattrapage, ils resteraient
// introuvables par la recherche par mot tant que leur propriétaire ne change
// pas de nom.
//
// Depuis `functions/`, avec des identifiants par défaut de l'application
// (`gcloud auth application-default login`) :
//   node scripts/backfill-search-prefixes.mjs           simulation, rien n'est écrit
//   node scripts/backfill-search-prefixes.mjs --write   écrit pour de bon
//
// Rejouable sans risque : un profil dont les préfixes sont déjà les bons
// n'est pas réécrit. Hors de `src`, il n'est ni compilé ni déployé.

import {initializeApp, applicationDefault} from 'firebase-admin/app';
import {FieldPath, getFirestore} from 'firebase-admin/firestore';

const WRITE = process.argv.includes('--write');
const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'cinechill-a762b';
const PAGE_SIZE = 500;
const BATCH_SIZE = 400;
const SAMPLE_SIZE = 5;

/* ------------------------------------------------------------------ *
 *  Copie de `normalizeSearchText` et `searchPrefixesFor`
 *  (functions/src/index.ts). Elles doivent rester identiques : un écart
 *  donnerait aux anciens profils d'autres préfixes que les nouveaux.
 * ------------------------------------------------------------------ */

const SEARCH_PREFIX_MAX_LENGTH = 20;
const SEARCH_PREFIXES_MAX = 300;

function normalizeSearchText(raw) {
  return raw
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
}

function searchPrefixesFor(handle, displayName) {
  const name = normalizeSearchText(displayName);
  const normalizedHandle = normalizeSearchText(handle);
  const words = [
    ...name.split(/[\s\-'’._]+/),
    normalizedHandle,
    ...normalizedHandle.split(/[._-]+/),
  ];
  const prefixes = new Set();
  for (const word of words) {
    const chars = [...word];
    const longest = Math.min(chars.length, SEARCH_PREFIX_MAX_LENGTH);
    for (let length = 1; length <= longest; length++) {
      prefixes.add(chars.slice(0, length).join(''));
    }
  }
  return [...prefixes].slice(0, SEARCH_PREFIXES_MAX);
}

/* ------------------------------------------------------------------ */

function sameArray(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
    a.every((value, index) => value === b[index]);
}

initializeApp({credential: applicationDefault(), projectId: PROJECT_ID});
const db = getFirestore();

let scanned = 0;
let upToDate = 0;
let skipped = 0;
const pending = [];
const sample = [];

// Pagination par identifiant de document : une seule requête ne doit pas
// tenir toute la collection en mémoire.
let last = null;
for (;;) {
  let query = db.collection('publicProfiles')
      .orderBy(FieldPath.documentId())
      .limit(PAGE_SIZE);
  if (last) query = query.startAfter(last);
  const page = await query.get();
  if (page.empty) break;

  for (const doc of page.docs) {
    scanned++;
    const handle = doc.get('handleNormalized') ?? doc.get('handle');
    if (typeof handle !== 'string' || !handle) {
      // Sans pseudo, le profil n'est pas cherchable : claimHandle n'est
      // jamais allé au bout. Rien à indexer.
      skipped++;
      continue;
    }
    const storedName = doc.get('displayName');
    const displayName = typeof storedName === 'string' && storedName ?
      storedName : handle;
    const prefixes = searchPrefixesFor(handle, displayName);
    if (sameArray(doc.get('searchPrefixes'), prefixes)) {
      upToDate++;
      continue;
    }
    pending.push({ref: doc.ref, prefixes});
    if (sample.length < SAMPLE_SIZE) {
      sample.push({uid: doc.id, handle, displayName, prefixes});
    }
  }
  last = page.docs[page.docs.length - 1];
}

console.log(`Projet ${PROJECT_ID}`);
console.log(`  profils lus          ${scanned}`);
console.log(`  déjà à jour          ${upToDate}`);
console.log(`  sans pseudo, ignorés ${skipped}`);
console.log(`  à écrire             ${pending.length}`);
for (const row of sample) {
  console.log(`\n  ${row.uid} @${row.handle} « ${row.displayName} »`);
  console.log(`    ${row.prefixes.length} préfixes : ${row.prefixes.join(' ')}`);
}

if (!WRITE) {
  console.log('\nSimulation : rien n’a été écrit. Relancer avec --write.');
} else {
  let written = 0;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const {ref, prefixes} of pending.slice(i, i + BATCH_SIZE)) {
      // `update` et non `set` : un profil supprimé entre la lecture et
      // l'écriture fait échouer le lot plutôt que de renaître à moitié vide.
      batch.update(ref, {searchPrefixes: prefixes});
    }
    await batch.commit();
    written += Math.min(BATCH_SIZE, pending.length - i);
    console.log(`  écrits ${written}/${pending.length}`);
  }
  console.log('\nTerminé.');
}
