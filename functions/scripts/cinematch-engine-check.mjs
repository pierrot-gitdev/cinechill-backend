// Vérifications des règles communes de CinéMatch (`cinematch/engine.ts`),
// sans Firebase ni réseau : filtres de la soirée et élargissement, repos des
// films montrés, règle de la famille, séries, tirage déterministe.
//
// À lancer après `npm run build`, depuis `functions/` :
//   node scripts/cinematch-engine-check.mjs
//
// Le score à huit axes et ses vérifications sont partis avec
// `getCineMatchFive` le 18 octobre 2026.

import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const E = require('../lib/cinematch/engine.js');

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 9, 18, 20, 0, 0);
const AXES = {ch: 0, ry: 0, fa: 0, de: 0, an: 0, to: 0, ec: 0, in: 0};

let failures = 0;
let checks = 0;
function check(label, ok, detail = '') {
  checks++;
  if (!ok) {
    failures++;
    console.log(`  ÉCHEC  ${label} ${detail}`);
  }
}

function film(id, extra = {}) {
  return {
    id, axes: AXES, genreIds: [18], year: 2010, voteCount: 1000, runtime: 100,
    providerIds: [8], keywordNames: [], listed: false, certification: null,
    ...extra,
  };
}
const context = (situation, extra = {}) => ({
  situation: {company: 'alone', duration: 'any', platformIds: [], ...situation},
  excludedIds: new Set(), exposure: new Map(), now: NOW, ...extra,
});
const ids = (result) => result.eligible.map((f) => f.id).sort((a, b) => a - b).join();

/* Les filtres durs. */
{
  const films = [
    film(1, {runtime: 80}), film(2, {runtime: 100}), film(3, {runtime: 140}),
    film(4, {runtime: null}), film(5, {providerIds: [119]}), film(6),
  ];
  // Le filtre strict est `conforming` : sous trois films, l'élargissement
  // ajoute les autres à `eligible`, et c'est voulu.
  const strict = (situation) => [...E.applyFilters(films, context(situation)).conforming]
      .sort((a, b) => a - b).join();
  check('durée « moins d\'1 h 30 »', strict({duration: 'short'}) === '1', strict({duration: 'short'}));
  check('durée « 1 h 30 à 2 h »', strict({duration: 'medium'}) === '2,5,6');
  check('un film sans durée ne passe pas quand une durée est demandée', !strict({duration: 'long'}).split(',').includes('4'));
  check('plateformes', strict({platformIds: ['119']}) === '5');
  check('sous trois films, l\'élargissement complète', E.applyFilters(films, context({duration: 'short'})).eligible.length >= 3);
  check('les films vus sont écartés',
      ids(E.applyFilters(films, context({}, {excludedIds: new Set([1, 2])}))) === '3,4,5,6');
}

/* La famille. */
{
  const films = [
    film(1), film(2, {genreIds: [27]}), film(3, {certification: '16'}),
    film(4, {certification: '-16'}), film(5, {certification: '12'}), film(6, {certification: '18'}),
  ];
  check('en famille : ni horreur ni 16 ou 18, même écrit « -16 »',
      ids(E.applyFilters(films, context({company: 'family'}))) === '1,5');
  check('seul, tout passe', E.applyFilters(films, context({})).eligible.length === 6);
  check('familyAllows', E.familyAllows([35], 'U') && !E.familyAllows([27], null) && !E.familyAllows([18], '18'));
}

/* Le repos d'un film montré. */
{
  const record = (shownCount, daysAgo, chosen = false) =>
    ({shownCount, lastShownAt: NOW - daysAgo * DAY, chosenAt: chosen ? NOW - DAY : null});
  check('montré deux fois, jamais choisi, il y a deux jours : au repos', E.isResting(record(2, 2), NOW));
  check('montré une fois : pas au repos', !E.isResting(record(1, 1), NOW));
  check('choisi : pas au repos', !E.isResting(record(3, 1, true), NOW));
  check('au bout de cinq jours : de retour', !E.isResting(record(2, 6), NOW));
  const exposure = new Map([[2, record(2, 1)]]);
  check('un film au repos sort des candidats',
      ids(E.applyFilters([film(1), film(2)], context({}, {exposure}))) === '1');
  const fresh = E.exposurePenalty(record(1, 0), NOW);
  const older = E.exposurePenalty(record(1, 7), NOW);
  check('la pénalité d\'exposition décroît avec le temps', fresh > older && older > 0, `${fresh} ${older}`);
  check('et s\'éteint au bout de quatorze jours', E.exposurePenalty(record(1, 14), NOW) === 0);
  check('sans journal, pas de pénalité', E.exposurePenalty(undefined, NOW) === 0);
}

