/**
 * Niveau payé (matrice S/B 2) — Partie A : paiement sortant + lettrage (« Payer »).
 *
 * Le paiement n'est créé que sur **action explicite utilisateur** (jamais automatique),
 * après intégration de la facture (POSTED/LINKED). Ce module :
 *   1. lit le **moyen de paiement / la banque par défaut du fournisseur** (BP) ;
 *   2. lit le **montant ouvert** du poste EN DIRECT (DocTotal − PaidToDate, jamais une
 *      valeur stockée potentiellement périmée) ;
 *   3. **bloque au moindre doute** (BP sans moyen, poste non ouvert, déjà payé, moyen
 *      non automatisable) — JAMAIS de compte inventé ;
 *   4. construit le payload `OutgoingPayments` + ligne de lettrage `PaymentInvoices`
 *      qui solde le poste.
 *
 * Sécurité argent : la création réelle (`createOutgoingPayment`) n'est déclenchée qu'en
 * politique SAP `real` ; en `simulate` on **prévisualise** sans créer ; en `disabled` on bloque.
 *
 * `resolveSupplierPaymentMeans` et `buildOutgoingPaymentPayload` sont **purs** (testables
 * sans SAP). `preparePayment` orchestre les lectures SAP + validations.
 */

import {
  fetchSupplierPaymentConfig,
  fetchPaymentMethod,
  fetchPurchaseInvoiceSettlement,
  type SapSupplierPaymentConfig,
  type SapPaymentMethod,
  type SapInvoiceSettlement,
} from './sap-sl.service';

/** Comptes de décaissement (trésorerie) configurés en environnement — JAMAIS inventés. */
export interface PaymentAccountsConfig {
  /** Compte GL de la banque de décaissement (virement) — `SAP_PAYMENT_TRANSFER_ACCOUNT`. */
  transferAccount: string | null;
  /** Compte GL de caisse (espèces) — `SAP_PAYMENT_CASH_ACCOUNT`. */
  cashAccount: string | null;
}

/** Lit la configuration des comptes de décaissement depuis l'environnement. */
export function getPaymentAccountsConfig(): PaymentAccountsConfig {
  const t = process.env.SAP_PAYMENT_TRANSFER_ACCOUNT?.trim();
  const c = process.env.SAP_PAYMENT_CASH_ACCOUNT?.trim();
  return {
    transferAccount: t && t.length > 0 ? t : null,
    cashAccount: c && c.length > 0 ? c : null,
  };
}

/** Moyen de paiement résolu, prêt pour le payload OutgoingPayments. */
export type PaymentMeansResolution =
  | { ok: true; means: 'TRANSFER' | 'CASH'; account: string; methodCode: string }
  | { ok: false; reason: string };

/**
 * Détermine le moyen de paiement à partir de la fiche fournisseur (BP) et de la
 * méthode de paiement SAP associée. Logique PURE (aucune I/O) → testable.
 *
 * Règles (toutes bloquantes, jamais de compte inventé) :
 *   - BP sans `PeymentMethodCode`                        → bloqué (moyen non configuré)
 *   - méthode SAP introuvable / non sortante            → bloqué
 *   - virement (`bopmBankTransfer`) : exige la banque par défaut du fournisseur
 *     (HouseBank) ET le compte de décaissement `SAP_PAYMENT_TRANSFER_ACCOUNT`     → sinon bloqué
 *   - espèces (`bopmCash`) : exige `SAP_PAYMENT_CASH_ACCOUNT`                       → sinon bloqué
 *   - chèque / effet (`bopmCheck`, `bopmBillOfExchange`, autre) : non automatisé   → bloqué
 */
