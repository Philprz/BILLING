# Addendum CR — Confirmation LIVE de la structure `DownPaymentsToDraw` (SAP B1 Service Layer)

**Date** : 2026-06-05
**Objet** : confronter la collection de tirage d'acompte posée par le correctif F3 (`CR_Correction_F3_DownPayment_2026-06-05.md`, §3) au `$metadata` **réel** du Service Layer, en **lecture seule**.
**Environnement** : serveur de production, SAP joignable (`SAP_REST_BASE_URL = https://141.94.132.62:50000/b1s/v1`, CompanyDB `SBODemoFR`, user `manager`).
**Mode SAP** : `POST /Login` (authentification) + `GET` uniquement. **Aucun** `POST` / `PATCH` / `DELETE` de document. Aucune écriture comptable. Mot de passe jamais loggé.

---

## 1. Démarche

Script de relevé dédié **lecture seule** : [scripts/inspect-downpayment-metadata.ts](scripts/inspect-downpayment-metadata.ts)
(login via les variables d'environnement de service déjà présentes, puis `GET /$metadata` + `GET` d'exemples). Lancé via `tsx`.

Étapes : Login → `GET /$metadata` (1 697 149 octets) → extraction des `ComplexType` / `Property` portant `DownPayment…ToDraw` → tentative de lecture d'exemples (`APDownPayments`, `PurchaseInvoices`).

---

## 2. Structure réelle relevée (`$metadata`, HTTP 200)

**Collections exposées sur le `Document` (donc `PurchaseInvoices`)** :

```xml
<Property Name="DownPaymentsToDraw" Type="Collection(SAPB1.DownPaymentToDraw)"/>
<Property Name="DownPaymentsToDrawDetails" Type="Collection(SAPB1.DownPaymentToDrawDetails)"/>
<Property Name="ApplyCurrentVATRatesForDownPaymentsToDraw" Type="SAPB1.BoYesNoEnum"/>
```

**`ComplexType "DownPaymentToDraw"`** (éléments de la collection) — champs :

| Champ                              | Type                                 |
| ---------------------------------- | ------------------------------------ |
| **DocEntry**                       | **Edm.Int32**                        |
| PostingDate                        | Edm.DateTime                         |
| DueDate                            | Edm.DateTime                         |
| Name                               | Edm.String                           |
| Details                            | Edm.String                           |
| **AmountToDraw**                   | **Edm.Double**                       |
| DownPaymentType                    | SAPB1.DownPaymentTypeEnum            |
| AmountToDrawFC                     | Edm.Double                           |
| AmountToDrawSC                     | Edm.Double                           |
| DocInternalID / RowNum / DocNumber | Edm.Int32                            |
| Tax / TaxFC / TaxSC                | Edm.Double                           |
| GrossAmountToDraw (+FC/SC)         | Edm.Double                           |
| IsGrossLine                        | SAPB1.BoYesNoEnum                    |
| DownPaymentsToDrawDetails          | Collection(DownPaymentToDrawDetails) |

(Le `ComplexType DownPaymentToDrawDetails` existe aussi pour la ventilation TVA détaillée par ligne — non requis pour notre cas, le tirage par `DocEntry` + `AmountToDraw` suffit.)

**Lecture d'exemples (lecture seule)** :

- `GET /PurchaseInvoices?$select=DocEntry,DocNum,DownPaymentsToDraw&$top=25` → **HTTP 200** : le nom de propriété `DownPaymentsToDraw` est **accepté tel quel** par SAP sur l'entité `PurchaseInvoices` (preuve runtime du nom exact). Aucune facture des 25 dernières ne porte de tirage non vide dans cette base de démo.
- `GET /APDownPayments?...` → HTTP 400 sur le `$select` testé + base de démo sans acompte fournisseur : non concluant et **non bloquant** (le `$metadata` et le `$select` réussi sur `PurchaseInvoices` suffisent à confirmer la structure côté facture d'achat).

---

## 3. Comparaison au code & verdict

Code posé par le correctif ([sap-invoice-builder.ts](apps/api/src/services/sap-invoice-builder.ts)) :

```ts
payload.DownPaymentsToDraw = [
  { DocEntry: downPaymentDraw.docEntry, AmountToDraw: downPaymentDraw.amountToDraw },
];
```

| Élément              | Code                    | `$metadata` LIVE               | Verdict  |
| -------------------- | ----------------------- | ------------------------------ | -------- |
| Nom de la collection | `DownPaymentsToDraw`    | `DownPaymentsToDraw` (pluriel) | ✅ exact |
| Champ identifiant    | `DocEntry` (number)     | `DocEntry : Edm.Int32`         | ✅ exact |
| Champ montant        | `AmountToDraw` (number) | `AmountToDraw : Edm.Double`    | ✅ exact |

**Verdict : structure correcte. Aucun écart, aucune correction de code nécessaire.** La mention « non confirmée » du CR principal (§3, §5) est levée.

---

## 4. Conformité lecture seule

Appels SAP effectués : **1 × `POST /Login`** (authentification, autorisée) + **`GET /$metadata`**, **`GET /PurchaseInvoices`**, **`GET /APDownPayments`**. **Aucun** `POST`/`PATCH`/`DELETE` de document, **aucune** écriture comptable. Mot de passe non loggé, non committé.

---

## 5. Vérifications

- `typecheck` : aucun changement de code applicatif (correctif déjà validé) — pas de régression introduite par cet addendum.
- Tests : inchangés, suite verte (cf. CR principal §4).
- Le script de relevé [scripts/inspect-downpayment-metadata.ts](scripts/inspect-downpayment-metadata.ts) est conservé (lecture seule, cohérent avec les autres scripts `scripts/*`), réutilisable pour reconfirmer sur un autre CompanyDB.

---

_Fin de l'addendum — confirmation LIVE en lecture seule. Structure `DownPaymentsToDraw[{ DocEntry, AmountToDraw }]` validée contre `$metadata`. Aucune écriture SAP._
