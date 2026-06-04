# Compte-rendu — EndpointID des vendeurs étrangers / OSS « EU » (BT-34 / BT-49)

**Date** : 2026-06-04
**Périmètre** : fiabiliser le `cbc:EndpointID` (BT-34 vendeur / BT-49 acheteur) du générateur pour les parties **étrangères** ou **OSS « EU »** (cas OpenAI, `EU372041333`). Avant cette passe, un identifiant TVA non mappable sortait avec un `cbc:EndpointID` **sans `schemeID`** (commentaire TODO) — **invalide Peppol** (un EndpointID requiert un code EAS valide). Le risque inverse (attribuer `9957` FR:VAT à un non-FR) était déjà écarté.
**Référentiel** : EN16931 BT-34 / BT-49 ; **liste EAS Peppol BIS Billing 3.0** — https://docs.peppol.eu/poacc/billing/3.0/codelist/eas/ (relevée, **non devinée**).

> **Exécution autonome** : aucune question posée. Décisions d'ambiguïté documentées en §5.

---

## 1. Décisions verrouillées appliquées

1. **Arbre de décision `resolveEndpoint(party)`** (vendeur **et** acheteur), n'émettant **jamais** un scheme faux ni un `EndpointID` sans `schemeID` :
   1. **SIRET** présent → `schemeID="0009"`, valeur = SIRET ;
   2. sinon **SIREN** présent → `schemeID="0002"`, valeur = SIREN (_branche présente pour conformité à l'arbre ; non alimentée aujourd'hui — voir §5.2_) ;
   3. sinon **TVA** présente :
      - préfixe (2 lettres) mappant un **EAS national** (table §3) → ce scheme, valeur = TVA complète ;
      - sinon (préfixe **`EU`** OSS **ou** inconnu) : si **`routingCode`** fourni → `schemeID="0225"` (FRCTC), valeur = `routingCode` ; sinon → **aucun `EndpointID`** + `peppolRoutable=false` + commentaire `<!-- TODO EAS … -->` ;
   4. sinon (aucun identifiant) → **aucun `EndpointID`** + `peppolRoutable=false`.
2. **Règles dures** : jamais `9957` (ni aucun scheme national) pour un identifiant non rattachable au pays ; jamais d'`EndpointID` sans `schemeID` valide.
3. **`routingCode` non persisté** : aucun champ Prisma, aucune migration (entrée de génération uniquement, comme `paymentDate`). Confirmé : aucune migration ajoutée.

---

## 2. Modifications fichier par fichier

### API — `apps/api/src/services/invoice-generator.service.ts`

- **Table `VAT_EAS_BY_PREFIX`** : ajout **`IT → 0211`** (Partita IVA) et **`GR → 9933`** (alias ISO de `EL`). En-tête de commentaire réécrite (source officielle, codes EAS de TVA strictement nationaux, aucun code pour la TVA OSS « EU »).
- **`FRCTC_EAS_SCHEME = '0225'`** _(nouveau)_ : constante documentée comme **hypothèse à valider PDP/AIFE**.
- **`resolveEndpoint(party)`** _(nouveau)_ : arbre de décision §1 → `{ schemeID?, value?, routable, unmappedVatPrefix? }`.
- **`buildEndpointXml(res)`** _(nouveau, remplace `buildEndpointId`)_ : sérialise la résolution ; si non routable pour cause de TVA non mappable, laisse un commentaire `<!-- TODO EAS … (hypothèse 0225) -->` ; sinon rien.
- **`computePeppolRoutable(data)`** _(nouveau, exporté)_ : `true` ssi vendeur **et** acheteur ont pu produire un `EndpointID`.
- **`generateUblXml`** : `supplierEndpoint` / `buyerEndpoint` passent par `buildEndpointXml(resolveEndpoint(...))` avec `routingCode`.
- **Types** : `InvoiceGenSupplier.routingCode?: string` et `InvoiceGenData.buyerRoutingCode?: string` (documentés « non persistés »). `summary.peppolRoutable: boolean` ajouté à `GeneratedInvoice` et renseigné dans `generateAndSave`.
- **PDF (`writePdf`)** : si `!computePeppolRoutable(data)`, ligne discrète « **Routage Peppol : non applicable (voie PPF)** » dans le bloc RÉFÉRENCES.

