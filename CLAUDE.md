# Règles de développement — Cinechill backend

## 80 colonnes, vérifiées et pas estimées

Aucune ligne de `functions/src/index.ts` ne dépasse **80 caractères**. La règle
vient d'`eslint-config-google` (`max-len`), et elle vaut pour le code comme pour
les commentaires.

**Le lint fait foi, et il se lance avant de considérer quoi que ce soit fini :**

```bash
cd functions && npm run lint
```

Il doit rendre le vide. Un dépassement n'est pas un détail de forme : le fichier
se lit en revue sur deux colonnes, et une ligne qui déborde casse la lecture bien
plus qu'elle n'économise de retours.

### Le piège du comptage

**Ne jamais compter les caractères en octets.** Les commentaires sont en
français, et chaque accent pèse deux octets en UTF-8. `awk 'length($0)>80'`,
`wc -c` et `cut -c` comptent des octets : ils signalent une centaine de fausses
lignes trop longues et masquent les vraies.

Pour un contrôle rapide sans passer par ESLint, compter en caractères :

```bash
python3 -c "
[print(i, len(l), l[:60]) for i, l in
 enumerate(open('functions/src/index.ts', encoding='utf-8').read().split(chr(10)), 1)
 if len(l) > 80]"
```

### Comment raccourcir

Une ligne trop longue se **réécrit**, elle ne se coupe pas au hasard.

| Ce qui déborde | Traitement |
|---|---|
| Un paragraphe de commentaire | Réenrouler le paragraphe entier, pas la seule ligne fautive |
| Une signature de fonction | Un paramètre par ligne, indentation de 4 |
| Une condition composée | Couper avant l'opérateur logique, indentation de 4 |
| Une expression imbriquée | Extraire une constante nommée au-dessus |
| Un type de retour complexe | Le nommer dans une `interface` |

Ce dernier cas rend service deux fois : un type de retour étalé sur deux lignes
casse aussi `valid-jsdoc`, qui ne sait pas lire un `@return` multiligne.

## Les commits

Mêmes règles que le dépôt iOS, et pour la même raison : un message de commit ne
se relit jamais au bon moment, le *pourquoi* va dans les commentaires du code.

- **Une seule ligne, pas de corps.**
- Français, verbe en tête au présent : « Ajoute », « Ferme », « Monte ».
- 70 caractères au plus, pas de préfixe (`feat:`, `fix:`), pas d'emoji.
- Un commit par changement réel. Un sujet d'une ligne ne peut pas couvrir
  honnêtement deux sujets : séparer plutôt qu'allonger.

## Le déploiement

`functions/.env` porte `APP_CHECK_MODE` et **est suivi par git** (exception
explicite dans `.gitignore`). Ce n'est pas un secret mais un réglage de
déploiement : l'ignorer ferait repartir un déploiement neuf sur une autre valeur
que celle voulue.

Les valeurs sont `off`, `monitor` et `enforce`. Passer à `enforce` refuse toute
requête sans attestation valide : ne le faire qu'une fois le parc passé à une
version de l'app qui sait attester.
