# Compte-rendu — Règles de mappage : « N sans code TVA » devient un filtre cliquable

**Date** : 2026-06-08
**Périmètre** : 1 fichier front (`apps/web/src/pages/MappingRulesPage.tsx`). Aucun changement d'API, de schéma ou de back. S'appuie sur le système de filtres/tri par colonne déjà en place.

---

## 1. Objectif

Rendre le compteur **« {emptyTvaCount} sans code TVA »** du sous-titre **cliquable** : un clic filtre le tableau pour n'afficher que les règles sans code TVA B1 ; un second clic désactive le filtre (bascule on/off), à la manière des cartes d'anomalie de `SuppliersPage.tsx` (`aria-pressed`).

---

## 2. Fichier modifié

`apps/web/src/pages/MappingRulesPage.tsx`.

---

## 3. Implémentation

### Critère unique « sans code TVA »

Extraction d'un helper module-scope, réutilisé par le compteur **et** le filtre (pas de duplication de logique) :

```ts
const isEmptyTva = (r: MappingRule): boolean => !r.taxCodeB1 || r.taxCodeB1.trim() === '';
```

- `emptyTvaCount` passe de l'inline `rules.filter((r) => !r.taxCodeB1 || …)` à `rules.filter(isEmptyTva)`.

### État de bascule

```ts
const [emptyTvaOnly, setEmptyTvaOnly] = useState(false);
```

### Compteur cliquable

Le `<span className="font-semibold text-warning">` est remplacé par un `<button type="button">` :

- `onClick={() => setEmptyTvaOnly((v) => !v)}`.
- `aria-pressed={emptyTvaOnly}`, `aria-label="Filtrer les règles sans code TVA"`, `title` contextuel (« Afficher uniquement… » / « Afficher toutes les règles »).
- Style : conserve `text-warning font-semibold` ; ajoute `cursor-pointer` + soulignement au survol ; état actif visible quand `emptyTvaOnly` est vrai (fond `bg-warning/10` arrondi + soulignement permanent).
- Rendu uniquement si `emptyTvaCount > 0` (comportement conservé).

### Application du filtre dans `rows`

Le filtre est appliqué **en amont** des filtres de colonne et du tri, dans le `useMemo` `rows` :

```ts
const base = emptyTvaOnly ? rules.filter(isEmptyTva) : rules;
let r = base.filter((rule) => RULE_COLUMNS.every(/* filtres de colonne */));
// … puis tri inchangé
```

`emptyTvaOnly` ajouté au tableau de dépendances du `useMemo`.

### Cohérence avec la réinitialisation

- `hasColumnFiltersOrSort` inclut désormais `|| emptyTvaOnly` ⇒ le bouton `FilterX` apparaît quand ce filtre est actif.
- Le clic sur `FilterX` remet aussi `setEmptyTvaOnly(false)` (en plus de `setColumnFilters({})` et `setSort(null)`).

### Message « aucune ligne »

La ligne « Aucune règle ne correspond aux filtres de colonne. » (`rows.length === 0`, `colSpan = RULE_COLUMNS.length + 2`) reste correcte lorsque le filtre est actif sans résultat — inchangée.

---

## 4. Garde-fous / non-régression

- Critère « vide » non dupliqué : `isEmptyTva` partagé par le compteur et le filtre.
- Le filtre se compose avec les filtres de colonne et le tri existants (appliqué en amont).
- Fonctionnalités intactes : Tester, Export/Import CSV, Actualiser, toggle actif, édition, suppression, édition en ligne du Code TVA, filtres/tri par colonne.
- TypeScript strict (pas de `any`) ; `emptyTvaOnly` typé `boolean`, helper typé.
- Accessibilité : `aria-pressed` reflète l'état, `aria-label` explicite.

---

## 5. Vérifications

| Check         | Commande                                             | Résultat                                     |
| ------------- | ---------------------------------------------------- | -------------------------------------------- |
| Typecheck     | `npm run typecheck -w apps/web` (`tsc --noEmit`)     | **OK** — 0 erreur                            |
| Lint (ESLint) | `npx eslint apps/web/src/pages/MappingRulesPage.tsx` | **OK** — 0 erreur                            |
| Build         | `npm run build:web` (`tsc && vite build`)            | **OK** (warning chunk > 500 kB pré-existant) |
| Prettier      | `prettier --write` (fichier modifié)                 | **formaté**                                  |

Relecture confirmée : clic sur « N sans code TVA » ⇒ seules les règles sans code TVA B1 s'affichent ; re-clic ⇒ liste complète ; combinable avec les filtres de colonne et le tri ; `FilterX` réinitialise aussi ce filtre ; `aria-pressed` reflète l'état actif/inactif.

---

_Fin du CR — Le compteur « N sans code TVA » est désormais un bouton bascule (`aria-pressed`) qui filtre les règles à code TVA B1 vide via un critère unique `isEmptyTva` partagé avec le compteur ; le filtre s'applique en amont des filtres de colonne et du tri, et est réinitialisé par `FilterX`. Typecheck, lint et build verts._
