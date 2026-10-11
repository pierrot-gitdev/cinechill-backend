// Vérifications de la fiche CinéMatch, sans Firebase ni réseau.
//
// À lancer après `npm run build`, depuis `functions/` :
//   node scripts/cinematch-fiche-check.mjs
//
// Les fiches sont écrites à la main : de faux films, de faux identifiants,
// assez pour vérifier que la règle fait ce qu'elle dit. Hors de `src`, ce
// script n'est ni compilé ni déployé.

import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const F = require('../lib/cinematch/fiche.js');

let failures = 0;
let checks = 0;
function check(label, condition) {
  checks++;
  if (!condition) {
    failures++;
    console.log(`  ÉCHEC  ${label}`);
  }
}

/* ------------------------------------------------------------------ *
 *  Lire une fiche TMDB
 * ------------------------------------------------------------------ */

const heatDetail = {
  id: 949,
  release_date: '1995-12-15',
  vote_average: 7.9,
  vote_count: 8776,
  genres: [{id: 80}, {id: 18}, {id: 28}],
  belongs_to_collection: {id: 1001},
  keywords: {keywords: [{id: 818}, {id: 10051}, {id: 155}, {id: 155}]},
  credits: {
    crew: [
      {id: 638, job: 'Director', department: 'Directing'},
      {id: 638, job: 'Screenplay', department: 'Writing'},
      {id: 99, job: 'Original Music Composer', department: 'Sound'},
    ],
    cast: Array.from({length: 12}, (_, i) => ({id: 1000 + i})),
  },
};
const heat = F.ficheFromMovieDetail(heatDetail);
check('identifiant lu', heat.id === 949);
check('genres lus dans l\'ordre', heat.genres.join() === '80,18,28');
check('mots-clés sans doublon', heat.keywords.join() === '818,10051,155');
check('réalisation et scénario, sans le compositeur',
    heat.makers.join() === '638');
check('huit premiers rôles seulement', heat.cast.length === 8);
check('saga lue', heat.collection === 1001);
check('décennie', heat.decade === 1990);
check('note et votes', heat.voteAverage === 7.9 && heat.voteCount === 8776);
check('une fiche lue est reconnue', F.isFiche(heat));
check('un objet quelconque ne l\'est pas', !F.isFiche({id: 1}));

const tv = F.ficheFromTvDetail({
  id: 1399, first_air_date: '2011-04-17', vote_average: 8.4, vote_count: 20000,
  created_by: [{id: 7}, {id: 8}],
  keywords: {results: [{id: 1}, {id: 2}]},
  aggregate_credits: {cast: [{id: 30}, {id: 31}]},
}, [18, 878]);
check('série : créateurs comme auteurs', tv.makers.join() === '7,8');
check('série : mots-clés dans `results`', tv.keywords.join() === '1,2');
check('série : genres fournis', tv.genres.join() === '18,878');
check('série : pas de saga', tv.collection === null);

/* ------------------------------------------------------------------ *
 *  Rareté et ressemblance
 * ------------------------------------------------------------------ */

function film(id, overrides = {}) {
  return {
    id, genres: [18], keywords: [], makers: [], cast: [], collection: null,
    decade: 2000, voteAverage: 7, voteCount: 1000, ...overrides,
  };
}
// Vingt drames quelconques, un film du même auteur que A, un film qui ne
// partage avec A que le genre « Drame ».
const crowd = Array.from({length: 20}, (_, i) =>
  film(100 + i, {keywords: [5000 + i], makers: [6000 + i]}));
const a = film(1, {genres: [80, 18], keywords: [10, 11], makers: [638],
  cast: [1, 2]});
const sameAuthor = film(2, {genres: [80, 18], keywords: [10], makers: [638]});
const sameGenreOnly = film(3, {genres: [18], keywords: [99], makers: [77]});
const rarity = F.buildRarity([a, sameAuthor, sameGenreOnly, ...crowd]);
const cmp = new F.FicheComparer(rarity);
check('un film se ressemble entièrement', cmp.similarity(a, a) === 1);
check('ressemblance symétrique',
    Math.abs(cmp.similarity(a, sameAuthor) -
      cmp.similarity(sameAuthor, a)) < 1e-12);
check('même auteur et même histoire > même genre seul',
    cmp.similarity(a, sameAuthor) > 3 * cmp.similarity(a, sameGenreOnly));
check('ressemblance entre 0 et 1', crowd.every((f) => {
  const s = cmp.similarity(a, f);
  return s >= 0 && s <= 1;
}));
check('aucun point commun, aucune ressemblance',
    cmp.similarity(film(4, {genres: [35], decade: 1960}),
        film(5, {genres: [27], decade: 2020})) === 0);
check('le genre le plus banal pèse le moins',
    cmp.similarity(film(6, {genres: [18], decade: null}),
        film(7, {genres: [18], decade: null})) <
    cmp.similarity(film(8, {genres: [80], decade: null}),
        film(9, {genres: [80], decade: null})) ||
    rarity.counts.get('genres|18') > rarity.counts.get('genres|80'));

/* ------------------------------------------------------------------ *
 *  Les styles
 * ------------------------------------------------------------------ */

check('dix styles', F.STYLES.length === 10);
check('clé reconnue', F.styleKeyOf('thriller') === 'thriller');
check('clé inconnue refusée', F.styleKeyOf('polar') === null);
check('Heat est un thriller', F.inStyle([80, 18, 28], 'thriller'));
check('Heat est aussi un film d\'action', F.inStyle([80, 18, 28], 'action'));
check('Heat n\'est pas une comédie', !F.inStyle([80, 18, 28], 'comedy'));
check('genre principal de Heat : thriller',
    F.isCoreStyle([80, 18, 28], 'thriller'));
