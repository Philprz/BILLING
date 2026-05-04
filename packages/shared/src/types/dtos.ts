// ---------------------------------------------------------------------------
// DTOs de l'API PA-SAP Bridge — contrat front ↔ back
// ---------------------------------------------------------------------------

export type InvoiceStatus =
  | 'NEW'
  | 'TO_REVIEW'
  | 'READY'
  | 'POSTED'
  | 'LINKED'
  | 'REJECTED'
  | 'ERROR';
export type InvoiceDirection = 'INVOICE' | 'CREDIT_NOTE';
export type FileKind = 'PDF' | 'XML' | 'ATTACHMENT';

export interface InvoiceSummary {
  id: string;
  paMessageId: string;
  paSource: string;
  direction: InvoiceDirection;
  format: string;
  receivedAt: string;
  supplierPaIdentifier: string;
  supplierNameRaw: string;
  supplierB1Cardcode: string | null;
  supplierMatchConfidence: number;
  supplierMatchReason: string | null;
  docNumberPa: string;
  docDate: string;
  dueDate: string | null;
  currency: string;
  totalExclTax: number;
  totalTax: number;
  totalInclTax: number;
  status: InvoiceStatus;
  statusReason: string | null;
  integrationMode: string | null;
  sapDocEntry: number | null;
  sapDocNum: number | null;
  sapAttachmentEntry: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceLine {
  id: string;
  lineNo: number;
  description: string;
  quantity: number;
  unitPrice: number;
  amountExclTax: number;
  taxCode: string | null;
  taxRate: number | null;
  taxAmount: number;
  amountInclTax: number;
  suggestedAccountCode: string | null;
  suggestedAccountConfidence: number;
  suggestedCostCenter: string | null;
  suggestedTaxCodeB1: string | null;
  suggestionSource: string | null;
  chosenAccountCode: string | null;
  chosenCostCenter: string | null;
  chosenTaxCodeB1: string | null;
  taxCodeLockedByUser: boolean;
}

export interface InvoiceFile {
  id: string;
  kind: FileKind;
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface SupplierExtracted {
  endpointId?: string | null;
  partyIdentificationIds?: string[];
  taxCompanyIds?: string[];
  legalCompanyId?: string | null;
  siren: string | null;
  siret: string | null;
  vatNumber: string | null;
  fullAddress?: string | null;
  street: string | null;
  street2: string | null;
  city: string | null;
  postalCode: string | null;
  country: string | null;
  email: string | null;
  phone: string | null;
}

export interface InvoiceDetail extends InvoiceSummary {
  lines: InvoiceLine[];
  files: InvoiceFile[];
  paStatusSentAt?: string | null;
  supplierInCache: boolean | null;
  supplierExtracted: SupplierExtracted | null;
}

export type AuditAction =
  | 'LOGIN'
  | 'LOGOUT'
  | 'FETCH_PA'
  | 'VIEW_INVOICE'
  | 'EDIT_MAPPING'
  | 'APPROVE'
  | 'REJECT'
  | 'POST_SAP'
  | 'LINK_SAP'
  | 'SEND_STATUS_PA'
  | 'SYSTEM_ERROR'
  | 'CONFIG_CHANGE'
  | 'CREATE_SUPPLIER'
  | 'SYNC_SUPPLIERS';

export type AuditOutcome = 'OK' | 'ERROR';

export interface AuditEntry {
  id: string;
  occurredAt: string;
  sapUser: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string | null;
  outcome: AuditOutcome;
  errorMessage: string | null;
  payloadBefore: unknown;
  payloadAfter: unknown;
  summary: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface AuthUser {
  user: string;
  companyDb: string;
  expiresAt: string;
}

export interface BasicSettings {
  AUTO_VALIDATION_THRESHOLD: number;
  DEFAULT_INTEGRATION_MODE: string;
  SESSION_DURATION_MINUTES: number;
  TAX_RATE_MAPPING: Record<string, string>;
  AMOUNT_GAP_ALERT_THRESHOLD: number;
}

export interface SapExecutionPolicy {
  validationMode: 'live';
  attachmentPolicy: 'strict' | 'warn' | 'skip';
  postPolicy: 'real' | 'simulate' | 'disabled';
  requestSimulate: boolean;
  effectivePostPolicy: 'real' | 'simulate' | 'disabled';
}

export interface SapValidationIssue {
  severity: 'ERROR' | 'WARNING';
  code: string;
  message: string;
  lineNo?: number;
  field?: string;
  value?: string | null;
}

export interface SapPurchaseInvoiceRef {
  docEntry: number;
  docNum: number;
  cardCode: string;
  cardName: string;
  numAtCard: string;
  docDate: string;
  docTotal: number;
  attachmentEntry: number | null;
}

export interface LinkSapResult {
  status: 'LINKED';
  sapDocEntry: number;
  sapDocNum: number;
  attachmentEntry: number | null;
}

export interface LinkSapConflict {
  candidates: SapPurchaseInvoiceRef[];
}

export interface SapValidationReport {
  ok: boolean;
  integrationMode: 'SERVICE_INVOICE' | 'JOURNAL_ENTRY';
  validatedAt: string;
  checkedRefs: {
    supplierCardCode: string | null;
    accountCodes: string[];
    taxCodes: string[];
    costCenters: string[];
  };
  issues: SapValidationIssue[];
}
