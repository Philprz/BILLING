import {
  checkAccountCodesExist,
  checkCostCentersExist,
  checkSupplierExists,
  checkTaxCodesExist,
  SapReferenceError,
} from './sap-reference.service';
import { resolveLineForSap, type LineData } from './sap-invoice-builder';

export interface SapValidationIssue {
  severity: 'ERROR';
  code:
    | 'INVALID_STATUS'
    | 'MISSING_ATTACHMENT'
    | 'MISSING_SUPPLIER'
    | 'MISSING_LINES'
    | 'MISSING_ACCOUNT_CODE'
    | 'INVALID_SUPPLIER'
    | 'INVALID_ACCOUNT_CODE'
    | 'INVALID_TAX_CODE'
    | 'INVALID_COST_CENTER'
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

  if (invoice.status !== 'READY') {
    issues.push(
      buildIssue({
        severity: 'ERROR',
        code: 'INVALID_STATUS',
        field: 'status',
        value: invoice.status,
        message: `Statut "${invoice.status}" non autorisé pour l'intégration SAP. Statut attendu: READY.`,
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
    const [supplierExists, accountCheck, taxCheck, costCenterCheck] = await Promise.all([
      checkSupplierExists(sapSessionCookie, invoice.supplierB1Cardcode!),
      checkAccountCodesExist(sapSessionCookie, checkedRefs.accountCodes),
      checkTaxCodesExist(sapSessionCookie, checkedRefs.taxCodes),
      checkCostCentersExist(sapSessionCookie, checkedRefs.costCenters),
    ]);

    checkedRefs.accountCodes = accountCheck.checked;
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
    }

    for (const missing of accountCheck.missing) {
      issues.push(
        buildIssue({
          severity: 'ERROR',
          code: 'INVALID_ACCOUNT_CODE',
          field: 'accountCode',
          value: missing,
          message: `Compte SAP introuvable: ${missing}`,
        }),
      );
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
