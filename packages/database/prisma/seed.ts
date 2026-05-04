/**
 * Seed minimal technique — PA-SAP Bridge
 *
 * Insère uniquement les données de configuration de base.
 * Aucune donnée métier (factures, fournisseurs, règles de mappage).
 * Idempotent : upsert sur chaque clé de setting.
 */
import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

const prisma = new PrismaClient();

const DEFAULT_SETTINGS: Array<{ key: string; value: unknown; description: string }> = [
  {
    key: 'AUTO_VALIDATION_THRESHOLD',
    value: 90,
    description: 'Score minimum (0-100) pour validation automatique sans revue',
  },
  {
    key: 'AMOUNT_GAP_ALERT_THRESHOLD',
    value: 0.01,
    description: 'Écart maximum (€) entre total PA et total calculé avant alerte',
  },
  {
    key: 'TAX_RATE_MAPPING',
    value: { '20.00': 'S1', '10.00': 'S2', '5.50': 'S3', '2.10': 'S4' },
    description: 'Correspondance taux TVA PA → code TVA SAP B1',
  },
  {
    key: 'SAP_REST_BASE_URL',
    value: process.env.SAP_REST_BASE_URL ?? '',
    description: 'URL de base SAP Business One Service Layer',
  },
  {
    key: 'SAP_DEFAULT_COMPANY_DB',
    value: process.env.SAP_CLIENT ?? '',
    description: 'CompanyDB SAP B1 proposée par défaut à la connexion',
  },
  {
    key: 'DEFAULT_INTEGRATION_MODE',
    value: 'SERVICE_INVOICE',
    description: "Mode d'intégration SAP par défaut : SERVICE_INVOICE ou JOURNAL_ENTRY",
  },
  {
    key: 'DEFAULT_ENERGY_ACCOUNT_CODE',
    value: '',
    description: 'Compte SAP B1 par défaut pour énergie / électricité',
  },
  {
    key: 'DEFAULT_MAINTENANCE_ACCOUNT_CODE',
    value: '',
    description: 'Compte SAP B1 par défaut pour maintenance / entretien',
  },
  {
    key: 'DEFAULT_HOSTING_ACCOUNT_CODE',
    value: '',
    description: 'Compte SAP B1 par défaut pour hébergement / serveur / cloud',
  },
  {
    key: 'DEFAULT_SUPPLIES_ACCOUNT_CODE',
    value: '',
    description: 'Compte SAP B1 par défaut pour fournitures / consommables',
  },
  {
    key: 'SESSION_DURATION_MINUTES',
    value: 60,
    description: 'Durée de vie des sessions applicatives (minutes)',
  },
  {
    key: 'RULE_CLEANUP_MAX_AGE_DAYS',
    value: 180,
    description: "Âge maximum (jours) sans utilisation avant désactivation automatique d'une règle",
  },
  {
    key: 'RULE_CLEANUP_MIN_CONFIDENCE',
    value: 20,
    description: 'Score minimum en dessous duquel une règle inutilisée est désactivée',
  },
];

async function main(): Promise<void> {
  console.log('[Seed] Démarrage du seed minimal…');

  for (const setting of DEFAULT_SETTINGS) {
    await prisma.setting.upsert({
      where: { key: setting.key },
      update: {},
      create: {
        key: setting.key,
        value: setting.value as Parameters<typeof prisma.setting.create>[0]['data']['value'],
      },
    });
    console.log(`[Seed]   ✓ settings.${setting.key}`);
  }

  const settingCount = await prisma.setting.count();
  console.log(`[Seed] Terminé — ${settingCount} paramètre(s) en base.`);
}

main()
  .catch((err: unknown) => {
    console.error('[Seed] ERREUR :', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
