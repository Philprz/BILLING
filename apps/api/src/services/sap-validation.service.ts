import {
  checkCostCentersExist,
  checkSupplierExists,
  fetchSupplierFiscalFields,
  getSupplierLegalIdentifier,
  getSupplierVatIdentifier,
  SapReferenceError,
} from './sap-reference.service';
import { validateVatCode } from './sap-vat-code.service';
import { getCachedAccountsByCode, findClosestAccounts } from './chart-of-accounts-cache.service';
import { resolveLineForSap, type LineData } from './sap-invoice-builder';

export interface SapValidationIssue {
  severity: 'ERROR' | 'WARNING';
  code:
    | 'INVALID_STATUS'
    | 'MISSING_ATTACHMENT'
    | 'MISSING_SUPPLIER'
    | 'MISSING_LINES'
    | 'MISSING_ACCOUNT_CODE'
    | 'MISSING_TAX_CODE'
    | 'INVALID_SUPPLIER'
    | 'INVALID_ACCOUNT_CODE'
    | 'INVALID_TAX_CODE'
    | 'INVALID_COST_CENTER'
    | 'MISSING_LEGAL_IDENTIFIER'
    | 'MISSING_VAT_IDENTIFIER'
    | 'SAP_REFERENCE_ERROR';
  message: string;
  lineNo?: number;
  field?: 'status' | 'supplier' | 'files' | 'lines' | 'accountCode' | 'taxCode' | 'costCenter';
  value?: string | null;
}

export interface SapValidationRefs {
  supplierCardCode: string | null;
  accountCodes: string[];
  taxCodes: string[];
  costCenters: string[];
}

export interface SapValidationReport {
  ok: boolean;
  integrationMode: 'SERVICE_INVOICE' | 'JOURNAL_ENTRY';
  validatedAt: string;
  checkedRefs: SapValidationRefs;
  issues: SapValidationIssue[];
}

export interface InvoiceForSapValidation {
  status: string;
  supplierB1Cardcode: string | null;
  files: Array<{ id: string }>;
  lines: LineData[];
}

function buildIssue(issue: SapValidationIssue): SapValidationIssue {
  return issue;
}