### API — `apps/api/src/routes/invoice-generator.ts`

- Schéma Fastify `POST /generate` : ajout `supplier.routingCode` et `buyerRoutingCode` (`string`, maxLength 100).

### Web — `apps/web/src/api/generator.api.ts`

- `GenSupplier.routingCode?`, `InvoiceGenData.buyerRoutingCode?`, `summary.peppolRoutable: boolean`.

### Web — `apps/web/src/pages/InvoiceGeneratorPage.tsx`

- Cartes **vendeur** et **acheteur** : champ « **Code de routage CTC (EAS 0225)** » + aide « pour identifiants TVA OSS/étrangers sans EAS national ».
- Récapitulatif post-génération : encart non bloquant si `peppolRoutable === false` (rappel voie PPF, document valide EN16931).

### Tests — `tests/unit/invoice-generator.test.ts`

- +7 tests (`describe('generateUblXml — EndpointID EAS …')`) — cf. §4.

---

## 3. Table préfixe TVA → EAS réellement implémentée (sourcée)

Source : liste EAS officielle (URL ci-dessus). Extrait des entrées pertinentes / ajoutées :

| Préfixe TVA     | EAS        | Libellé officiel                      |
| --------------- | ---------- | ------------------------------------- |
| `FR`            | `9957`     | French VAT number                     |
| `DE`            | `9930`     | Germany VAT number                    |
| `BE`            | `9925`     | Belgium VAT number                    |
| `NL`            | `9944`     | Netherlands VAT number                |
| `ES`            | `9920`     | AEAT (Espagne)                        |
| `AT`            | `9914`     | Österreichische USt-IdNr.             |
| **`IT`**        | **`0211`** | **Italie — Partita IVA** _(ajouté)_   |
| `PL`            | `9945`     | Poland VAT number                     |
| `PT`            | `9946`     | Portugal VAT number                   |
| `IE`            | `9935`     | Ireland VAT number                    |
| `LU`            | `9938`     | Luxemburg VAT number                  |
| `GB`            | `9932`     | United Kingdom VAT number             |
| `EL` / **`GR`** | `9933`     | Greece VAT number _(alias GR ajouté)_ |
| `CH`            | `9927`     | Switzerland VAT number                |

(Table complète = entrées préexistantes `9910..9953` + `9957`, conservées telles quelles.) **Identifiants non-TVA** : `0009` SIRET, `0002` SIREN, **`0225` FRCTC ELECTRONIC ADDRESS** (routage CTC), `9959` EIN USA. Tout préfixe **absent** de la liste officielle → branche « non mappé » (3.3).

> ⚠️ **Il n'existe AUCUN code EAS pour la TVA OSS « EU »** : un identifiant `EU…` ne peut pas porter de scheme de TVA. D'où l'hypothèse `0225` ci-dessous.

---

## 4. Comportement des cas de test (vérifié)

| Cas                                 | Entrée                             | EndpointID émis                          | `peppolRoutable`        |
| ----------------------------------- | ---------------------------------- | ---------------------------------------- | ----------------------- |
| Vendeur **FR + SIRET**              | `siret` renseigné                  | `0009` = SIRET                           | —                       |
| Vendeur **DE** (TVA, sans SIRET)    | `taxId=DE123456789`                | `9930` = `DE123456789`                   | —                       |
| Vendeur **IT** (Partita IVA)        | `taxId=IT12345678901`              | `0211` = `IT12345678901`                 | —                       |
| Vendeur **OSS EU + routingCode**    | `taxId=EU372041333`, `routingCode` | **`0225` = routingCode** (≠ TVA, ≠ 9957) | `true` (si acheteur OK) |
| Vendeur **OSS EU sans routingCode** | `taxId=EU372041333`                | **aucun** + commentaire TODO             | **`false`**             |
| Acheteur **FR** (TVA, sans SIRET)   | `buyerVatNumber=FR12404833048`     | `9957` = TVA (légitime)                  | —                       |

