# Compte-rendu — Correction 384 : clôture du cycle PA de l'originale remplacée par une rectificative

**Date** : 2026-06-05
**Périmètre** : audit 2026-06-05 §2.10 / §4.5 — quand un **384 (rectificative)** supersède une facture originale en litige (`handleCorrectiveInvoice`, `apps/worker/src/ingestion/db-writer.ts`), l'originale passe en `SUPERSEDED` **mais aucun statut n'est renvoyé à la PA**. Elle reste perçue **« en litige » (IN_DISPUTE)** côté plateforme indéfiniment ; le cycle de vie réforme n'est jamais soldé.
**Décision verrouillée** : l'originale remplacée renvoie à la PA l'issue **`REJECTED`** + motif **« Remplacée par rectificative {n° du 384} »**. **Pas de nouvelle valeur d'issue.**
**Mode** : exécution autonome, aucune question posée. Aucune écriture SAP. **Aucune migration** (voir §2.3).

---

## 1. Diagnostic confirmé (lecture code)

| Maillon                                    | État avant                                                                          | Conséquence                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `handleCorrectiveInvoice` (`db-writer.ts`) | pose `status=SUPERSEDED` + `statusReason` mais **ne déclenche aucune livraison PA** | l'événement de supersession n'est jamais émis                               |
| `runPaStatusJob` (`pa-status-job.ts`)      | sélectionne uniquement `status ∈ {POSTED, REJECTED}`                                | `SUPERSEDED` **jamais ramassé** par le job                                  |
| originale déjà mise en litige              | `paStatusSentAt` **renseigné** (IN_DISPUTE envoyé via `routes/invoices.ts`)         | même resélectionnée, l'idempotence (`paStatusSentAt != null`) la bloquerait |
| `buildPaStatusPayload` (`pa-status.ts`)    | dérive déjà tout statut hors `POSTED/LINKED/DISPUTED` → **`REJECTED`**              | ✅ **aucune** modif nécessaire : `SUPERSEDED → REJECTED` est déjà correct   |

**Atout exploité** : la dérivation `REJECTED` existe déjà, motif = `statusReason`. Il suffit donc de **(a) réarmer l'envoi** et **(b) rendre `SUPERSEDED` éligible au job**. Aucun `outcomeOverride`, aucune nouvelle issue.

---

## 2. Implémentation (fichier par fichier)

### 2.1 `apps/api/.../db-writer.ts` — `handleCorrectiveInvoice` (réarmement)

Dans la transaction de supersession, ajout de **`paStatusSentAt: null`** à l'`update` de l'originale (en plus de `status` + `statusReason` déjà posés) :

```ts
await tx.invoice.update({
  where: { id: original.id },
  data: {
    status: 'SUPERSEDED',
    statusReason: `Remplacée par rectificative ${parsed.docNumberPa}`,
    paStatusSentAt: null, // ← réarme la livraison PA (nouvel événement de cycle)
  },
});
```

- Le `statusReason` était **déjà** « Remplacée par rectificative {docNumberPa du 384} » → conforme à la décision verrouillée, libellé inchangé.
- La remise à `null` permet au job de **resélectionner** l'originale malgré l'IN_DISPUTE déjà envoyé.

### 2.2 `apps/worker/src/jobs/pa-status-job.ts` — éligibilité du statut

```ts
status: { in: ['POSTED', 'REJECTED', 'SUPERSEDED'] },
```

Le job livre l'issue dérivée `REJECTED` + motif, **avec le même retry exponentiel** que pour un rejet (aucune branche spécifique : la dérivation fait tout le travail).

### 2.3 `buildPaStatusPayload` — **inchangé**

`SUPERSEDED` n'étant ni `POSTED/LINKED` ni `DISPUTED`, il retombe sur `REJECTED`, `reason = statusReason`. Confirmé par test (§3).

### 2.4 Pas de migration — justification

Le **compteur de retry n'est PAS un champ de l'`Invoice`** : le job dérive `failCount` en comptant les `audit_log` `SEND_STATUS_PA` / `outcome=ERROR` de l'entité (`pa-status-job.ts:50`). Le seul « suivi d'envoi » sur l'invoice est `paStatusSentAt`, déjà remis à `null`. **Aucun champ `failureCount/nextRetryAt/lastFailureAt` n'existe** → rien d'autre à réinitialiser, **aucune migration**.

---

## 3. Vérification (checks verts)

### 3.1 Tests ajoutés