export async function validateInvoiceForSapPost(
  invoice: InvoiceForSapValidation,
  integrationMode: 'SERVICE_INVOICE' | 'JOURNAL_ENTRY',
  sapSessionCookie: string,
  taxRateMap: Record<string, string>,
): Promise<SapValidationReport> {
  const issues: SapValidationIssue[] = [];
  const checkedRefs: SapValidationRefs = {
    supplierCardCode: invoice.supplierB1Cardcode,
    accountCodes: [],
    taxCodes: [],
    costCenters: [],
  };

  if (invoice.status !== 'READY' && invoice.status !== 'TO_REVIEW') {
    issues.push(
      buildIssue({
        severity: 'ERROR',
        code: 'INVALID_STATUS',
        field: 'status',
        value: invoice.status,
        message: `Statut "${invoice.status}" non autorisé pour l'intégration SAP. Statuts acceptés : READY, TO_REVIEW.`,
      }),
    );
  }

  if (invoice.files.length === 0) {
    issues.push(
      buildIssue({
        severity: 'ERROR',
        code: 'MISSING_ATTACHMENT',
        field: 'files',
        message: 'Aucune pièce jointe locale disponible pour la facture.',
      }),
    );
  }

  if (!invoice.supplierB1Cardcode) {
    issues.push(
      buildIssue({
        severity: 'ERROR',
        code: 'MISSING_SUPPLIER',
        field: 'supplier',
        message: 'Fournisseur SAP B1 non résolu (CardCode manquant).',
      }),
    );
  }

  if (invoice.lines.length === 0) {
    issues.push(
      buildIssue({
        severity: 'ERROR',
        code: 'MISSING_LINES',
        field: 'lines',
        message: 'Aucune ligne de facture structurée.',
      }),
    );
  }

  for (const line of invoice.lines) {
    const resolved = resolveLineForSap(line, taxRateMap);
    if (!resolved.accountCode) {
      issues.push(
        buildIssue({
          severity: 'ERROR',
          code: 'MISSING_ACCOUNT_CODE',
          field: 'accountCode',
          lineNo: line.lineNo,
          message: `Compte comptable manquant sur la ligne ${line.lineNo}.`,
        }),
      );
      continue;
    }

    checkedRefs.accountCodes.push(resolved.accountCode);
    if (!resolved.taxCode) {
      issues.push(
        buildIssue({
          severity: 'ERROR',
          code: 'MISSING_TAX_CODE',
          field: 'taxCode',
          lineNo: line.lineNo,
          message: `Code TVA SAP B1 manquant sur la ligne ${line.lineNo}.`,
        }),
      );
    }
    if (resolved.taxCode) checkedRefs.taxCodes.push(resolved.taxCode);
    if (resolved.costCenter) checkedRefs.costCenters.push(resolved.costCenter);
  }

  if (issues.length > 0) {
    return {
      ok: false,
      integrationMode,
      validatedAt: new Date().toISOString(),
      checkedRefs: {
        supplierCardCode: checkedRefs.supplierCardCode,
        accountCodes: [...new Set(checkedRefs.accountCodes)],
        taxCodes: [...new Set(checkedRefs.taxCodes)],
        costCenters: [...new Set(checkedRefs.costCenters)],
      },
      issues,
    };
  }

  try {
    // Le cache de plan comptable n'est utile que s'il a été synchronisé.
    // Si la table n'existe pas encore (DB non migrée), on ignore silencieusement
    // la vérification d'existence pour ne pas bloquer les environnements non configurés.
    let accountCache: Awaited<ReturnType<typeof getCachedAccountsByCode>> | null = null;
    try {
      accountCache = await getCachedAccountsByCode(checkedRefs.accountCodes);
    } catch {
      // Table absente (migration en cours ou environnement sans cache) → skip
    }

    for (const line of invoice.lines) {
      const resolved = resolveLineForSap(line, taxRateMap);
      if (!resolved.accountCode) continue;
      if (accountCache === null) continue; // cache inaccessible → pas de vérification
      const account = accountCache.get(resolved.accountCode);
      const invalid = !account || !account.activeAccount || !account.postable;
      if (invalid) {
        const closest = await findClosestAccounts(resolved.accountCode, 3);
        const suggestion =
          closest.length > 0
            ? `\n→ Compte le plus proche : ${closest.map((a) => `${a.acctCode} — ${a.acctName}`).join(' | ')}`
            : '';
        issues.push(
          buildIssue({
            severity: 'ERROR',
            code: 'INVALID_ACCOUNT_CODE',
            field: 'accountCode',
            lineNo: line.lineNo,
            value: resolved.accountCode,
            message:
              `La ligne ${line.lineNo} utilise le compte ${resolved.accountCode}, qui n'existe pas ou n'est pas imputable dans SAP B1.` +
              suggestion,
          }),
        );
      }
    }

    const uniqueTaxCodes = [...new Set(checkedRefs.taxCodes.filter((c) => c.trim().length > 0))];
    const taxValidations = await Promise.all(uniqueTaxCodes.map((c) => validateVatCode(c)));
    const taxCheck = {
      missing: uniqueTaxCodes.filter((_, i) => !taxValidations[i].ok),
      checked: uniqueTaxCodes,
    };

    const [supplierExists, supplierFiscalFields, costCenterCheck] = await Promise.all([
      checkSupplierExists(sapSessionCookie, invoice.supplierB1Cardcode!),
      fetchSupplierFiscalFields(sapSessionCookie, invoice.supplierB1Cardcode!),
      checkCostCentersExist(sapSessionCookie, checkedRefs.costCenters),
    ]);

    checkedRefs.accountCodes = [...new Set(checkedRefs.accountCodes)];
    checkedRefs.taxCodes = taxCheck.checked;
    checkedRefs.costCenters = costCenterCheck.checked;

    if (!supplierExists) {
      issues.push(
        buildIssue({
          severity: 'ERROR',
          code: 'INVALID_SUPPLIER',
          field: 'supplier',
          value: invoice.supplierB1Cardcode,
          message: `CardCode SAP introuvable: ${invoice.supplierB1Cardcode}`,
        }),
      );
    } else if (supplierFiscalFields !== undefined) {
      // supplierFiscalFields === undefined → SAP injoignable → vérification impossible, on ne bloque pas
      // supplierFiscalFields !== undefined → BP trouvé, on contrôle les identifiants

      const legalId = getSupplierLegalIdentifier(supplierFiscalFields);
      if (legalId === null) {
        issues.push(
          buildIssue({
            severity: 'WARNING',
            code: 'MISSING_LEGAL_IDENTIFIER',
            field: 'supplier',
            value: invoice.supplierB1Cardcode,
            message: `Le fournisseur SAP B1 n'a pas de SIRET/SIREN renseigné dans le champ d'identification entreprise. Ouvrez la fiche Business Partner dans SAP B1 et renseignez le champ "N° identification entreprise" (SIRET 14 chiffres ou SIREN 9 chiffres).`,
          }),
        );
      }

      const vatId = getSupplierVatIdentifier(supplierFiscalFields);
      if (vatId === null) {
        issues.push(
          buildIssue({
            severity: 'WARNING',
            code: 'MISSING_VAT_IDENTIFIER',
            field: 'supplier',
            value: invoice.supplierB1Cardcode,
            message: `Le fournisseur SAP B1 n'a pas de numéro de TVA intracommunautaire renseigné (champ FederalTaxID / TVA intracommunautaire, ex: FR12345678901).`,
          }),
        );
      }
    }

    for (const missing of taxCheck.missing) {
      issues.push(
        buildIssue({
          severity: 'ERROR',
          code: 'INVALID_TAX_CODE',
          field: 'taxCode',
          value: missing,
          message: `Code TVA SAP introuvable: ${missing}`,
        }),
      );
    }

    for (const missing of costCenterCheck.missing) {
      issues.push(
        buildIssue({
          severity: 'ERROR',
          code: 'INVALID_COST_CENTER',
          field: 'costCenter',
          value: missing,
          message: `Centre de coût SAP introuvable: ${missing}`,
        }),
      );
    }
  } catch (err) {
    const message =
      err instanceof SapReferenceError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);

    issues.push(
      buildIssue({
        severity: 'ERROR',
        code: 'SAP_REFERENCE_ERROR',
        message,
      }),
    );
  }

  return {
    ok: issues.length === 0,
    integrationMode,
    validatedAt: new Date().toISOString(),
    checkedRefs,
    issues,
  };
}
