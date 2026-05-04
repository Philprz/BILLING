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
    label: 'Comptes TVA récupérable par taux',
    description:
      "Pour chaque taux de TVA (20 %, 10 %…), indique le compte comptable SAP où enregistrer la TVA récupérable sur achats. Exemple : 20 % → compte 445660. Si ce paramètre n'est pas renseigné, la TVA ne sera pas ventilée sur un compte dédié.",
    type: 'json',
  },
  AP_ACCOUNT_CODE: {
    label: 'Compte de dettes fournisseurs',
    description:
      'Numéro de compte comptable où sont enregistrées les sommes dues aux fournisseurs (le "à payer"). Utilisé automatiquement lors de la création des écritures dans SAP quand aucun compte spécifique n\'est défini pour le fournisseur concerné.',
    type: 'string',
  },
  AMOUNT_GAP_ALERT_THRESHOLD: {
    label: "Seuil d'alerte écart montant",
    description: "Écart maximum (€) entre montant PA et SAP avant déclenchement d'une alerte.",
    type: 'number',
  },
  DEFAULT_SAP_SERIES: {
    label: 'Séquence de numérotation SAP',
    description:
      "Détermine comment SAP numérote les factures qu'il reçoit de cette passerelle. Si SAP B1 utilise plusieurs séquences (ex : une pour les achats courants, une pour les imports), indiquez ici laquelle utiliser. Laissez vide pour utiliser la séquence par défaut de SAP.",
    type: 'string',
  },
  DEFAULT_ENERGY_ACCOUNT_CODE: {
    label: 'Compte énergie / électricité',
    description: 'Compte SAP B1 imputable utilisé par le fallback énergie.',
    type: 'string',
  },
  DEFAULT_MAINTENANCE_ACCOUNT_CODE: {
    label: 'Compte maintenance',
    description: 'Compte SAP B1 imputable utilisé par le fallback maintenance.',
    type: 'string',
  },
  DEFAULT_HOSTING_ACCOUNT_CODE: {
    label: 'Compte hébergement / cloud',
    description: 'Compte SAP B1 imputable utilisé par le fallback hébergement, serveur et cloud.',
    type: 'string',
  },
  DEFAULT_SUPPLIES_ACCOUNT_CODE: {
    label: 'Compte fournitures',
    description: 'Compte SAP B1 imputable utilisé par le fallback fournitures et consommables.',
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

export async function apiTestSap(): Promise<{ ok: boolean; ms: number }> {
  return apiFetch<{ ok: boolean; ms: number }>('/api/settings/test-sap', { method: 'POST' });
}
