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
import {
  isFinalInvoiceWithDownPayment,
  resolveDownPaymentDraw,
  isAdvanceCreditNote,
  resolveAdvanceForCreditNote,
} from './down-payment.service';
import type { Prisma } from '@pa-sap-bridge/database';

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
    | 'DOWN_PAYMENT_DRAW'
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
  // Champs F3 (déduction d'acompte) / 503 (contre-passation) — optionnels :
  // absents = ni un F3 ni un 503, comportement inchangé.
  direction?: string;
  prepaidAmount?: Prisma.Decimal | number | null;
  correctedInvoiceRef?: string | null;
  supplierPaIdentifier?: string;
  totalInclTax?: Prisma.Decimal | number;
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
          message: `Code TVA B1 manquant sur la ligne ${line.lineNo} — vérifier la règle de mappage ou la fiche fournisseur SAP.`,
        }),
      );
    }
    if (resolved.taxCode) checkedRefs.taxCodes.push(resolved.taxCode);
    if (resolved.costCenter) checkedRefs.costCenters.push(resolved.costCenter);
  }

  // ── Contrôle F3 (déduction d'acompte) — par type de document ────────────────
  // Garde-fou qui manquait : un F3 non rapprochable ne doit jamais poster à TTC
  // plein. On remonte une anomalie bloquante AVANT l'intégration pour que
  // l'utilisateur la voie dès la validation/simulation.
  if (
    invoice.direction !== undefined &&
    invoice.supplierPaIdentifier !== undefined &&
    isFinalInvoiceWithDownPayment({
      direction: invoice.direction,
      prepaidAmount: invoice.prepaidAmount ?? null,
    })
  ) {
    if (integrationMode === 'JOURNAL_ENTRY') {
      issues.push(
        buildIssue({
          severity: 'ERROR',
          code: 'DOWN_PAYMENT_DRAW',
          message:
            "Déduction d'acompte non supportée en mode écriture (JOURNAL_ENTRY) — différé. Intégrez la facture définitive en mode facture de service.",
        }),
      );
    } else {
      const draw = await resolveDownPaymentDraw({
        direction: invoice.direction,
        prepaidAmount: invoice.prepaidAmount ?? null,
        correctedInvoiceRef: invoice.correctedInvoiceRef ?? null,
        supplierPaIdentifier: invoice.supplierPaIdentifier,
      });
      if (!draw.ok) {
        issues.push(
          buildIssue({
            severity: 'ERROR',
            code: 'DOWN_PAYMENT_DRAW',
            message: draw.reason,
          }),
        );
      }
    }
  }

  // ── Contrôle 503 (contre-passation d'acompte) — par type de document ────────
  // Symétrique du contrôle F3 : un 503 non rapprochable ne doit jamais être posté
  // en avoir générique (acompte 386 non soldé). On remonte une anomalie bloquante
  // AVANT l'intégration (visible en validation/simulation). Code partagé avec F3
  // (DOWN_PAYMENT_DRAW) → déjà exclu des hardErrors génériques côté routes.
  if (
    invoice.supplierPaIdentifier !== undefined &&
    invoice.direction !== undefined &&
    isAdvanceCreditNote({ direction: invoice.direction })
  ) {
    if (integrationMode === 'JOURNAL_ENTRY') {
      issues.push(
        buildIssue({
          severity: 'ERROR',
          code: 'DOWN_PAYMENT_DRAW',
          message:
            "Contre-passation d'acompte (503) non supportée en mode écriture (JOURNAL_ENTRY) — différé. Intégrez l'avoir d'acompte en mode facture de service.",
        }),
      );
    } else {
      const reversal = await resolveAdvanceForCreditNote({
        direction: invoice.direction,
        totalInclTax: invoice.totalInclTax ?? 0,
        correctedInvoiceRef: invoice.correctedInvoiceRef ?? null,
        supplierPaIdentifier: invoice.supplierPaIdentifier,
      });
      if (!reversal.ok) {
        issues.push(
          buildIssue({
            severity: 'ERROR',
            code: 'DOWN_PAYMENT_DRAW',
            message: reversal.reason,
          }),
        );
      }
    }
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
