// Mesure B : l'entrelacement des deux moteurs, en vrai.
//
// Les cinq mêlent les films du moteur de la fiche et ceux de la carte
// (`teamDraft`). Une soirée est gagnée par le moteur dont le film est lancé
// (« Je le regarde »), et gagnée pour de bon si ce film est aimé le
// lendemain. Sur beaucoup de soirées, le moteur qui gagne plus souvent qu'il
// ne perd est le meilleur (Radlinski, Kurup et Joachims, 2008 ; Chapelle et
// al., 2012). Seuil de la proposition du 18 octobre : la carte gagne plus
// souvent, avec une significativité de 5 % (test du signe, bilatéral).
//
// La proposition du jour vient d'un moteur à la fois, un jour sur deux : on
// compte à part la part des propositions du jour lancées, moteur par moteur.
//
// Depuis `functions/` :
//   node scripts/carte/measure-b.mjs export.json
// `export.json` vient de `export-galleries.mjs`.

import {readFileSync} from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('Usage : node scripts/carte/measure-b.mjs <export.json>');
  process.exit(2);
}
const exported = JSON.parse(readFileSync(path, 'utf8'));

/** P(X ≥ k) pour X ~ Binomiale(n, 1/2), en double pour un test bilatéral. */
function signTest(wins, losses) {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.max(wins, losses);
  let tail = 0;
  let c = 1; // C(n, 0)
  for (let i = 0; i <= n; i++) {
    if (i >= k) tail += c;
    c = c * (n - i) / (i + 1);
  }
  return Math.min(1, 2 * tail / 2 ** n);
}

const result = {
  launch: {fiche: 0, carte: 0},
  loved: {fiche: 0, carte: 0},
  evenings: 0,
  undecided: 0,
  daily: {fiche: {served: 0, launched: 0}, carte: {served: 0, launched: 0}},
};
for (const user of exported.users) {
  for (const evening of user.evenings) {
    if (evening.format !== 'film') continue;
    const team = new Map();
    let interleaved = false;
    let dailyEngine = null;
    let dailyFilm = null;
    let launched = null;
    for (const event of evening.events) {
      if ((event.type === 'picks' || event.type === 'replace') &&
          event.engine === 'interleaved') {
        interleaved = true;
        for (const item of event.served ?? []) {
          if (item && item.team) team.set(item.id, item.team);
        }
      }
      if (event.type === 'daily' && !event.cached && event.engine) {
        dailyEngine = event.engine;
        dailyFilm = event.served?.[0] ?? null;
      }
      if (event.type === 'launch') launched = event.tmdbId ?? event.id ?? launched;
    }
    if (dailyEngine && result.daily[dailyEngine]) {
      result.daily[dailyEngine].served++;
      if (launched !== null && launched === dailyFilm) result.daily[dailyEngine].launched++;
    }
    if (!interleaved) continue;
    result.evenings++;
    const winner = launched !== null ? team.get(launched) : undefined;
    if (!winner) {
      result.undecided++;
      continue;
    }
    result.launch[winner]++;
    const verdict = evening.verdicts?.[String(launched)];
    if (verdict === 'loved' || verdict === 'liked') result.loved[winner]++;
  }
}

const line = (label, w) => {
  const p = signTest(w.carte, w.fiche);
  console.log(`${label.padEnd(30)} carte ${String(w.carte).padStart(4)}   fiche ${String(w.fiche).padStart(4)}   ` +
    `p = ${p.toFixed(3)}${w.carte > w.fiche && p < 0.05 ? '   la carte gagne' : w.fiche > w.carte && p < 0.05 ? '   la fiche gagne' : '   pas d\'écart établi'}`);
};
console.log(`${result.evenings} soirées entrelacées, dont ${result.undecided} sans film lancé parmi les cinq\n`);
line('Film lancé', result.launch);
line('Film lancé puis aimé', result.loved);
console.log('\nProposition du jour (un moteur par jour) :');
for (const name of ['fiche', 'carte']) {
  const d = result.daily[name];
  console.log(`  ${name} : ${d.launched} lancées sur ${d.served} (${d.served ? (100 * d.launched / d.served).toFixed(0) : '—'} %)`);
}
const decided = result.launch.carte + result.launch.fiche;
if (decided < 50) {
  console.log(`\n${decided} soirées tranchées : il en faut quelques centaines pour lire un écart de quelques points.`);
}