check('Whiplash n\'est pas d\'abord un thriller',
    !F.isCoreStyle([18, 10402, 53], 'thriller'));

/* ------------------------------------------------------------------ *
 *  Les six films variés d'un style
 * ------------------------------------------------------------------ */

let seed = 42;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const styleFilms = [
  film(201, {genres: [80], makers: [1]}),
  film(202, {genres: [80], makers: [1]}),
  film(203, {genres: [53], makers: [2]}),
  film(204, {genres: [18, 53], makers: [3]}),
  film(205, {genres: [9648], makers: [4]}),
  film(206, {genres: [80], makers: [5]}),
  film(207, {genres: [80], makers: [6]}),
];
const styleCmp = new F.FicheComparer(F.buildRarity(styleFilms));
const order = F.orderVaried(styleFilms, styleCmp, {
  random,
  loved: new Set([206]),
  recent: new Set([207]),
  core: new Set(styleFilms.filter((f) => F.isCoreStyle(f.genres, 'thriller'))
      .map((f) => f.id)),
});
check('tous les films ordonnés, sans doublon',
    order.length === 7 && new Set(order).size === 7);
check('un coup de cœur du genre principal en premier', order[0] === 206);
check('le film montré récemment en dernier', order[6] === 207);
check('deux films du même auteur ne se suivent pas en tête',
    !(order.indexOf(201) <= 1 && order.indexOf(202) <= 1));

/* ------------------------------------------------------------------ *
 *  Le classement des cinq
 * ------------------------------------------------------------------ */

const anchor = film(300, {genres: [80, 53], keywords: [70, 71],
  makers: [638], cast: [1]});
const near = film(301, {genres: [80, 53], keywords: [70], makers: [638]});
const far = film(302, {genres: [35], keywords: [90], makers: [9]});
const lovedComedy = film(303, {genres: [35], keywords: [90], makers: [9]});
const famous = film(304, {genres: [35], keywords: [91], makers: [10],
  voteAverage: 8.5, voteCount: 50000});
const obscure = film(305, {genres: [35], keywords: [91], makers: [10],
  voteAverage: 8.5, voteCount: 12});
check('réception : beaucoup de votes > peu de votes à note égale',
    F.receptionOf(famous) > F.receptionOf(obscure));
const pool = [near, far, famous, obscure,
  ...crowd.slice(0, 8)].map((f) => ({fiche: f, listed: false, shift: 0}));
const pickCmp = new F.FicheComparer(
    F.buildRarity([anchor, lovedComedy, ...pool.map((c) => c.fiche)]));
const ranked = F.rankPicks(pool, anchor, [lovedComedy], pickCmp);
check('le film proche du film choisi passe en tête',
    ranked[0].fiche.id === near.id);
check('les termes de note sont rendus',
    typeof ranked[0].terms.anchor === 'number' &&
    typeof ranked[0].terms.taste === 'number');
const noAnchor = F.rankPicks(pool, null, [lovedComedy], pickCmp);
check('sans film choisi, le goût décide',
    noAnchor[0].fiche.genres.includes(35));
const noTaste = F.rankPicks(pool, null, [], pickCmp);
check('sans rien, la réception décide', noTaste[0].fiche.id === famous.id);
const shifted = F.rankPicks(pool.map((c) => c.fiche.id === far.id ?
  {...c, shift: 10} : c), anchor, [], pickCmp);
check('un décalage brut s\'ajoute à la note', shifted[0].fiche.id === far.id);

const listedPool = pool.map((c, i) => ({...c, listed: i < 4}));
const five = F.composePicks(
    F.rankPicks(listedPool, anchor, [], pickCmp), pickCmp);
check('cinq films', five.length === 5);
check('cinq films distincts', new Set(five.map((p) => p.fiche.id)).size === 5);
check('un seul film de la watchlist',
    five.filter((p) => p.listed).length <= 1);
check('un remplacement rend le nombre demandé', F.composePicks(
    F.rankPicks(pool, anchor, [], pickCmp), pickCmp, 2).length === 2);
check('vivier vide, composition vide', F.composePicks([], pickCmp).length === 0);

/* ------------------------------------------------------------------ *
 *  Chercher autour du film choisi
 * ------------------------------------------------------------------ */

const keywords = F.anchorKeywords(heat, null);
check('« d\'après un roman » n\'aide pas à chercher', !keywords.includes(818));
check('les autres mots-clés gardés', keywords.includes(10051));

/* ------------------------------------------------------------------ *
 *  Performance : une soirée réelle compare ~70 candidats à ~30 films
 * ------------------------------------------------------------------ */

const big = Array.from({length: 400}, (_, i) => film(1000 + i, {
  genres: [[18], [35], [80, 53], [878, 12]][i % 4],
  keywords: [i % 37, (i * 7) % 101, (i * 13) % 211],
  makers: [i % 150], cast: [i % 300, (i + 1) % 300],
}));
const t0 = performance.now();
const bigCmp = new F.FicheComparer(F.buildRarity(big));
const bigRanked = F.rankPicks(big.slice(0, 70).map((f) => ({
  fiche: f, listed: false, shift: 0})), big[100], big.slice(200, 230), bigCmp);
F.composePicks(bigRanked, bigCmp);
F.orderVaried(big.slice(0, 300), bigCmp,
    {random, loved: new Set(), recent: new Set(), core: new Set()});
const elapsed = performance.now() - t0;
check(`classement et ordre en moins de 500 ms (${elapsed.toFixed(0)} ms)`,
    elapsed < 500);

console.log(`${checks - failures}/${checks} vérifications passées`);
process.exit(failures === 0 ? 0 : 1);
