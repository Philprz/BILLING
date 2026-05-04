/**
 * Résolveur centralisé du code TVA SAP B1 pour une ligne de facture.
 *
 * Ordre de priorité :
 *  1. Mapping explicite compte → TVA (settings ACCOUNT_TAX_MAPPING)
 *  2. Historique fournisseur + compte (factures POSTED/LINKED)
 *  3. Historique global compte (toutes factures POSTED/LINKED)
 *  4. Mapping taux XML → code TVA (settings TAX_RATE_MAPPING)
 *  5. Aucun match
 */

import { prisma } from '@pa-sap-bridge/database';

export type TaxCodeSource =
  | 'account_mapping'
  | 'supplier_history'
  | 'global_history'
  | 'vat_rate_mapping'
  | 'none';

export interface TaxCodeResolution {
  taxCode: string | null;
  source: TaxCodeSource;
}

interface ResolveTaxCodeParams {
  supplierCardCode: string | null;
  accountCode: string;
  taxRate: number | null;
}

export async function resolveTaxCode({
  supplierCardCode,
  accountCode,
  taxRate,
}: ResolveTaxCodeParams): Promise<TaxCodeResolution> {
  // ── Priorité 1 : mapping explicite compte → TVA ──────────────────────────
  const accountMappingSetting = await prisma.setting.findUnique({
    where: { key: 'ACCOUNT_TAX_MAPPING' },
  });
  if (
    accountMappingSetting?.value &&
    typeof accountMappingSetting.value === 'object' &&
    !Array.isArray(accountMappingSetting.value)
  ) {
    const map = accountMappingSetting.value as Record<string, string>;
    if (map[accountCode]) {
      return { taxCode: map[accountCode], source: 'account_mapping' };
    }
  }

  // ── Priorité 2 : historique fournisseur + compte ─────────────────────────
  if (supplierCardCode) {
    const supplierInvoices = await prisma.invoice.findMany({
      where: {
        supplierB1Cardcode: supplierCardCode,
        status: { in: ['POSTED', 'LINKED'] },
      },
      select: { id: true },
    });

    if (supplierInvoices.length > 0) {
      const invoiceIds = supplierInvoices.map((i) => i.id);
      const lines = await prisma.invoiceLine.findMany({
        where: {
          chosenAccountCode: accountCode,
          chosenTaxCodeB1: { not: null },
          invoiceId: { in: invoiceIds },
        },
        select: { chosenTaxCodeB1: true },
      });

      const freq = countFrequency(lines.map((l) => l.chosenTaxCodeB1!));
      if (freq.size > 0) {
        return { taxCode: mostFrequent(freq), source: 'supplier_history' };
      }
    }
  }

  // ── Priorité 3 : historique global du compte ─────────────────────────────
  const globalLines = await prisma.invoiceLine.findMany({
    where: {
      chosenAccountCode: accountCode,
      chosenTaxCodeB1: { not: null },
      invoice: { status: { in: ['POSTED', 'LINKED'] } },
    },
    select: { chosenTaxCodeB1: true },
    take: 200,
  });

  if (globalLines.length > 0) {
    const freq = countFrequency(globalLines.map((l) => l.chosenTaxCodeB1!));
    if (freq.size > 0) {
      return { taxCode: mostFrequent(freq), source: 'global_history' };
    }
  }

  // ── Priorité 4 : mapping taux XML → code TVA ─────────────────────────────
  if (taxRate !== null) {
    const taxRateSetting = await prisma.setting.findUnique({
      where: { key: 'TAX_RATE_MAPPING' },
    });
    if (
      taxRateSetting?.value &&
      typeof taxRateSetting.value === 'object' &&
      !Array.isArray(taxRateSetting.value)
    ) {
      const map = taxRateSetting.value as Record<string, string>;
      const key = taxRate.toFixed(2);
      if (map[key]) {
        return { taxCode: map[key], source: 'vat_rate_mapping' };
      }
    }
  }

  return { taxCode: null, source: 'none' };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function countFrequency(values: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const v of values) {
    map.set(v, (map.get(v) ?? 0) + 1);
  }
  return map;
}

function mostFrequent(freq: Map<string, number>): string {
  return [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
