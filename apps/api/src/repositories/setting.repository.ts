import { prisma } from '@pa-sap-bridge/database';

// Clés exposées au front-end (lecture publique après authentification)
const BASIC_KEYS = [
  'AUTO_VALIDATION_THRESHOLD',
  'DEFAULT_INTEGRATION_MODE',
  'SESSION_DURATION_MINUTES',
  'TAX_RATE_MAPPING',
  'AMOUNT_GAP_ALERT_THRESHOLD',
] as const;

// Toutes les clés éditables depuis l'interface
export const ALL_EDITABLE_KEYS = [
  'AUTO_VALIDATION_THRESHOLD',
  'DEFAULT_INTEGRATION_MODE',
  'DEFAULT_SAP_SERIES',
  'SESSION_DURATION_MINUTES',
  'TAX_RATE_MAPPING',
  'AP_TAX_ACCOUNT_MAP',
  'AP_ACCOUNT_CODE',
  'AMOUNT_GAP_ALERT_THRESHOLD',
] as const;

export type BasicSettingKey = (typeof BASIC_KEYS)[number];
export type EditableSettingKey = (typeof ALL_EDITABLE_KEYS)[number];

export interface SettingRow {
  key: string;
  value: unknown;
  updatedAt: string;
}

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

export async function findAllSettings(): Promise<SettingRow[]> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: [...ALL_EDITABLE_KEYS] } },
    orderBy: { key: 'asc' },
  });

  // Retourner toutes les clés éditables (valeur null si absente)
  return ALL_EDITABLE_KEYS.map((key) => {
    const row = rows.find((r) => r.key === key);
    return {
      key,
      value: row?.value ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? '',
    };
  });
}

export async function upsertSetting(key: EditableSettingKey, value: unknown): Promise<SettingRow> {
  const row = await prisma.setting.upsert({
    where: { key },
    create: { key, value: value as never },
    update: { value: value as never },
  });
  return { key: row.key, value: row.value, updatedAt: row.updatedAt.toISOString() };
}