- **`tests/unit/pa-status.test.ts`** : `buildPaStatusPayload` sur `status='SUPERSEDED'` → `outcome='REJECTED'`, `reason='Remplacée par rectificative …'` (motif porté par `statusReason`, pas `litigeMotif`).
- **`tests/unit/db-writer-corrective.test.ts`** : après supersession, l'`update` de l'originale porte `status='SUPERSEDED'` + `statusReason` attendu **+ `paStatusSentAt: null`** (réarmement). Le 384 reste `NEW` + `replaces` (inchangé).
- **`tests/unit/pa-status-job.test.ts`** (nouveau fichier) :
  - le `where` du job inclut bien `status ∈ {POSTED, REJECTED, SUPERSEDED}` et `paStatusSentAt: null` ;
  - une originale `SUPERSEDED` non livrée est **livrée** (issue `REJECTED`, motif transmis à `deliverPaStatus`) puis **`paStatusSentAt` posé exactement une fois** → pas de second envoi (idempotence).

### 3.2 Non-régression

- Cas 384 sans originale DISPUTED, idempotence paMessageId/SHA-256, dédoublon métier 380 : **inchangés** (tests existants verts).
- Le 384 lui-même suit son cycle normal (`NEW → …`), non touché.

### 3.3 Résultats

| Check                              | Résultat                                                |
| ---------------------------------- | ------------------------------------------------------- |
| `vitest run tests/unit`            | **327 tests passés** (324 → 327, **aucune régression**) |
| `npm run typecheck` (5 workspaces) | **clean**                                               |
| `eslint` (fichiers modifiés)       | **clean**                                               |

---

## 4. Comportement résultant (payload PA émis pour l'originale)

```
outcome  : REJECTED
reason   : « Remplacée par rectificative {docNumberPa du 384} »
sapDocEntry / sapDocNum : null (l'originale n'a pas été intégrée à SAP)
```

Émis par le job via l'infra de livraison + retry existante (canal API/SFTP/local selon `paSource`). Après succès, `paStatusSentAt` est posé → l'originale sort de la sélection du job (pas de double envoi).

### Idempotence — chaîne complète

1. Mise en litige → `IN_DISPUTE` envoyé, `paStatusSentAt` posé.
2. Ingestion 384 → originale `SUPERSEDED`, `paStatusSentAt` **remis à null** (réarmement).
3. Job → livre `REJECTED`, repose `paStatusSentAt`.
4. Runs suivants → `paStatusSentAt != null` ⇒ **non resélectionnée**. ✅

---

## 5. Choix & écarts (exécution autonome)

- **Voie « job » retenue** (vs envoi immédiat à la supersession dans `db-writer`) : robustesse via le retry exponentiel existant, conformément à la préférence du brief. Le `db-writer` (worker d'ingestion) reste découplé de la livraison réseau ; un échec de livraison ne compromet pas la supersession.
- **Aucun `outcomeOverride`** : la dérivation native `SUPERSEDED → REJECTED` suffit (contrairement au `RECEIVED` de la levée de litige, qui lui exige un override).

---

## 6. Limites / différé

- **Carryover du compteur de retry** : `failCount` agrège **tous** les `audit_log` `SEND_STATUS_PA/ERROR` de l'entité, y compris d'éventuels échecs de l'envoi `IN_DISPUTE` antérieur. En pratique le happy-path IN_DISPUTE réussit (≤ quelques erreurs) et le réarmement ne purge pas l'audit (trace conservée). Si un jour le budget retry devait être strictement per-événement, il faudrait borner la requête `failures` par horodatage (≥ supersession) — **hors périmètre**, signalé.
- **Runtime de bout en bout** (ingestion → litige → 384 → `REJECTED` livré) : non exécuté en autonomie (pas d'env de test PA mobilisé ici) ; couvert par les tests unitaires (job + payload + db-writer). À rejouer sur env de test si souhaité.
- **Hors périmètre** (inchangés) : lots 393 / `JOURNAL_ENTRY` / niveau payé S/B 2 ; aucune nouvelle valeur d'issue PA ; cycle des autres statuts intact.

---

_Fin du CR — clôture PA de l'originale superseédée par une 384. Issue `REJECTED` réutilisée (dérivée du statut, pas de nouvelle valeur), motif déjà posé ; réarmement `paStatusSentAt=null` + `SUPERSEDED` éligible au job ; idempotence préservée ; aucune migration. Checks verts (327 tests, typecheck, eslint)._
