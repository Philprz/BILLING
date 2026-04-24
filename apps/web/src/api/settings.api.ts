import { apiFetch } from './client';

export interface SettingRow {
  key: string;
  value: unknown;
  updatedAt: string;
}

export const SETTING_META: Record<
  string,
  { label: string; description: string; type: 'number' | 'select' | 'string' | 'json' }
> = {
  AUTO_VALIDATION_THRESHOLD: {
    label: 'Seuil de confiance auto-validation',
    description: "Score de confiance minimum (0-100) pour qu'une facture soit auto-validée.",
    type: 'number',
  },
  DEFAULT_INTEGRATION_MODE: {
    label: "Mode d'intégration par défaut",
    description: "Mode proposé par défaut lors de l'intégration dans SAP B1.",
    type: 'select',
  },
  SESSION_DURATION_MINUTES: {
    label: 'Durée de session (minutes)',
    description: 'Durée de validité de la session SAP avant expiration.',
    type: 'number',
  },
  TAX_RATE_MAPPING: {
    label: 'Mapping taux TVA → code TVA SAP',
    description: 'Objet JSON : clé = taux en % (ex. "20.00"), valeur = code TVA SAP B1 (ex. "D5").',
    type: 'json',
  },
  AP_TAX_ACCOUNT_MAP: {
    label: 'Mapping taux TVA → compte TVA déductible',
    description:
      'Objet JSON : clé = taux en % (ex. "20.00"), valeur = compte comptable SAP (ex. "445660").',
    type: 'json',
  },
  AP_ACCOUNT_CODE: {
    label: 'Compte fournisseur par défaut',
    description:
      'Compte de contrepartie fournisseur (AccountCode SAP B1) utilisé pour les écritures.',
    type: 'string',
  },
  AMOUNT_GAP_ALERT_THRESHOLD: {
    label: "Seuil d'alerte écart montant",
    description: "Écart maximum (€) entre montant PA et SAP avant déclenchement d'une alerte.",
    type: 'number',
  },
  DEFAULT_SAP_SERIES: {
    label: 'Série SAP B1 par défaut',
    description: "Numéro de série (Series) utilisé par défaut lors de l'intégration SAP B1.",
    type: 'string',
  },
};

export async function apiGetSettings(): Promise<SettingRow[]> {
  return apiFetch<SettingRow[]>('/api/settings');
}

export async function apiPutSetting(key: string, value: unknown): Promise<SettingRow> {
  return apiFetch<SettingRow>(`/api/settings/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
}

export async function apiSyncSuppliers(): Promise<{ upserted: number; total: number }> {
  return apiFetch<{ upserted: number; total: number }>('/api/suppliers-cache/sync', {
    method: 'POST',
  });
}

export async function apiTestSap(): Promise<{ ok: boolean; ms: number }> {
  return apiFetch<{ ok: boolean; ms: number }>('/api/settings/test-sap', { method: 'POST' });
}