---

## 5. Décisions d'ambiguïté & limites assumées

1. **`peppolRoutable` = (vendeur routable **ET** acheteur routable)** : interprétation littérale de « false si un EndpointID a été omis ». Conséquence assumée : une facture dont l'**acheteur** est dépourvu d'identifiant (cas démo) ressort `peppolRoutable=false` — sémantiquement correct (non routable Peppol), purement informatif (non bloquant).
2. **Branche SIREN (0002) présente mais non alimentée** : l'arbre de décision la prévoit, mais aucun champ d'entrée « SIREN » n'existe côté vendeur (seul `siret` est saisi) ; le « Schéma / types » du brief ne demandait que `routingCode`. La branche reste pour robustesse/lisibilité (paramètre `siren` toujours `undefined` aujourd'hui) — à câbler si un champ SIREN est ajouté.
3. **`IT → 0211`** : `0211` est le code EAS de la **Partita IVA** italienne (liste Peppol). Le `WebFetch` de résumé l'a étiqueté « CODICE FISCALE » (imprécision du résumé) ; la décision suit la liste officielle + le brief (`IT→0211 (Partita IVA)`).
4. **`GR` ajouté en alias de `EL`** : le préfixe TVA grec normalisé est `EL`, mais certains flux utilisent `GR` (code ISO). Les deux pointent vers `9933`.
5. **Aucune migration / non-persistance** : `routingCode` (vendeur et acheteur) = entrée de génération, comme `paymentDate`. Confirmé : aucun champ Prisma, aucune migration.
6. **BT-23 / BT-24 / cadre non touchés.**

> ⚠️ **Hypothèse à confirmer PDP / AIFE** : que **`0225` (FRCTC ELECTRONIC ADDRESS)** est bien le scheme attendu pour router un vendeur/acheteur étranger ou OSS dans le flux CTC français, et que la valeur portée est le **code de routage** (et non la TVA OSS). Tant qu'elle n'est pas confirmée, le comportement ne produit **jamais** de scheme faux ni d'EndpointID invalide : à défaut de `routingCode`, **aucun** `EndpointID` n'est émis (document valide EN16931, voie PPF/e-reporting).

---

## 6. Vérification

| Contrôle                           | Résultat                          |
| ---------------------------------- | --------------------------------- |
| `typecheck` api + web              | ✅ clean                          |
| `eslint` (5 fichiers touchés)      | ✅ clean                          |
| `vitest` `invoice-generator`       | ✅ **114/114** (107 + 7 nouveaux) |
| `vitest` unitaire (suite complète) | ✅ **285/285**                    |

### Runtime — profil OpenAI (`Invoice-3F868EA1-0015`, vendeur OSS `EU372041333` sans SIRET)

Script temporaire + artefacts **supprimés** (`git status` propre) :

| Cas                                      | EndpointID vendeur                  | `peppolRoutable` | Garanties                                                   |
| ---------------------------------------- | ----------------------------------- | ---------------- | ----------------------------------------------------------- |
| **Sans** `routingCode`                   | **(aucun)** + `<!-- TODO EAS … -->` | **`false`**      | pas de `schemeID="9957">EU…` ; pas d'EndpointID sans scheme |
| **Avec** `routingCode=FR-CTC-OPENAI-001` | **`0225` = `FR-CTC-OPENAI-001`**    | `true`           | valeur = code de routage (≠ TVA OSS, ≠ 9957)                |

---

_Fin du compte-rendu. typecheck/eslint verts, 285/285 unitaires, runtime OSS « EU » vérifié (sans/avec routingCode), artefacts supprimés. Table EAS sourcée sur la liste officielle ; jamais de scheme faux ni d'EndpointID sans schemeID ; aucune migration ; `0225` = **hypothèse à valider PDP/AIFE**._
