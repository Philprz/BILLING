# Tests et couverture

## Suites en place

- `tests/unit`
- `tests/integration`
- `tests/e2e`

## Ce qui est réellement testé

### Unitaire

- politique de retry PA
- payload de retour PA
- génération des résumés d’audit
- construction des payloads SAP pour facture de service et écriture comptable

### Intégration API

- contrôle d’accès sur le détail facture
- lecture détail facture + audit de consultation
- rejet manuel + persistance du motif + audit
- validation simulée + audit
- envoi manuel du statut PA simulé + audit

### Smoke E2E local

- facture `POSTED` en attente de retour PA
- échec simulé d’écriture du statut
- retries worker
- succès au cycle suivant
- lecture du journal d’audit correspondant

## Dernière mesure exécutée

Commande exécutée :

```powershell
npm run test:coverage
```

Résultat mesuré sur cette exécution :

- Tests : `13 passed`
- Fichiers de test : `5 passed`
- Couverture globale `Statements / Lines` : `45.4 %`
- Couverture globale `Branches` : `52.33 %`
- Couverture globale `Functions` : `67.94 %`

Points couverts de manière notable :

- `apps/api/src/routes/audit.ts`
- `apps/api/src/routes/invoices.ts` partiellement sur les flux locaux testés
- `apps/api/src/services/sap-invoice-builder.ts`
- `apps/worker/src/jobs/pa-status-job.ts`
- `packages/database/src/pa-status.ts`
- `packages/database/src/audit.ts` partiellement

## Zones non couvertes

- login SAP réel contre un Service Layer réel
- appels SAP réels `uploadAttachment`, `createPurchaseDoc`, `createJournalEntry`
- automatisation navigateur du front
- connecteurs PA réels API/SFTP
- scénarios de volumétrie et de concurrence
- restauration après panne machine / service

## Lecture honnête

- La couverture n’est pas exhaustive.
- Les tests se concentrent sur les flux locaux les plus critiques et répétables.
- Les flux dépendants d’infrastructures métier externes restent principalement validés par simulation.
