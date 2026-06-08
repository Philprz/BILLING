# Compte-rendu — Page Fournisseurs SAP : rattachement des doublons au bon fournisseur SAP

**Date** : 2026-06-08
**Périmètre** : 6 fichiers (1 schéma + migration, 1 repo, 1 routes API, 1 worker, 1 API front, 1 page). Aucune fusion SAP ; aucune écriture SAP en autonomie.

> ⚠️ **Aucune écriture SAP exécutée en autonomie.** Le flag `U_NOVA_Doublon='Y'` (PATCH BP) est codé et déclenché par l'UI lors d'un rattachement manuel, en **best-effort** (n'échoue jamais le rattachement déjà persisté en base).

---

## 1. Principe directeur (verrouillé)

Le **maître** d'un groupe de doublons est **toujours** une fiche présente dans SAP (`validFor:true`). Un **orphelin de cache** (`validFor:false`, absent du dernier sync) ne peut être qu'un **alias** dont on re-pointe les factures vers la bonne fiche SAP. Le rattachement est **côté NOVA-PA uniquement** : re-pointage des factures + mapping durable + exclusion de la liste/auto-matching + flag SAP sur les alias réels. **Pas de fusion de BP SAP.**

---

## 2. Modèle de données — `SupplierMerge` + migration

`packages/database/prisma/schema.prisma` : nouveau modèle `SupplierMerge` (`supplier_merges`) — mapping durable **alias → maître** survivant aux resync.

| Colonne                              | Rôle                                                                 |
| ------------------------------------ | -------------------------------------------------------------------- |
| `alias_cardcode` (**unique**)        | CardCode du doublon rattaché (1 alias → 1 maître)                    |
| `master_cardcode` (indexé)           | CardCode du fournisseur SAP maître (`validFor:true` au rattachement) |
| `reason`, `created_by`, `created_at` | Traçabilité                                                          |

Migration **`20260608000000_add_supplier_merges`** : `CREATE TABLE` + index unique alias + index master, **additive uniquement** (`IF NOT EXISTS`, `migrate deploy`-safe, aucune contrainte sur les tables existantes, pas d'`ALTER TYPE`, pas de backfill).

> **Application de la migration** : conformément à la convention projet (« ne pas `migrate dev » sur la base de dev, cf. lots antérieurs `partial*unique_doc_supplier`/`payment_level_s2`), la migration est **créée** et **`prisma generate`** lancé pour typer le client (`prisma.supplierMerge`disponible, confirmé par le typecheck des 5 workspaces). La migration s'appliquera via`migrate deploy`. _Note Windows : le rename du moteur natif (`query_engine-windows.dll.node`) a renvoyé `EPERM`car des process Node dev tenaient le binaire ; bénin — les types TS du client ont bien été régénérés (le binaire moteur est schéma-agnostique). À défaut, relancer`npm run db:generate` une fois les serveurs dev arrêtés.*

---

## 3. Back-end

### `apps/api/src/repositories/supplier.repository.ts`

- **`findSuppliers`** : le `where` impose désormais **toujours** `validFor:true` (exclut les orphelins) **et** `cardcode notIn` des `aliasCardcode` de `SupplierMerge` (exclut les alias rattachés). En recherche : `AND: [baseWhere, { OR: [...8 clauses contains...] }]`. `count` partage le même `where`. Projection `SupplierCacheDto` + `invoiceCount` inchangés.
- **`findDuplicateGroups()`** : groupes (≥ 2) par clé fiscale (`federaltaxid || taxId0`), **incluant** les `validFor:false` (pour que la réconciliation trouve les orphelins), **hors** alias déjà rattachés. Chaque membre porte `validFor` + `invoiceCount`.
- **`mergeSuppliers({ masterCardcode, aliasCardcodes, reason?, createdBy? })`** : (1) absorbe les orphelins `validFor:false` partageant la **clé fiscale du maître** ; (2) `upsert` du mapping pour chaque alias (idempotent sur `aliasCardcode`) ; (3) `invoice.updateMany` re-pointe `supplierB1Cardcode` des alias vers le maître → `invoicesRepointed`. **Ne touche jamais à SAP.**

### `apps/api/src/routes/suppliers.ts`

- **`POST /api/suppliers/merge`** (rattachement manuel) : valide que `masterCardcode` existe **et** `validFor:true` (sinon **422**), `aliasCardcodes` non vide hors maître. Appelle `mergeSuppliers`, puis pose `U_NOVA_Doublon='Y'` sur les alias **réels** (`validFor:true`) via `patchBusinessPartnerFiscal` en **best-effort** (try/catch + `log.warn`, ne bloque pas). Réponse `{ success, data: { merged, invoicesRepointed } }`.
- **`POST /api/suppliers/reconcile`** (auto) : pour chaque groupe à **maître SAP unique** (exactement 1 `validFor:true`), rattache les autres membres (orphelins) sans flag SAP. Groupes **ambigus** (≥ 2 `validFor:true`) **ignorés**. Réponse `{ success, data: { groupsReconciled, invoicesRepointed } }`.
- **Supprimé** : `PATCH /api/suppliers/:cardCode/doublon` (superseded). **Conservés** : `createSapUdfNovaDoublon` + `POST /api/sap/setup/udf-nova-doublon` (le flag est toujours posé, désormais via `/merge`).

### `apps/worker/src/matching/enricher.ts`

- **`loadSuppliers`** exclut les `aliasCardcode` (`validFor:true` + `notIn` alias) ⇒ `matchSupplier` route les futures factures vers le **maître**, jamais vers un alias absorbé.

---

## 4. Front-end

### `apps/web/src/api/suppliers.api.ts`

- **Supprimé** `apiFlagSupplierDoublon`. **Ajoutés** `apiMergeSuppliers(master, aliases, reason?)` et `apiReconcileSuppliers()`.

### `apps/web/src/pages/SuppliersPage.tsx`

- **Réconciliation auto au montage** : `useEffect` unique (deps `[load, search]`) gardé par un `ref` `reconcileDone` — au 1er passage : `apiReconcileSuppliers()` (erreur **non bloquante**) puis `load`. Les chargements ultérieurs (recherche, post-merge) ne relancent pas la réconciliation. Si `groupsReconciled > 0`, `alert-info` discret « N doublon(s) rattaché(s) automatiquement ».
- **Colonne Actions** : bouton « Signaler doublon » **retiré** ; pour une ligne d'un **groupe de doublons visible** (donc cas ambigu multi-SAP), bouton **« Rattacher »** (`GitMerge`) ouvrant le modal pré-chargé avec le groupe (`dupGroupByCardcode[cardcode]`).
- **`MergeDuplicatesModal`** (composant local) : radio de choix du maître (membres tous `validFor:true`), défaut = plus grand `invoiceCount` (égalité → plus petit `cardcode`) ; aperçu d'impact « X facture(s) repointée(s) vers `<maître>` (N alias) » ; motif facultatif ; confirmation → `apiMergeSuppliers` + `load` + toast « N fiche(s) rattachée(s), X facture(s) repointée(s) » ; états chargement/erreur.
- **Détection (client)** : `useMemo` regroupe les fiches affichées par clé fiscale, produit `duplicates`/`duplicateSet` (groupes ≥ 2 cardcodes distincts) + `dupGroupByCardcode`.

---

## 5. Garde-fous

- **Maître = SAP** : back **rejette (422)** tout `masterCardcode` non `validFor:true` ; le front ne propose comme maîtres que des fiches affichées (déjà `validFor:true`).
- **Pas de fusion SAP** : seul `U_NOVA_Doublon='Y'` est posé sur les alias réels (best-effort).
- **Idempotence** : `merge`/`reconcile` réexécutables (upsert sur `aliasCardcode`, alias déjà exclus de la liste et des groupes).
- **Règle « ne jamais inventer »** : le rattachement ne modifie que `supplierB1Cardcode` des factures + la table de mapping ; aucune valeur fiscale inventée.
- **Réversibilité** (« détacher ») : hors périmètre de cette itération.

---

## 6. Validation

| Check                                                    | Résultat                                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `prisma generate` (types client)                         | **OK** — `prisma.supplierMerge` typé (typecheck vert) ; migration créée (à appliquer via `migrate deploy`) |
| `npm run typecheck` (5 workspaces)                       | **clean**                                                                                                  |
| `npm run lint` (ESLint repo)                             | **clean**                                                                                                  |
| `npm run build` (shared → database → api → worker → web) | **OK** (2553 modules ; warning chunk > 500 kB pré-existant)                                                |
| Prettier (fichiers TS modifiés)                          | **formaté** (`schema.prisma` hors glob `*.{ts,tsx,json,md}`)                                               |
| Références mortes `apiFlagSupplierDoublon` / `/doublon`  | **aucune**                                                                                                 |

---

## 7. Setup LIVE (rappel, manuel)

L'UDF `U_NOVA_Doublon` (OCRD) doit exister en SAP pour que le flag posé au rattachement n'échoue pas : `POST /api/sap/setup/udf-nova-doublon` (idempotent). **Le rattachement (re-pointage + mapping) fonctionne même si le flag SAP échoue** (best-effort). Appliquer la migration `20260608000000_add_supplier_merges` via `migrate deploy` avant mise en service.

---

_Fin du CR — Rattachement des doublons : orphelins de cache et alias exclus de la liste et de l'auto-matching ; réconciliation auto des groupes à maître SAP unique ; modal de rattachement pour les groupes ambigus (≥ 2 fiches SAP) ; re-pointage des factures + mapping durable `SupplierMerge` ; flag SAP best-effort ; aucune fusion SAP. Checks verts : typecheck 5 workspaces, lint, build._