export function resolveSupplierPaymentMeans(
  bp: SapSupplierPaymentConfig | null,
  method: SapPaymentMethod | null,
  accounts: PaymentAccountsConfig,
): PaymentMeansResolution {
  if (!bp) {
    return { ok: false, reason: 'Fournisseur introuvable dans SAP (CardCode non résolu).' };
  }
  if (!bp.paymentMethodCode) {
    return {
      ok: false,
      reason: 'Moyen de paiement du fournisseur non configuré dans SAP (PeymentMethodCode absent).',
    };
  }
  if (!method) {
    return {
      ok: false,
      reason: `Méthode de paiement « ${bp.paymentMethodCode} » introuvable dans SAP (WizardPaymentMethods).`,
    };
  }
  if (method.type && method.type !== 'boptOutgoing') {
    return {
      ok: false,
      reason: `Méthode de paiement « ${method.paymentMethodCode} » non sortante (type SAP ${method.type}).`,
    };
  }

  switch (method.paymentMeans) {
    case 'bopmBankTransfer':
      if (!bp.houseBank) {
        return {
          ok: false,
          reason:
            'Le fournisseur n’a pas de banque par défaut (HouseBank) configurée dans SAP : virement impossible.',
        };
      }
      if (!accounts.transferAccount) {
        return {
          ok: false,
          reason:
            'Compte de décaissement (virement) non configuré : définir SAP_PAYMENT_TRANSFER_ACCOUNT.',
        };
      }
      return {
        ok: true,
        means: 'TRANSFER',
        account: accounts.transferAccount,
        methodCode: method.paymentMethodCode,
      };

    case 'bopmCash':
      if (!accounts.cashAccount) {
        return {
          ok: false,
          reason: 'Compte de caisse (espèces) non configuré : définir SAP_PAYMENT_CASH_ACCOUNT.',
        };
      }
      return {
        ok: true,
        means: 'CASH',
        account: accounts.cashAccount,
        methodCode: method.paymentMethodCode,
      };

    default:
      return {
        ok: false,
        reason: `Moyen de paiement « ${method.paymentMeans ?? 'inconnu'} » non automatisé par NOVA — règlement manuel requis dans SAP.`,
      };
  }
}

/** Entrée du builder OutgoingPayments (toutes valeurs déjà résolues / lues en direct). */
export interface OutgoingPaymentInput {
  cardCode: string;
  docDate: string; // ISO yyyy-mm-dd
  docCurrency: string | null;
  docRate: number;
  means: { means: 'TRANSFER' | 'CASH'; account: string };
  /** Montant ouvert lu en direct = montant payé = montant lettré. */
  openAmount: number;
  /** Poste à solder. */
  invoiceDocEntry: number;
  /** Type SAP du document payé (BoRcptInvTypes). */
  invoiceType: 'it_PurchaseInvoice';
}

/**
 * Construit le payload `OutgoingPayments` (paiement fournisseur sortant) avec sa
 * ligne de lettrage `PaymentInvoices` qui solde le poste. Logique PURE.
 *
 * Structure confirmée LIVE (scripts/inspect-outgoingpayment-metadata.ts).
 */
export function buildOutgoingPaymentPayload(input: OutgoingPaymentInput): Record<string, unknown> {
  const means =
    input.means.means === 'TRANSFER'
      ? {
          TransferAccount: input.means.account,
          TransferSum: input.openAmount,
          TransferDate: input.docDate,
        }
      : {
          CashAccount: input.means.account,
          CashSum: input.openAmount,
        };

  return {
    DocObjectCode: 'bopot_OutgoingPayments',
    DocType: 'rSupplier',
    CardCode: input.cardCode,
    DocDate: input.docDate,
    ...(input.docCurrency ? { DocCurrency: input.docCurrency, DocRate: input.docRate } : {}),
    ...means,
    PaymentInvoices: [
      {
        DocEntry: input.invoiceDocEntry,
        InvoiceType: input.invoiceType,
        SumApplied: input.openAmount,
      },
    ],
  };
}

/** Facture côté NOVA, vue minimale nécessaire au pré-paiement. */
export interface PayableInvoice {
  id: string;
  direction: string;
  status: string;
  supplierB1Cardcode: string | null;
  sapDocEntry: number | null;
  sapPaymentDocEntry: number | null;
}

export type PreparePaymentResult =
  | {
      ok: true;
      payload: Record<string, unknown>;
      settlement: SapInvoiceSettlement;
      means: { means: 'TRANSFER' | 'CASH'; account: string; methodCode: string };
    }
  | { ok: false; httpStatus: number; reason: string };

const PAYABLE_DIRECTIONS = new Set(['INVOICE', 'SELF_BILLED', 'FACTORING']);
const INTEGRATED_STATUSES = new Set(['POSTED', 'LINKED']);