/* L'élargissement. */
{
  const films = Array.from({length: 10}, (_, i) => film(i + 1, {runtime: 100, providerIds: [8]}));
  const noPlatform = E.applyFilters(films, context({platformIds: ['99999']}));
  check('plateforme introuvable : les plateformes s\'élargissent, pas la durée',
      noPlatform.widened?.platforms === true && noPlatform.widened.duration === false &&
      noPlatform.eligible.length === 10, JSON.stringify(noPlatform.widened));
  const shortEvening = E.applyFilters(films, context({duration: 'short'}));
  check('durée introuvable : la durée s\'élargit, pas les plateformes',
      shortEvening.widened?.duration === true && shortEvening.widened.platforms === false &&
      shortEvening.eligible.length === 10, JSON.stringify(shortEvening.widened));
  const mixed = films.map((f, i) => (i === 3 ? {...f, runtime: 85} : f));
  const mixedResult = E.applyFilters(mixed, context({duration: 'short'}));
  check('les films conformes restent reconnus après élargissement',
      mixedResult.conforming.size === 1 && mixedResult.conforming.has(4));
  check('sans contrainte, rien d\'élargi', E.applyFilters(films, context({})).widened === null);
  check('rien du tout : pas d\'élargissement annoncé',
      E.applyFilters([], context({duration: 'short'})).widened === null);
}

/* Les séries. */
{
  const mini = film(1, {seasonCount: 1, episodeCount: 6, runtime: 50, status: 'ended'});
  const saga = film(2, {seasonCount: 5, episodeCount: 50, runtime: 50, status: 'returning'});
  check('mini-série : elle tient « peu d\'engagement »', E.engagementFit(mini, 'mini') > 0 && E.engagementFit(saga, 'mini') < 0);
  check('longue série : elle tient « longtemps »', E.engagementFit(saga, 'long') > 0 && E.engagementFit(mini, 'long') < 0);
  check('« peu importe » : neutre', E.engagementFit(saga, 'any') === 0);
  const canceled = film(3, {status: 'canceled'});
  check('annulée : recule, moins quand on veut juste essayer',
      E.statusTerm(canceled, 'long') < E.statusTerm(canceled, 'season') && E.statusTerm(canceled, 'season') < 0);
  check('terminée : avance un peu', E.statusTerm(mini, 'mini') > 0);
}

/* Le tirage. */
{
  const a = E.seededRandom('pierre:2026-10-18');
  const b = E.seededRandom('pierre:2026-10-18');
  const c = E.seededRandom('pierre:2026-10-19');
  const first = [a(), a(), a()];
  check('même graine, mêmes tirages', first.join() === [b(), b(), b()].join());
  check('autre graine, autres tirages', first.join() !== [c(), c(), c()].join());
  const draws = Array.from({length: 1000}, E.seededRandom('x'));
  check('tirages dans [0, 1)', draws.every((v) => v >= 0 && v < 1));
}

/* La performance : la carte filtre tout le catalogue à chaque appel. */
{
  const catalogue = Array.from({length: 17500}, (_, i) => film(i + 1, {
    runtime: 70 + (i % 120), providerIds: i % 3 === 0 ? [8] : [], genreIds: i % 9 === 0 ? [27] : [18],
  }));
  const exposure = new Map(Array.from({length: 200}, (_, i) =>
    [i + 1, {shownCount: 2, lastShownAt: NOW - DAY, chosenAt: null}]));
  const start = performance.now();
  for (let t = 0; t < 5; t++) {
    E.applyFilters(catalogue, context({company: 'family', duration: 'medium', platformIds: ['8']},
        {exposure, excludedIds: new Set(Array.from({length: 500}, (_, i) => i * 7))}));
  }
  const ms = (performance.now() - start) / 5;
  check('applyFilters sur 17 500 films < 50 ms', ms < 50, `${ms.toFixed(1)} ms`);
  console.log(`  (applyFilters sur 17 500 films : ${ms.toFixed(1)} ms)`);
}

console.log(`${checks - failures}/${checks} vérifications passées.`);
process.exitCode = failures === 0 ? 0 : 1;
