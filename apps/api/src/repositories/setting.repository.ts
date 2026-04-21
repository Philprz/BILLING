import { prisma } from '@pa-sap-bridge/database';

// Clés exposées au front-end (lecture publique après authentification)
const BASIC_KEYS = [
  'AUTO_VALIDATION_THRESHOLD',
  'DEFAULT_INTEGRATION_MODE',
  'SESSION_DURATION_MINUTES',
  'TAX_RATE_MAPPING',
  'AMOUNT_GAP_ALERT_THRESHOLD',
] as const;

export type BasicSettingKey = (typeof BASIC_KEYS)[number];

export type BasicSettings = Record<BasicSettingKey, unknown>;

export async function findBasicSettings(): Promise<BasicSettings> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: [...BASIC_KEYS] } },
  });

  const result = Object.fromEntries(BASIC_KEYS.map((k) => [k, null])) as BasicSettings;
  for (const row of rows) {
    if (BASIC_KEYS.includes(row.key as BasicSettingKey)) {
      (result as Record<string, unknown>)[row.key] = row.value;
    }
  }
  return result;
}