/**
 * Valide + construit le paiement d'une facture intégrée (lectures SAP en lecture seule).
 * Ne crée RIEN : renvoie le payload prêt (ou un blocage motivé). La création réelle est
 * faite par l'appelant selon `SAP_POST_POLICY`.
 *
 * Validations pré-paiement (toutes bloquantes) :
 *   - facture non déjà payée (idempotence stricte : un seul paiement par facture)
 *   - direction payable (facture d'achat — pas un acompte/avoir)
 *   - facture bien intégrée (POSTED/LINKED, sapDocEntry présent)
 *   - poste ouvert > 0 (lu en direct)
 *   - moyen de paiement du fournisseur exploitable (sinon blocage, jamais de compte inventé)
 */
export async function preparePayment(
  sapSessionCookie: string,
  invoice: PayableInvoice,
  accounts: PaymentAccountsConfig = getPaymentAccountsConfig(),
): Promise<PreparePaymentResult> {
  // 1. Idempotence : jamais deux paiements pour la même facture.
  if (invoice.sapPaymentDocEntry !== null) {
    return {
      ok: false,
      httpStatus: 409,
      reason: `Facture déjà payée dans SAP (paiement DocEntry=${invoice.sapPaymentDocEntry}).`,
    };
  }

  // 2. Direction payable uniquement (pas d'acompte / avoir).
  if (!PAYABLE_DIRECTIONS.has(invoice.direction)) {
    return {
      ok: false,
      httpStatus: 409,
      reason: `Direction « ${invoice.direction} » non payable par cette action (factures d'achat uniquement).`,
    };
  }

  // 3. Facture bien intégrée.
  if (invoice.sapDocEntry === null || !INTEGRATED_STATUSES.has(invoice.status)) {
    return {
      ok: false,
      httpStatus: 409,
      reason: `Facture non intégrée à SAP (statut ${invoice.status}) : intégration requise avant paiement.`,
    };
  }
  if (!invoice.supplierB1Cardcode) {
    return {
      ok: false,
      httpStatus: 409,
      reason: 'Fournisseur SAP (CardCode) non résolu sur la facture.',
    };
  }

  // 4. Montant ouvert lu EN DIRECT (jamais une valeur stockée).
  const settlement = await fetchPurchaseInvoiceSettlement(sapSessionCookie, invoice.sapDocEntry);
  if (!settlement) {
    return {
      ok: false,
      httpStatus: 404,
      reason: `Poste SAP DocEntry=${invoice.sapDocEntry} introuvable.`,
    };
  }
  if (!(settlement.openAmount > 0)) {
    return {
      ok: false,
      httpStatus: 409,
      reason: `Poste déjà soldé ou sans montant ouvert (ouvert = ${settlement.openAmount.toFixed(2)}).`,
    };
  }

  // 5. Moyen de paiement / banque du fournisseur (BP).
  const bp = await fetchSupplierPaymentConfig(sapSessionCookie, invoice.supplierB1Cardcode);
  const method = bp?.paymentMethodCode
    ? await fetchPaymentMethod(sapSessionCookie, bp.paymentMethodCode)
    : null;
  const meansResolution = resolveSupplierPaymentMeans(bp, method, accounts);
  if (!meansResolution.ok) {
    return { ok: false, httpStatus: 422, reason: meansResolution.reason };
  }

  // 6. Construction du payload (montant = montant ouvert ; lettrage qui solde le poste).
  const payload = buildOutgoingPaymentPayload({
    cardCode: invoice.supplierB1Cardcode,
    docDate: toISODate(new Date()), // date de paiement = aujourd'hui
    docCurrency: settlement.docCurrency,
    docRate: settlement.docRate,
    means: { means: meansResolution.means, account: meansResolution.account },
    openAmount: settlement.openAmount,
    invoiceDocEntry: settlement.docEntry,
    invoiceType: 'it_PurchaseInvoice',
  });

  return {
    ok: true,
    payload,
    settlement,
    means: {
      means: meansResolution.means,
      account: meansResolution.account,
      methodCode: meansResolution.methodCode,
    },
  };
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
