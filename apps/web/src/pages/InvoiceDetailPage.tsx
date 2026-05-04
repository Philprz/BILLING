import { useEffect, useState, useCallback } from 'react';

const PA_SOURCE_LABELS: Record<string, string> = {
  MANUAL_UPLOAD: 'Téléchargée',
  LOCAL_DEV: 'Direct-PA',
  SEED_TEST: 'Seed-test',
};
const paSourceLabel = (source: string) => PA_SOURCE_LABELS[source] ?? source;
import { XmlViewer } from '../components/ui/XmlViewer';
import { PdfViewer } from '../components/ui/PdfViewer';
import { AccountSearch } from '../components/ui/AccountSearch';
import { useParams, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Clock,
  FileText,
  Tag,
  AlertCircle,
  Paperclip,
  Send,
  Ban,
  ScrollText,
  Pencil,
  X,
  Check,
  BookmarkPlus,
  RefreshCw,
  ExternalLink,
  Save,
  HelpCircle,
  Link2,
} from 'lucide-react';
import {
  apiGetInvoice,
  apiPostInvoice,
  apiRejectInvoice,
  apiSendStatus,
  apiUpdateSupplier,
  apiUpdateLine,
  apiResolveTaxCode,
  apiResetInvoice,
  apiReEnrichInvoice,
  apiReParseLinesInvoice,
  apiSaveDraft,
  apiLinkSap,
  apiPushSupplierFiscal,
} from '../api/invoices.api';
import { apiGetSuppliers, apiCreateSupplierInSap, type SupplierCache } from '../api/suppliers.api';
import { apiSyncSapChartOfAccounts } from '../api/sap.api';
import { apiCreateMappingRule } from '../api/mapping-rules.api';
import { apiGetAudit } from '../api/audit.api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { StatusBadge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { InvoiceDetailSkeleton } from '../components/ui/skeleton';
import { toast } from '../lib/toast';
import { formatAmount, formatDate } from '../lib/utils';
import type {
  InvoiceDetail,
  InvoiceLine,
  AuditEntry,
  AuditAction,
  SapPurchaseInvoiceRef,
} from '../api/types';

type IntegrationMode = 'SERVICE_INVOICE' | 'JOURNAL_ENTRY';
const TERMINAL_STATUSES_UI = new Set(['POSTED', 'LINKED', 'REJECTED']);

const ACTION_LABELS: Record<AuditAction, string> = {
  LOGIN: 'Connexion',
  LOGOUT: 'Déconnexion',
  FETCH_PA: 'Ingestion PA',
  VIEW_INVOICE: 'Consultation',
  EDIT_MAPPING: 'Modif. règle',
  APPROVE: 'Approbation',
  REJECT: 'Rejet',
  POST_SAP: 'Intégration SAP',
  LINK_SAP: 'Rattachement SAP',
  SEND_STATUS_PA: 'Retour statut PA',
  SYSTEM_ERROR: 'Erreur système',
  CONFIG_CHANGE: 'Config.',
  CREATE_SUPPLIER: 'Création fournisseur',
  SYNC_SUPPLIERS: 'Sync fournisseurs',
};

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/70 py-3 last:border-0">
      <span className="flex-shrink-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      <span className="text-right text-sm font-medium text-foreground">{value ?? '—'}</span>
    </div>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const color = value >= 80 ? 'bg-success' : value >= 50 ? 'bg-warning' : 'bg-destructive';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted/70">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className="w-8 text-right text-xs text-muted-foreground">{value}%</span>
    </div>
  );
}

interface EditingLine {
  chosenAccountCode: string;
  chosenCostCenter: string;
  chosenTaxCodeB1: string;
  taxCodeLockedByUser: boolean;
  taxCodeSource: string | null;
}

interface RuleModalState {
  lineId: string;
  lineNo: number;
  scope: 'GLOBAL' | 'SUPPLIER';
  keyword: string;
  accountCode: string;
  costCenter: string;
  taxCodeB1: string;
  taxRate: number | null;
}

// ── Zod schemas ──────────────────────────────────────────────────────────────

const supplierSchema = z.object({
  cardCode: z.string().min(1, 'CardCode requis').max(15, 'Max 15 caractères'),
  cardName: z.string().min(1, 'Nom requis'),
  siren: z.string().optional(),
  siret: z.string().optional(),
  vatRegNum: z.string().optional(),
  street: z.string().optional(),
  street2: z.string().optional(),
  city: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
});
type SupplierForm = z.infer<typeof supplierSchema>;

function nextSupplierCardCode(suppliers: SupplierCache[]): string {
  const max = suppliers.reduce((current, supplier) => {
    const match = /^F(\d+)$/i.exec(supplier.cardcode);
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return `F${String(max + 1).padStart(5, '0')}`;
}

function buildSupplierPrefill(invoice: InvoiceDetail, cardCode: string): Partial<SupplierForm> {
  const extracted = invoice.supplierExtracted;
  return {
    cardCode,
    cardName: invoice.supplierNameRaw || '',
    siren: extracted?.siren ?? '',
    siret: extracted?.siret ?? '',
    vatRegNum: extracted?.vatNumber ?? '',
    street: extracted?.street ?? '',
    street2: extracted?.street2 ?? '',
    postalCode: extracted?.postalCode ?? '',
    city: extracted?.city ?? '',
    country: extracted?.country ?? '',
    email: extracted?.email ?? '',
    phone: extracted?.phone ?? '',
  };
}

const ruleSchema = z.object({
  scope: z.enum(['GLOBAL', 'SUPPLIER']),
  keyword: z.string(),
  accountCode: z.string().min(1, 'Compte comptable requis'),
  costCenter: z.string(),
  taxCodeB1: z.string(),
});
type RuleForm = z.infer<typeof ruleSchema>;

// ── CreateSupplierModal ───────────────────────────────────────────────────────

interface CreateSupplierModalProps {
  initialValues?: Partial<SupplierForm>;
  onConfirm: (data: SupplierForm) => Promise<void>;
  onClose: () => void;
}

function FieldRow({
  label,
  required,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs text-muted-foreground font-medium block mb-1">
        {label}
        {required && ' *'}
      </label>
      {children}
      {error && <p className="text-xs text-destructive mt-0.5">{error}</p>}
    </div>
  );
}

function CreateSupplierModal({ initialValues, onConfirm, onClose }: CreateSupplierModalProps) {
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SupplierForm>({
    resolver: zodResolver(supplierSchema),
    defaultValues: {
      cardCode: initialValues?.cardCode ?? '',
      cardName: initialValues?.cardName ?? '',
      siren: initialValues?.siren ?? '',
      siret: initialValues?.siret ?? '',
      vatRegNum: initialValues?.vatRegNum ?? '',
      street: initialValues?.street ?? '',
      street2: initialValues?.street2 ?? '',
      city: initialValues?.city ?? '',
      postalCode: initialValues?.postalCode ?? '',
      country: initialValues?.country ?? '',
      email: initialValues?.email ?? '',
      phone: initialValues?.phone ?? '',
    },
  });

  async function onSubmit(data: SupplierForm) {
    setServerError(null);
    try {
      await onConfirm(data);
    } catch (err) {
      setServerError(
        err instanceof Error ? err.message : 'Erreur lors de la création du fournisseur',
      );
    }
  }

  const hasPrefill = initialValues && Object.values(initialValues).some(Boolean);

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal-panel max-h-[90vh] overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dlg-supplier-title"
      >
        <h2
          id="dlg-supplier-title"
          className="flex items-center gap-2 font-display text-2xl uppercase tracking-[0.08em] text-foreground"
        >
          <BookmarkPlus className="h-4 w-4 text-primary" /> Créer un fournisseur dans SAP B1
        </h2>
        {hasPrefill && (
          <p className="text-xs text-muted-foreground rounded-lg bg-muted/50 px-3 py-2">
            Champs pré-remplis depuis la facture — vous pouvez les modifier avant de créer.
          </p>
        )}
        <form
          onSubmit={(e) => {
            void handleSubmit(onSubmit)(e);
          }}
          className="space-y-3"
        >
          {/* ── Identifiants SAP ── */}
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground pt-1">
            Identifiants SAP B1
          </p>
          <FieldRow label="CardCode" required error={errors.cardCode?.message}>
            <input
              className={`app-input h-9 text-xs font-mono ${errors.cardCode ? 'border-destructive' : ''}`}
              placeholder="ex: F00042"
              disabled={isSubmitting}
              {...register('cardCode')}
            />
          </FieldRow>
          <FieldRow label="Raison sociale" required error={errors.cardName?.message}>
            <input
              className={`app-input h-9 text-xs ${errors.cardName ? 'border-destructive' : ''}`}
              placeholder="Raison sociale"
              disabled={isSubmitting}
              {...register('cardName')}
            />
          </FieldRow>

          {/* ── Identifiants fiscaux ── */}
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground pt-1">
            Identifiants fiscaux
          </p>
          <div className="grid grid-cols-2 gap-2">
            <FieldRow label="SIREN">
              <input
                className="app-input h-9 text-xs font-mono"
                placeholder="Ex: 123456789"
                disabled={isSubmitting}
                {...register('siren')}
              />
            </FieldRow>
            <FieldRow label="SIRET">
              <input
                className="app-input h-9 text-xs font-mono"
                placeholder="Ex: 12345678900012"
                disabled={isSubmitting}
                {...register('siret')}
              />
            </FieldRow>
          </div>
          <div className="grid grid-cols-1 gap-2">
            <FieldRow label="TVA intracommunautaire">
              <input
                className="app-input h-9 text-xs font-mono"
                placeholder="Ex: FR12345678901"
                disabled={isSubmitting}
                {...register('vatRegNum')}
              />
            </FieldRow>
          </div>

          {/* ── Adresse ── */}
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground pt-1">
            Adresse de facturation
          </p>
          <FieldRow label="Rue (ligne 1)">
            <input
              className="app-input h-9 text-xs"
              placeholder="Numéro et nom de voie"
              disabled={isSubmitting}
              {...register('street')}
            />
          </FieldRow>
          <FieldRow label="Rue (ligne 2)">
            <input
              className="app-input h-9 text-xs"
              placeholder="Complément d'adresse"
              disabled={isSubmitting}
              {...register('street2')}
            />
          </FieldRow>
          <div className="grid grid-cols-3 gap-2">
            <FieldRow label="Code postal">
              <input
                className="app-input h-9 text-xs font-mono"
                placeholder="75001"
                disabled={isSubmitting}
                {...register('postalCode')}
              />
            </FieldRow>
            <FieldRow label="Ville">
              <input
                className="app-input h-9 text-xs"
                placeholder="Paris"
                disabled={isSubmitting}
                {...register('city')}
              />
            </FieldRow>
            <FieldRow label="Pays (code ISO)">
              <input
                className="app-input h-9 text-xs font-mono"
                placeholder="FR"
                disabled={isSubmitting}
                {...register('country')}
              />
            </FieldRow>
          </div>

          {/* ── Contact ── */}
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground pt-1">
            Contact
          </p>
          <div className="grid grid-cols-2 gap-2">
            <FieldRow label="Email">
              <input
                className="app-input h-9 text-xs"
                placeholder="contact@exemple.fr"
                disabled={isSubmitting}
                {...register('email')}
              />
            </FieldRow>
            <FieldRow label="Téléphone">
              <input
                className="app-input h-9 text-xs font-mono"
                placeholder="+33 1 23 45 67 89"
                disabled={isSubmitting}
                {...register('phone')}
              />
            </FieldRow>
          </div>

          {serverError && (
            <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{serverError}</span>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Annuler
            </Button>
            <Button size="sm" type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Création…' : 'Créer et associer'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── CreateRuleModal ───────────────────────────────────────────────────────────

interface CreateRuleModalProps {
  state: RuleModalState;
  onConfirm: (data: RuleForm) => Promise<void>;
  onClose: () => void;
}

function CreateRuleModal({ state, onConfirm, onClose }: CreateRuleModalProps) {
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting, isSubmitSuccessful },
  } = useForm<RuleForm>({
    resolver: zodResolver(ruleSchema),
    defaultValues: {
      scope: state.scope,
      keyword: state.keyword,
      accountCode: state.accountCode,
      costCenter: state.costCenter,
      taxCodeB1: state.taxCodeB1,
    },
  });
  const accountCodeValue = watch('accountCode');

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="dlg-rule-title">
        <h2
          id="dlg-rule-title"
          className="flex items-center gap-2 font-display text-2xl uppercase tracking-[0.08em] text-foreground"
        >
          <BookmarkPlus className="h-4 w-4 text-primary" /> Créer une règle de mappage
        </h2>
        <p className="text-xs text-muted-foreground">
          Ligne {state.lineNo} — la règle sera appliquée automatiquement lors des prochaines
          ingestions.
        </p>

        {isSubmitSuccessful ? (
          <div className="space-y-3">
            <div className="rounded-2xl border border-success/30 bg-success/10 px-3 py-3 text-sm text-success flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 flex-shrink-0" /> Règle créée avec succès.
            </div>
            <Button size="sm" variant="outline" className="w-full" onClick={onClose}>
              Fermer
            </Button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              void handleSubmit(onConfirm)(e);
            }}
            className="space-y-3"
          >
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground font-medium block mb-1">
                  Portée
                </label>
                <select
                  className="app-input h-9 text-xs"
                  disabled={isSubmitting}
                  {...register('scope')}
                >
                  <option value="SUPPLIER">Fournisseur</option>
                  <option value="GLOBAL">Global</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground font-medium block mb-1">
                  Mot-clé
                </label>
                <input
                  className="app-input h-9 text-xs"
                  placeholder="ex: maintenance"
                  disabled={isSubmitting}
                  {...register('keyword')}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground font-medium block mb-1">
                  Compte comptable *
                </label>
                <AccountSearch
                  value={accountCodeValue}
                  onChange={(code) => {
                    setValue('accountCode', code, { shouldDirty: true, shouldValidate: true });
                  }}
                  placeholder="Code ou libellé…"
                  disabled={isSubmitting}
                  className={errors.accountCode ? 'border-destructive' : ''}
                  onSyncRequest={apiSyncSapChartOfAccounts}
                />
                <input type="hidden" {...register('accountCode')} />
                {errors.accountCode && (
                  <p className="text-xs text-destructive mt-0.5">{errors.accountCode.message}</p>
                )}
              </div>
              <div>
                <label className="text-xs text-muted-foreground font-medium block mb-1">
                  Centre de coût
                </label>
                <input
                  className="app-input h-9 text-xs font-mono"
                  placeholder="ex: CC-IT"
                  disabled={isSubmitting}
                  {...register('costCenter')}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground font-medium block mb-1">
                  Code TVA B1
                </label>
                <input
                  className="app-input h-9 text-xs font-mono"
                  placeholder="ex: D5"
                  disabled={isSubmitting}
                  {...register('taxCodeB1')}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground font-medium block mb-1">
                  Taux TVA
                </label>
                <input
                  className="app-input h-9 text-xs font-mono"
                  value={state.taxRate != null ? String(state.taxRate) : ''}
                  readOnly
                  disabled
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
              >
                Annuler
              </Button>
              <Button size="sm" type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Enregistrement…' : 'Créer la règle'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function extractKeyword(description: string): string {
  const tokens = description
    .toLowerCase()
    .replace(/[^a-zàâäéèêëîïôùûüç\s]/gi, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4);
  if (tokens.length === 0) return '';
  return tokens.reduce((a, b) => (b.length > a.length ? b : a));
}

function _FileViewerPanel({
  files,
  invoiceId,
}: {
  files: InvoiceDetail['files'];
  invoiceId: string;
}) {
  const first =
    files.find((f) => f.kind === 'PDF') ?? files.find((f) => f.kind === 'XML') ?? files[0] ?? null;
  const [selected, setSelected] = useState<string | null>(first?.id ?? null);
  const selectedFile = files.find((f) => f.id === selected) ?? null;

  if (files.length === 0) {
    return (
      <div className="flex h-[500px] items-center justify-center text-sm text-muted-foreground">
        Aucun fichier attaché.
      </div>
    );
  }

  const contentUrl = selectedFile
    ? `/api/invoices/${invoiceId}/files/${selectedFile.id}/content`
    : null;

  return (
    <div className="flex h-[calc(100vh-10rem)] min-h-[500px] flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-border/70 px-3 py-2">
        {files.map((f) => {
          const label = f.path.split(/[\\/]/).pop() ?? f.kind;
          const isActive = selected === f.id;
          const Icon = f.kind === 'PDF' ? FileText : f.kind === 'XML' ? Tag : Paperclip;
          return (
            <button
              key={f.id}
              onClick={() => setSelected(f.id)}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors ${
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
              title={f.path}
            >
              <Icon className="h-3 w-3 flex-shrink-0" />
              <span className="max-w-[110px] truncate">{label}</span>
            </button>
          );
        })}
        {selectedFile && (
          <a
            href={`/api/invoices/${invoiceId}/files/${selectedFile.id}/content`}
            target="_blank"
            rel="noreferrer"
            className="ml-auto flex items-center gap-1 rounded-lg p-1.5 text-muted-foreground hover:text-foreground"
            title="Ouvrir dans un nouvel onglet"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
      <div className="flex-1 overflow-hidden">
        {contentUrl && selectedFile?.kind === 'PDF' ? (
          <PdfViewer
            key={selected}
            url={contentUrl}
            filename={selectedFile?.path.split(/[\\/]/).pop()}
          />
        ) : contentUrl && selectedFile?.kind === 'XML' ? (
          <XmlViewer
            key={selected}
            url={contentUrl}
            filename={selectedFile?.path.split(/[\\/]/).pop()}
          />
        ) : contentUrl && selectedFile?.kind !== 'ATTACHMENT' ? (
          <PdfViewer
            key={selected}
            url={contentUrl}
            filename={selectedFile?.path.split(/[\\/]/).pop()}
          />
        ) : selectedFile?.kind === 'ATTACHMENT' ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <Paperclip className="h-8 w-8" />
            <p>{selectedFile.path.split(/[\\/]/).pop()}</p>
            <a
              href={contentUrl!}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-lg border border-border/70 px-3 py-1.5 text-xs font-medium hover:border-primary/30 hover:text-primary"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Télécharger
            </a>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Sélectionner un fichier
          </div>
        )}
      </div>
    </div>
  );
}

function TvaRecapCard({ lines, invoice }: { lines: InvoiceLine[]; invoice: InvoiceDetail }) {
  type TvaRow = { rate: string; ht: number; tva: number; ttc: number };
  const byRate = new Map<string, TvaRow>();
  for (const l of lines) {
    const key = l.taxRate != null ? `${l.taxRate}%` : (l.taxCode ?? '?');
    const existing = byRate.get(key) ?? { rate: key, ht: 0, tva: 0, ttc: 0 };
    byRate.set(key, {
      rate: key,
      ht: existing.ht + l.amountExclTax,
      tva: existing.tva + l.taxAmount,
      ttc: existing.ttc + l.amountInclTax,
    });
  }
  const rows = Array.from(byRate.values());
  const calcHt = rows.reduce((s, r) => s + r.ht, 0);
  const calcTva = rows.reduce((s, r) => s + r.tva, 0);
  const calcTtc = rows.reduce((s, r) => s + r.ttc, 0);
  const ecartHt = Math.abs(calcHt - invoice.totalExclTax);
  const ecartTva = Math.abs(calcTva - invoice.totalTax);
  const ecartTtc = Math.abs(calcTtc - invoice.totalInclTax);
  const hasEcart = ecartHt > 0.01 || ecartTva > 0.01 || ecartTtc > 0.01;

  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="font-display text-xl uppercase tracking-[0.08em]">
          Récapitulatif TVA
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="border-b border-border/70 bg-muted/30">
              <tr>
                <th className="px-4 py-2 text-left font-semibold uppercase tracking-wider text-muted-foreground">
                  Taux
                </th>
                <th className="px-4 py-2 text-right font-semibold uppercase tracking-wider text-muted-foreground">
                  HT
                </th>
                <th className="px-4 py-2 text-right font-semibold uppercase tracking-wider text-muted-foreground">
                  TVA
                </th>
                <th className="px-4 py-2 text-right font-semibold uppercase tracking-wider text-muted-foreground">
                  TTC
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.map((r) => (
                <tr key={r.rate}>
                  <td className="px-4 py-2 font-mono font-medium">{r.rate}</td>
                  <td className="px-4 py-2 text-right">{formatAmount(r.ht)}</td>
                  <td className="px-4 py-2 text-right">{formatAmount(r.tva)}</td>
                  <td className="px-4 py-2 text-right font-semibold">{formatAmount(r.ttc)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 border-border/70 bg-muted/20 font-semibold">
              <tr>
                <td className="px-4 py-2">Total lignes</td>
                <td className="px-4 py-2 text-right">{formatAmount(calcHt)}</td>
                <td className="px-4 py-2 text-right">{formatAmount(calcTva)}</td>
                <td className="px-4 py-2 text-right">{formatAmount(calcTtc)}</td>
              </tr>
              <tr className="text-muted-foreground">
                <td className="px-4 py-1.5 text-[11px]">Total PA</td>
                <td className="px-4 py-1.5 text-right text-[11px]">
                  {formatAmount(invoice.totalExclTax)}
                </td>
                <td className="px-4 py-1.5 text-right text-[11px]">
                  {formatAmount(invoice.totalTax)}
                </td>
                <td className="px-4 py-1.5 text-right text-[11px]">
                  {formatAmount(invoice.totalInclTax)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        {hasEcart && (
          <div className="mx-4 mb-4 flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>
              Écart détecté entre les lignes et les totaux PA (
              {ecartHt > 0.01 ? `HT: ${formatAmount(ecartHt)} ` : ''}
              {ecartTva > 0.01 ? `TVA: ${formatAmount(ecartTva)} ` : ''}
              {ecartTtc > 0.01 ? `TTC: ${formatAmount(ecartTtc)}` : ''}). Vérifier les lignes avant
              intégration.
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LinesTab({
  lines,
  invoiceId,
  editable,
  onSaved,
  onCreateRule,
}: {
  lines: InvoiceLine[];
  invoiceId: string;
  editable: boolean;
  onSaved: (updated: InvoiceDetail) => void;
  onCreateRule?: (line: InvoiceLine) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditingLine>({
    chosenAccountCode: '',
    chosenCostCenter: '',
    chosenTaxCodeB1: '',
    taxCodeLockedByUser: false,
    taxCodeSource: null,
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [resolvingTax, setResolvingTax] = useState(false);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);

  function startEdit(l: InvoiceLine) {
    const accountInvalid =
      l.suggestionSource?.includes('Compte inexistant') ||
      l.suggestionSource?.includes('Compte non imputable') ||
      l.suggestionSource?.includes('Compte inactif');
    setEditingId(l.id);
    setSaveError(null);
    setDraft({
      chosenAccountCode: accountInvalid
        ? ''
        : (l.chosenAccountCode ?? l.suggestedAccountCode ?? ''),
      chosenCostCenter: l.chosenCostCenter ?? l.suggestedCostCenter ?? '',
      chosenTaxCodeB1: l.chosenTaxCodeB1 ?? l.suggestedTaxCodeB1 ?? '',
      taxCodeLockedByUser: l.taxCodeLockedByUser,
      taxCodeSource: null,
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setSaveError(null);
  }

  // Appelé uniquement quand l'utilisateur sélectionne un compte dans la liste SAP (acctCode pur)
  async function handleAccountChange(lineId: string, acctCode: string) {
    setDraft((d) => ({ ...d, chosenAccountCode: acctCode }));
    setSaveError(null);
    if (!draft.taxCodeLockedByUser && acctCode.trim().length >= 2) {
      setResolvingTax(true);
      try {
        const resolution = await apiResolveTaxCode(invoiceId, lineId, acctCode.trim());
        if (resolution.taxCode) {
          setDraft((d) =>
            d.taxCodeLockedByUser
              ? d
              : {
                  ...d,
                  chosenTaxCodeB1: resolution.taxCode!,
                  taxCodeLockedByUser: false,
                  taxCodeSource: resolution.source,
                },
          );
        }
      } catch {
        // best-effort
      } finally {
        setResolvingTax(false);
      }
    }
  }

  async function saveLine(lineId: string) {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await apiUpdateLine(invoiceId, lineId, {
        chosenAccountCode: draft.chosenAccountCode.trim() || null,
        chosenCostCenter: draft.chosenCostCenter.trim() || null,
        chosenTaxCodeB1: draft.chosenTaxCodeB1.trim() || null,
        taxCodeLockedByUser: draft.taxCodeLockedByUser,
      });
      onSaved(updated);
      setEditingId(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Erreur lors de la sauvegarde');
    } finally {
      setSaving(false);
    }
  }

  async function acceptSuggestion(l: InvoiceLine) {
    if (!l.suggestedAccountCode) return;
    setAcceptingId(l.id);
    try {
      const updated = await apiUpdateLine(invoiceId, l.id, {
        chosenAccountCode: l.suggestedAccountCode,
        chosenCostCenter: l.suggestedCostCenter ?? null,
        chosenTaxCodeB1: l.suggestedTaxCodeB1 ?? null,
        taxCodeLockedByUser: false,
      });
      onSaved(updated);
    } finally {
      setAcceptingId(null);
    }
  }

  if (lines.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">Aucune ligne de facture.</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Description</th>
            <th className="text-right">Qté</th>
            <th className="text-right">Montant HT</th>
            <th className="text-right">TVA</th>
            <th className="text-right">TTC</th>
            <th>Compte</th>
            <th>Centre</th>
            <th>Code TVA B1</th>
            {(editable || onCreateRule) && <th className="px-3 py-2" />}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const isEditing = editingId === l.id;
            const displayAccount = l.chosenAccountCode ?? l.suggestedAccountCode;
            const isChosen = !!l.chosenAccountCode;
            const accountAlert =
              l.suggestionSource?.includes('Compte inexistant') ||
              l.suggestionSource?.includes('Compte non imputable') ||
              l.suggestionSource?.includes('Compte inactif') ||
              l.suggestionSource?.includes('non synchronisé');
            return (
              <tr
                key={l.id}
                className={`group transition-colors hover:bg-muted/20 ${isEditing ? 'bg-primary/10' : ''}`}
              >
                <td className="text-muted-foreground">{l.lineNo}</td>
                <td className="px-3 py-2 max-w-[180px]">
                  <span className="line-clamp-2">{l.description}</span>
                </td>
                <td className="px-3 py-2 text-right">{l.quantity}</td>
                <td className="px-3 py-2 text-right font-medium">
                  {formatAmount(l.amountExclTax)}
                </td>
                <td className="px-3 py-2 text-right text-muted-foreground">
                  {l.taxRate != null ? `${l.taxRate}%` : (l.taxCode ?? '—')}
                </td>
                <td className="px-3 py-2 text-right font-medium">
                  {formatAmount(l.amountInclTax)}
                </td>

                {/* Compte comptable */}
                <td className="px-3 py-2 min-w-[130px]">
                  {isEditing ? (
                    <AccountSearch
                      value={draft.chosenAccountCode}
                      onChange={(code) => {
                        void handleAccountChange(l.id, code);
                      }}
                      placeholder={l.suggestedAccountCode ?? 'Code ou libellé…'}
                      initialQuery={
                        !draft.chosenAccountCode || accountAlert
                          ? (l.suggestedAccountCode ?? l.description)
                          : undefined
                      }
                      onSyncRequest={apiSyncSapChartOfAccounts}
                    />
                  ) : displayAccount ? (
                    <div className="space-y-0.5">
                      <span className="inline-flex items-center gap-1">
                        {accountAlert && (
                          <AlertCircle
                            className="h-3.5 w-3.5 text-destructive"
                            aria-label="Compte invalide"
                          />
                        )}
                        <span
                          className={`font-mono text-xs font-semibold ${isChosen ? 'text-success' : accountAlert ? 'text-destructive' : 'text-foreground'}`}
                          title={l.suggestionSource ?? undefined}
                        >
                          {displayAccount}
                        </span>
                      </span>
                      {!isChosen && <ConfidenceBar value={l.suggestedAccountConfidence} />}
                    </div>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      {accountAlert && <AlertCircle className="h-3.5 w-3.5 text-destructive" />}
                      <span
                        className={`text-xs font-medium ${accountAlert ? 'text-destructive' : 'text-warning'}`}
                        title={l.suggestionSource ?? 'Aucune règle applicable'}
                      >
                        {accountAlert ? 'Compte invalide' : 'Non défini'}
                      </span>
                    </span>
                  )}
                </td>

                {/* Centre de coût */}
                <td className="px-3 py-2 min-w-[90px]">
                  {isEditing ? (
                    <input
                      className="app-input h-8 px-2 py-1 text-xs font-mono"
                      value={draft.chosenCostCenter}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, chosenCostCenter: e.target.value }))
                      }
                      placeholder={l.suggestedCostCenter ?? ''}
                    />
                  ) : (
                    <span className="font-mono text-xs text-muted-foreground">
                      {l.chosenCostCenter ?? l.suggestedCostCenter ?? '—'}
                    </span>
                  )}
                </td>

                {/* Code TVA B1 */}
                <td className="px-3 py-2 min-w-[110px]">
                  {isEditing ? (
                    <div className="space-y-0.5">
                      <div className="relative">
                        <input
                          className="app-input h-8 px-2 py-1 text-xs font-mono w-full"
                          value={draft.chosenTaxCodeB1}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              chosenTaxCodeB1: e.target.value,
                              taxCodeLockedByUser: true,
                              taxCodeSource: 'manual',
                            }))
                          }
                          placeholder={l.suggestedTaxCodeB1 ?? 'ex: S1'}
                        />
                        {resolvingTax && (
                          <span className="absolute right-1.5 top-1/2 -translate-y-1/2">
                            <span className="h-2.5 w-2.5 animate-spin rounded-full border border-primary border-t-transparent inline-block" />
                          </span>
                        )}
                      </div>
                      {draft.taxCodeLockedByUser ? (
                        <span className="inline-block rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                          Manuel
                        </span>
                      ) : draft.chosenTaxCodeB1 && draft.taxCodeSource ? (
                        <span className="inline-block rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider bg-muted text-muted-foreground">
                          Auto
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    (() => {
                      const displayTax = l.chosenTaxCodeB1 ?? l.suggestedTaxCodeB1;
                      if (!displayTax) {
                        return (
                          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-warning/15 text-warning">
                            <AlertCircle className="h-2.5 w-2.5 flex-shrink-0" />
                            TVA à confirmer
                          </span>
                        );
                      }
                      return (
                        <div className="space-y-0.5">
                          <span className="font-mono text-xs text-muted-foreground">
                            {displayTax}
                          </span>
                          {l.chosenTaxCodeB1 && (
                            <span
                              className={`block rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
                                l.taxCodeLockedByUser
                                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                                  : 'bg-muted text-muted-foreground'
                              }`}
                            >
                              {l.taxCodeLockedByUser ? 'Manuel' : 'Auto'}
                            </span>
                          )}
                        </div>
                      );
                    })()
                  )}
                </td>

                {(editable || onCreateRule) && (
                  <td className="px-2 py-2 text-right whitespace-nowrap">
                    {isEditing ? (
                      <span className="flex flex-col items-end gap-1">
                        <span className="flex items-center gap-1 justify-end">
                          <button
                            onClick={() => {
                              void saveLine(l.id);
                            }}
                            disabled={saving}
                            className="rounded-lg p-1 text-success transition-colors hover:bg-success/10 disabled:opacity-50"
                            title="Valider"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={cancelEdit}
                            disabled={saving}
                            className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted/60"
                            title="Annuler"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </span>
                        {saveError && (
                          <span className="text-[10px] text-destructive text-right max-w-[140px] leading-tight">
                            {saveError}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 justify-end">
                        {editable && (
                          <button
                            onClick={() => startEdit(l)}
                            className="rounded-lg p-1 text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-muted/60"
                            title="Modifier"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {editable && !isChosen && l.suggestedAccountCode && (
                          <button
                            onClick={() => {
                              void acceptSuggestion(l);
                            }}
                            disabled={acceptingId === l.id}
                            className="rounded-lg p-1 text-success opacity-0 transition-all group-hover:opacity-100 hover:bg-success/10 disabled:opacity-50"
                            title="Accepter la suggestion"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {onCreateRule && (
                          <button
                            onClick={() => onCreateRule(l)}
                            className="rounded-lg p-1 text-primary opacity-0 transition-all group-hover:opacity-100 hover:bg-primary/10"
                            title="Créer une règle de mappage"
                          >
                            <BookmarkPlus className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
        <tfoot className="border-t border-border/70 bg-muted/25">
          <tr>
            <td colSpan={3} />
            <td className="px-3 py-2 text-right text-xs text-muted-foreground">
              {formatAmount(lines.reduce((s, l) => s + l.amountExclTax, 0))}
            </td>
            <td className="px-3 py-2 text-right text-xs text-muted-foreground">
              {formatAmount(lines.reduce((s, l) => s + l.taxAmount, 0))}
            </td>
            <td className="px-3 py-2 text-right font-semibold">
              {formatAmount(lines.reduce((s, l) => s + l.amountInclTax, 0))}
            </td>
            <td colSpan={editable ? 4 : 3} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function FilesTab({ files, invoiceId }: { files: InvoiceDetail['files']; invoiceId: string }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const KIND_ICON: Record<string, typeof FileText> = {
    PDF: FileText,
    XML: Tag,
    ATTACHMENT: Paperclip,
  };

  if (files.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Aucun fichier attaché.</p>;
  }
  return (
    <div className="divide-y divide-border/70">
      {files.map((f) => {
        const Icon = KIND_ICON[f.kind] ?? Paperclip;
        const kb = Math.round(f.sizeBytes / 1024);
        const contentUrl = `/api/invoices/${invoiceId}/files/${f.id}/content`;
        const isExpanded = expandedId === f.id;
        const canPreview = f.kind === 'PDF' || f.kind === 'XML';
        return (
          <div key={f.id}>
            <div className="flex items-center gap-3 px-4 py-4">
              <Icon className="h-5 w-5 text-muted-foreground flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {f.path.split(/[\\/]/).pop()}
                </p>
                <p className="truncate font-mono text-xs text-muted-foreground">{f.path}</p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <div className="text-right text-xs text-muted-foreground space-y-0.5">
                  <p>{kb} Ko</p>
                  <p className="font-mono">{f.kind}</p>
                </div>
                {canPreview && (
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : f.id)}
                    className="flex items-center gap-1 rounded-lg border border-border/70 bg-card-muted/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary"
                    title={isExpanded ? 'Fermer la prévisualisation' : 'Prévisualiser ici'}
                  >
                    {isExpanded ? (
                      <X className="h-3.5 w-3.5" />
                    ) : (
                      <FileText className="h-3.5 w-3.5" />
                    )}
                    {isExpanded ? 'Fermer' : 'Aperçu'}
                  </button>
                )}
                <a
                  href={contentUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 rounded-lg border border-border/70 bg-card-muted/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary"
                  title="Ouvrir dans un nouvel onglet"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Voir
                </a>
              </div>
            </div>
            {isExpanded && (
              <div className="border-t border-border/50 bg-muted/20 px-4 pb-4">
                <iframe
                  src={contentUrl}
                  title={f.path.split(/[\\/]/).pop()}
                  className="mt-3 h-[600px] w-full rounded-xl border border-border/60 bg-white"
                  sandbox="allow-same-origin"
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AuditTab({ invoiceId }: { invoiceId: string }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiGetAudit({ entityId: invoiceId, limit: 100 })
      .then((r) => setEntries(r.items))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [invoiceId]);

  if (loading)
    return (
      <div className="py-8 flex justify-center" role="status" aria-label="Chargement…">
        <div
          className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent"
          aria-hidden="true"
        />
      </div>
    );
  if (entries.length === 0)
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Aucune entrée d'audit pour cette facture.
      </p>
    );

  return (
    <div className="divide-y divide-border/70">
      {entries.map((e) => (
        <div
          key={e.id}
          className={`flex items-start gap-3 px-4 py-4 ${e.outcome === 'ERROR' ? 'bg-destructive/5' : ''}`}
        >
          {e.outcome === 'OK' ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-success" />
          ) : (
            <XCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
          )}
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold">{ACTION_LABELS[e.action] ?? e.action}</span>
              {e.sapUser && (
                <span className="text-[10px] text-muted-foreground">par {e.sapUser}</span>
              )}
            </div>
            <p
              className={`text-xs ${e.outcome === 'ERROR' ? 'text-destructive' : 'text-foreground'}`}
            >
              {e.summary}
            </p>
            {e.outcome === 'ERROR' && e.errorMessage && (
              <p className="text-[10px] text-destructive/80">{e.errorMessage}</p>
            )}
            {(Boolean(e.payloadBefore) || Boolean(e.payloadAfter)) && (
              <details className="text-[10px] text-muted-foreground font-mono">
                <summary className="cursor-pointer hover:text-foreground">Voir le détail</summary>
                <div className="mt-2 space-y-2 rounded-2xl border border-border/70 bg-card-muted/60 p-3">
                  {Boolean(e.payloadBefore) && (
                    <div>
                      <p className="text-[9px] uppercase tracking-wide text-muted-foreground mb-1">
                        Avant
                      </p>
                      <pre className="whitespace-pre-wrap break-words">
                        {String(JSON.stringify(e.payloadBefore, null, 2))}
                      </pre>
                    </div>
                  )}
                  {Boolean(e.payloadAfter) && (
                    <div>
                      <p className="text-[9px] uppercase tracking-wide text-muted-foreground mb-1">
                        Après
                      </p>
                      <pre className="whitespace-pre-wrap break-words">
                        {String(JSON.stringify(e.payloadAfter, null, 2))}
                      </pre>
                    </div>
                  )}
                </div>
              </details>
            )}
          </div>
          <time className="text-[10px] text-muted-foreground flex-shrink-0 font-mono whitespace-nowrap">
            {formatDate(e.occurredAt)}
          </time>
        </div>
      ))}
    </div>
  );
}

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [postResult, setPostResult] = useState<{
    sapDocEntry: number;
    sapDocNum: number;
    simulate: boolean;
    attachmentWarning: string | null;
  } | null>(null);
  const [postError, setPostError] = useState<string | null>(null);
  const [integrationMode, setIntegrationMode] = useState<IntegrationMode>('SERVICE_INVOICE');
  const [simulate, _setSimulate] = useState(false);
  // Reject
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  // Send status PA
  const [sendingStatus, setSendingStatus] = useState(false);
  // SAP integration preferences (brouillon)
  const [sapSeries, setSapSeries] = useState('');
  const [savingDraft, setSavingDraft] = useState(false);
  // Audit drawer
  const [showAuditDrawer, setShowAuditDrawer] = useState(false);
  // Reset from ERROR
  const [resetting, setResetting] = useState(false);
  // Push fiscal data from invoice to SAP B1 supplier
  const [pushingFiscal, setPushingFiscal] = useState(false);
  const [pushFiscalDone, setPushFiscalDone] = useState(false);
  // Supplier picker
  const [editingSupplier, setEditingSupplier] = useState(false);
  const [supplierList, setSupplierList] = useState<SupplierCache[]>([]);
  const [selectedCardcode, setSelectedCardcode] = useState<string>('');
  const [savingSupplier, setSavingSupplier] = useState(false);
  // Re-enrichissement
  const [reEnriching, setReEnriching] = useState(false);
  // Re-parse lines
  const [reParsing, setReParsing] = useState(false);
  // Supplier creation in SAP
  const [showCreateSupplier, setShowCreateSupplier] = useState(false);
  const [createSupplierInitial, setCreateSupplierInitial] = useState<Partial<SupplierForm>>({});
  // Rule creation modal
  const [ruleModal, setRuleModal] = useState<RuleModalState | null>(null);
  // Voie B — rattachement SAP
  const [linking, setLinking] = useState(false);
  const [linkSapConflict, setLinkSapConflict] = useState<SapPurchaseInvoiceRef[] | null>(null);

  const reloadInvoice = useCallback(async () => {
    if (!id) return;
    const updatedInvoice = await apiGetInvoice(id);
    setInvoice(updatedInvoice);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    reloadInvoice()
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Erreur'))
      .finally(() => setLoading(false));
  }, [id, reloadInvoice]);

  // Keyboard shortcuts — V: valider, R: rejeter, ?: aide
  const [showKeyHelp, setShowKeyHelp] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement).matches('input,textarea,select')) return;
      if (e.key === '?') {
        e.preventDefault();
        setShowKeyHelp((v) => !v);
      }
      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        if (
          invoice &&
          (invoice.status === 'READY' || invoice.status === 'TO_REVIEW') &&
          invoice.supplierB1Cardcode &&
          !posting
        ) {
          void handlePost();
        }
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        if (invoice && ['NEW', 'TO_REVIEW', 'READY'].includes(invoice.status)) setShowReject(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [invoice, posting]);

  async function handlePost() {
    if (!id) return;
    setPosting(true);
    setPostResult(null);
    setPostError(null);
    try {
      const result = await apiPostInvoice(id, { integrationMode, simulate });
      setPostResult({
        sapDocEntry: result.sapDocEntry,
        sapDocNum: result.sapDocNum,
        simulate: result.simulate,
        attachmentWarning: result.attachmentWarning ?? null,
      });
      if (result.simulate) {
        toast.info(`Simulation : DocEntry ${result.sapDocEntry}`);
      } else {
        toast.success(`Intégrée dans SAP B1 — DocNum ${result.sapDocNum}`);
      }
      if (result.attachmentWarning) toast.error(`PJ : ${result.attachmentWarning}`);
      await reloadInvoice();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Erreur lors de l'intégration";
      setPostError(message);
      toast.error(message);
      await reloadInvoice().catch(() => {});
    } finally {
      setPosting(false);
    }
  }

  async function handleReject() {
    if (!id || rejectReason.trim().length === 0) return;
    setRejecting(true);
    try {
      await apiRejectInvoice(id, rejectReason.trim());
      setShowReject(false);
      setRejectReason('');
      toast.success('Facture rejetée');
      await reloadInvoice();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors du rejet');
    } finally {
      setRejecting(false);
    }
  }

  async function handleReset() {
    if (!id) return;
    setResetting(true);
    try {
      const updated = await apiResetInvoice(id);
      setInvoice(updated);
      setPostResult(null);
      setPushFiscalDone(false);
    } finally {
      setResetting(false);
    }
  }

  async function handlePushSupplierFiscal() {
    if (!id) return;
    setPushingFiscal(true);
    try {
      await apiPushSupplierFiscal(id);
      setPushFiscalDone(true);
      toast.success('Identifiants fiscaux mis à jour dans SAP B1');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors de la mise à jour');
    } finally {
      setPushingFiscal(false);
    }
  }

  async function handleCreateSupplier(data: SupplierForm) {
    if (!id) return;
    const federalTaxId = data.siret?.trim() || data.siren?.trim() || undefined;
    const result = await apiCreateSupplierInSap({
      cardCode: data.cardCode.trim(),
      cardName: data.cardName.trim(),
      federalTaxId,
      vatRegNum: data.vatRegNum?.trim() || undefined,
      street: data.street?.trim() || undefined,
      street2: data.street2?.trim() || undefined,
      city: data.city?.trim() || undefined,
      postalCode: data.postalCode?.trim() || undefined,
      country: data.country?.trim() || undefined,
      email: data.email?.trim() || undefined,
      phone: data.phone?.trim() || undefined,
      invoiceId: id,
    });
    const updated = await apiUpdateSupplier(id, result.cardCode);
    setInvoice(updated);
    setShowCreateSupplier(false);
    toast.success(`Fournisseur ${result.cardCode} créé et associé`);
  }

  async function openCreateSupplierModal() {
    if (!invoice) return;
    let suppliers = supplierList;
    if (suppliers.length === 0) {
      try {
        const res = await apiGetSuppliers();
        suppliers = res.items;
        setSupplierList(res.items);
      } catch {
        suppliers = [];
      }
    }
    setCreateSupplierInitial(buildSupplierPrefill(invoice, nextSupplierCardCode(suppliers)));
    setShowCreateSupplier(true);
  }

  async function openSupplierPicker() {
    setEditingSupplier(true);
    setSelectedCardcode(invoice?.supplierB1Cardcode ?? '');
    if (supplierList.length === 0) {
      const res = await apiGetSuppliers();
      setSupplierList(res.items);
    }
  }

  async function saveSupplier() {
    if (!id) return;
    setSavingSupplier(true);
    try {
      const updated = await apiUpdateSupplier(id, selectedCardcode || null);
      setInvoice(updated);
      setEditingSupplier(false);
    } finally {
      setSavingSupplier(false);
    }
  }

  async function handleSendStatus() {
    if (!id) return;
    setSendingStatus(true);
    try {
      await apiSendStatus(id);
      toast.success('Statut retourné à la PA');
      await reloadInvoice();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Erreur lors de l'envoi du statut");
    } finally {
      setSendingStatus(false);
    }
  }

  async function handleSaveDraft() {
    if (!id) return;
    setSavingDraft(true);
    try {
      const updated = await apiSaveDraft(id, {
        integrationMode,
        sapSeries: sapSeries.trim() || undefined,
      });
      setInvoice(updated);
      toast.success('Préférences enregistrées');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors de la sauvegarde');
    } finally {
      setSavingDraft(false);
    }
  }

  async function handleLinkSap() {
    if (!id) return;
    setLinking(true);
    setLinkSapConflict(null);
    try {
      const result = await apiLinkSap(id);
      if ('conflict' in result) {
        setLinkSapConflict(result.candidates);
        toast.error(result.message);
      } else {
        toast.success(`Facture rattachée à SAP — DocNum ${result.sapDocNum}`);
        await reloadInvoice();
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors du rattachement SAP');
    } finally {
      setLinking(false);
    }
  }

  async function handleReEnrich() {
    if (!id) return;
    setReEnriching(true);
    try {
      const updated = await apiReEnrichInvoice(id);
      setInvoice(updated);
    } finally {
      setReEnriching(false);
    }
  }

  async function handleReParseLines() {
    if (!id) return;
    setReParsing(true);
    try {
      const updated = await apiReParseLinesInvoice(id);
      setInvoice(updated);
      toast.success('Lignes ré-analysées depuis le XML');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors de la ré-analyse des lignes');
    } finally {
      setReParsing(false);
    }
  }

  function openRuleModal(line: InvoiceLine) {
    setRuleModal({
      lineId: line.id,
      lineNo: line.lineNo,
      scope: invoice?.supplierB1Cardcode ? 'SUPPLIER' : 'GLOBAL',
      keyword: extractKeyword(line.description),
      accountCode: line.chosenAccountCode ?? line.suggestedAccountCode ?? '',
      costCenter: line.chosenCostCenter ?? line.suggestedCostCenter ?? '',
      taxCodeB1: line.chosenTaxCodeB1 ?? line.suggestedTaxCodeB1 ?? '',
      taxRate: line.taxRate != null ? Number(line.taxRate) : null,
    });
  }

  async function saveRule(data: RuleForm) {
    if (!ruleModal) return;
    await apiCreateMappingRule({
      scope: data.scope,
      supplierCardcode: data.scope === 'SUPPLIER' ? (invoice?.supplierB1Cardcode ?? null) : null,
      matchKeyword: data.keyword.trim() || null,
      matchTaxRate: ruleModal.taxRate,
      accountCode: data.accountCode.trim(),
      costCenter: data.costCenter.trim() || null,
      taxCodeB1: data.taxCodeB1.trim() || null,
    });
    toast.success('Règle de mappage créée');
  }

  if (loading) return <InvoiceDetailSkeleton />;

  if (error || !invoice) {
    return (
      <div className="app-page">
        <Link
          to="/invoices"
          className="mb-4 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Retour
        </Link>
        <div className="alert-error">
          <AlertCircle className="h-4 w-4" />
          {error ?? 'Facture introuvable.'}
        </div>
      </div>
    );
  }

  const isPosted = invoice.status === 'POSTED';
  const isError = invoice.status === 'ERROR';
  const isEditable = !TERMINAL_STATUSES_UI.has(invoice.status);

  return (
    <div className="app-page">
      {/* Breadcrumb */}
      <Link
        to="/invoices"
        className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Retour aux factures
      </Link>

      {/* Title + status */}
      <div className="page-header">
        <div>
          <p className="page-eyebrow">Detail facture</p>
          <h1 className="page-title">
            {invoice.supplierNameRaw} · recue le {formatDate(invoice.receivedAt)}
          </h1>
          <p className="page-subtitle">{invoice.docNumberPa}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <StatusBadge status={invoice.status} />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowAuditDrawer(true)}
            title="Historique d'audit"
          >
            <ScrollText className="h-3.5 w-3.5 mr-1" /> Audit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowKeyHelp((v) => !v)}
            title="Raccourcis clavier"
          >
            <HelpCircle className="h-4 w-4" />
          </Button>
          {['NEW', 'TO_REVIEW', 'READY', 'ERROR'].includes(invoice.status) && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleLinkSap()}
              disabled={linking}
              title="Rattacher à une facture SAP créée manuellement (Voie B)"
            >
              <Link2 className="h-3.5 w-3.5 mr-1" />
              {linking ? 'Recherche…' : 'Rattacher SAP'}
            </Button>
          )}
          {['NEW', 'TO_REVIEW', 'READY'].includes(invoice.status) && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowReject(true)}
              className="text-destructive border-destructive/30 hover:bg-destructive/10"
            >
              <Ban className="h-3.5 w-3.5 mr-1" /> Rejeter
            </Button>
          )}
        </div>
      </div>

      {/* Reject modal */}
      {showReject && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dlg-reject-title"
          >
            <h2
              id="dlg-reject-title"
              className="flex items-center gap-2 font-display text-2xl uppercase tracking-[0.08em] text-foreground"
            >
              <Ban className="h-4 w-4 text-destructive" /> Rejeter la facture
            </h2>
            <p className="text-sm text-muted-foreground">
              Le motif est obligatoire et sera enregistré dans l'audit log.
            </p>
            <textarea
              className="app-textarea resize-none"
              rows={4}
              placeholder="Motif du rejet…"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              disabled={rejecting}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setShowReject(false);
                  setRejectReason('');
                }}
                disabled={rejecting}
              >
                Annuler
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={handleReject}
                disabled={rejecting || rejectReason.trim().length === 0}
              >
                {rejecting ? 'Rejet en cours…' : 'Confirmer le rejet'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Voie B — conflict modal (409 : plusieurs factures SAP trouvées) */}
      {linkSapConflict && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-panel max-w-2xl max-h-[90vh] overflow-y-auto"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dlg-link-conflict-title"
          >
            <h2
              id="dlg-link-conflict-title"
              className="flex items-center gap-2 font-display text-2xl uppercase tracking-[0.08em] text-foreground"
            >
              <AlertCircle className="h-4 w-4 text-warning" /> Plusieurs factures SAP trouvées
            </h2>
            <p className="text-sm text-muted-foreground">
              {linkSapConflict.length} factures SAP correspondent au numéro{' '}
              <span className="font-mono font-semibold">{invoice.docNumberPa}</span>. Le
              rattachement automatique est impossible — sélectionnez la bonne facture manuellement
              dans SAP B1 en corrigeant le champ{' '}
              <span className="font-mono">NumAtCard / Vendor Ref</span>.
            </p>
            <div className="overflow-x-auto rounded-xl border border-border/70">
              <table className="w-full text-xs">
                <thead className="bg-muted/30 border-b border-border/70">
                  <tr>
                    {[
                      'DocNum',
                      'DocEntry',
                      'CardCode',
                      'Fournisseur',
                      'NumAtCard',
                      'Date',
                      'Total TTC',
                    ].map((h) => (
                      <th
                        key={h}
                        className="px-3 py-2 text-left font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {linkSapConflict.map((c) => (
                    <tr key={c.docEntry} className="hover:bg-muted/20">
                      <td className="px-3 py-2 font-mono font-semibold">{c.docNum}</td>
                      <td className="px-3 py-2 font-mono text-muted-foreground">{c.docEntry}</td>
                      <td className="px-3 py-2 font-mono">{c.cardCode}</td>
                      <td className="px-3 py-2 max-w-[160px] truncate" title={c.cardName}>
                        {c.cardName}
                      </td>
                      <td className="px-3 py-2 font-mono">{c.numAtCard}</td>
                      <td className="px-3 py-2 font-mono">{c.docDate?.slice(0, 10)}</td>
                      <td className="px-3 py-2 text-right font-semibold">
                        {formatAmount(c.docTotal)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={() => setLinkSapConflict(null)}>
                Fermer
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Rule creation modal */}
      {ruleModal && (
        <CreateRuleModal
          key={ruleModal.lineId}
          state={ruleModal}
          onConfirm={saveRule}
          onClose={() => setRuleModal(null)}
        />
      )}

      {/* Supplier creation modal */}
      {showCreateSupplier && (
        <CreateSupplierModal
          initialValues={createSupplierInitial}
          onConfirm={handleCreateSupplier}
          onClose={() => setShowCreateSupplier(false)}
        />
      )}

      {/* Keyboard shortcuts help modal */}
      {showKeyHelp && (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowKeyHelp(false)}>
          <div
            className="modal-panel max-w-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dlg-keyhelp-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="dlg-keyhelp-title" className="font-display text-xl uppercase tracking-[0.08em]">
              Raccourcis clavier
            </h2>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border/60">
                {[
                  ['V', 'Valider / intégrer dans SAP'],
                  ['R', 'Ouvrir le formulaire de rejet'],
                  ['?', 'Afficher / masquer cette aide'],
                ].map(([key, desc]) => (
                  <tr key={key}>
                    <td className="py-2 pr-4">
                      <kbd className="rounded border border-border bg-muted px-2 py-0.5 font-mono text-xs">
                        {key}
                      </kbd>
                    </td>
                    <td className="py-2 text-muted-foreground">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={() => setShowKeyHelp(false)}
            >
              Fermer
            </Button>
          </div>
        </div>
      )}

      {/* Audit drawer */}
      {showAuditDrawer && id && (
        <div className="fixed inset-0 z-40 flex">
          <div
            className="flex-1 bg-black/40 backdrop-blur-sm"
            onClick={() => setShowAuditDrawer(false)}
          />
          <aside className="relative flex h-full w-full max-w-md flex-col border-l border-border/70 bg-background shadow-2xl">
            <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
              <div className="flex items-center gap-2">
                <ScrollText className="h-4 w-4 text-primary" />
                <span className="font-display text-sm uppercase tracking-[0.1em]">
                  Historique d'audit
                </span>
              </div>
              <button
                onClick={() => setShowAuditDrawer(false)}
                className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                aria-label="Fermer l'historique"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <AuditTab invoiceId={id} />
            </div>
          </aside>
        </div>
      )}

      {/* editing panel */}
      <div className="space-y-4">
        {/* Ligne 1 : En-tête + Matching fournisseur côte à côte */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* En-tête */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="font-display text-xl uppercase tracking-[0.08em]">
                En-tête
              </CardTitle>
            </CardHeader>
            <CardContent>
              <InfoRow label="Fournisseur (PA)" value={invoice.supplierNameRaw} />
              <InfoRow
                label="Identifiant PA"
                value={<span className="font-mono text-xs">{invoice.supplierPaIdentifier}</span>}
              />
              {invoice.supplierB1Cardcode && (
                <InfoRow
                  label="CardCode SAP"
                  value={<span className="font-mono text-xs">{invoice.supplierB1Cardcode}</span>}
                />
              )}
              <InfoRow
                label="N° document PA"
                value={<span className="font-mono text-xs">{invoice.docNumberPa}</span>}
              />
              <InfoRow label="Date document" value={formatDate(invoice.docDate)} />
              {invoice.dueDate && <InfoRow label="Échéance" value={formatDate(invoice.dueDate)} />}
              <InfoRow label="Devise" value={invoice.currency} />
              <InfoRow label="Format" value={invoice.format} />
              <InfoRow label="Source PA" value={paSourceLabel(invoice.paSource)} />
            </CardContent>
          </Card>

          {/* Matching fournisseur */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="font-display text-xl uppercase tracking-[0.08em]">
                Matching fournisseur
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Score de confiance</p>
                <ConfidenceBar value={invoice.supplierMatchConfidence} />
                {invoice.supplierMatchReason && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {invoice.supplierMatchReason}
                  </p>
                )}
              </div>

              {editingSupplier ? (
                <div className="space-y-2">
                  <select
                    className="app-input h-10 text-xs"
                    value={selectedCardcode}
                    onChange={(e) => setSelectedCardcode(e.target.value)}
                    disabled={savingSupplier}
                  >
                    <option value="">— Aucun fournisseur —</option>
                    {supplierList.map((s) => (
                      <option key={s.cardcode} value={s.cardcode}>
                        {s.cardcode} — {s.cardname}
                        {s.taxId0 || s.federaltaxid ? ` · ${s.taxId0 ?? s.federaltaxid}` : ''}
                        {s.vatregnum ? ` · ${s.vatregnum}` : ''}
                        {s.city || s.country
                          ? ` · ${[s.city, s.country].filter(Boolean).join('/')}`
                          : ''}
                      </option>
                    ))}
                  </select>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="flex-1"
                      onClick={saveSupplier}
                      disabled={savingSupplier}
                    >
                      <Check className="h-3.5 w-3.5 mr-1" />
                      {savingSupplier ? 'Enregistrement…' : 'Valider'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditingSupplier(false)}
                      disabled={savingSupplier}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {invoice.supplierB1Cardcode ? (
                    invoice.supplierInCache === false ? (
                      <div className="rounded-2xl border border-warning/40 bg-warning/10 px-3 py-2 space-y-1">
                        <p className="flex items-center gap-1.5 text-xs font-semibold text-warning">
                          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                          Non référencé dans SAP B1
                        </p>
                        <p className="font-mono text-xs text-warning/80">
                          {invoice.supplierB1Cardcode}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          Ce CardCode n'est pas présent dans le cache fournisseurs. Synchronisez les
                          fournisseurs depuis SAP ou réassignez-en un existant.
                        </p>
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
                        <span className="font-mono font-semibold">
                          {invoice.supplierB1Cardcode}
                        </span>
                        {invoice.supplierNameRaw && (
                          <span className="ml-2 text-success/80">— {invoice.supplierNameRaw}</span>
                        )}
                      </div>
                    )
                  ) : (
                    <p className="rounded-2xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                      Fournisseur non résolu dans SAP B1
                    </p>
                  )}
                  {!TERMINAL_STATUSES_UI.has(invoice.status) && (
                    <div className="space-y-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full text-xs"
                        onClick={openSupplierPicker}
                      >
                        <Pencil className="h-3 w-3 mr-1.5" />
                        {invoice.supplierB1Cardcode
                          ? 'Changer de fournisseur'
                          : 'Associer un fournisseur'}
                      </Button>
                      {!invoice.supplierB1Cardcode && !editingSupplier && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full text-xs"
                          onClick={() => {
                            void openCreateSupplierModal();
                          }}
                        >
                          <BookmarkPlus className="h-3 w-3 mr-1.5" /> Créer dans SAP B1
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
        {/* fin grid En-tête / Matching */}

        {/* Lignes de facture */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="font-display text-xl uppercase tracking-[0.08em]">
                Lignes ({invoice.lines.length})
              </CardTitle>
              {(invoice.format === 'UBL' || invoice.format === 'CII') && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  onClick={() => {
                    void handleReParseLines();
                  }}
                  disabled={reParsing}
                  title="Ré-analyser les lignes depuis le fichier XML"
                >
                  <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${reParsing ? 'animate-spin' : ''}`} />
                  {reParsing ? 'Analyse…' : 'Ré-analyser XML'}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <LinesTab
              lines={invoice.lines}
              invoiceId={invoice.id}
              editable={isEditable}
              onSaved={setInvoice}
              onCreateRule={openRuleModal}
            />
          </CardContent>
        </Card>

        {/* Ligne : Montants + TVA (1/3) | Intégration SAP B1 (2/3) */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Colonne gauche 1/3 : Montants + Récapitulatif TVA */}
          <div className="space-y-4">
            {/* Montants */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="font-display text-xl uppercase tracking-[0.08em]">
                  Montants
                </CardTitle>
              </CardHeader>
              <CardContent>
                <InfoRow
                  label="Total HT"
                  value={formatAmount(invoice.totalExclTax, invoice.currency)}
                />
                <InfoRow
                  label="Total TVA"
                  value={formatAmount(invoice.totalTax, invoice.currency)}
                />
                <div className="flex items-center justify-between py-2 gap-4">
                  <span className="text-sm font-semibold">Total TTC</span>
                  <span className="text-lg font-bold">
                    {formatAmount(invoice.totalInclTax, invoice.currency)}
                  </span>
                </div>
              </CardContent>
            </Card>

            {/* Récapitulatif TVA */}
            <TvaRecapCard lines={invoice.lines} invoice={invoice} />
          </div>

          {/* Colonne droite 2/3 : Intégration SAP B1 */}
          <div className="lg:col-span-2">
            {/* Intégration SAP B1 */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="font-display text-xl uppercase tracking-[0.08em]">
                  Intégration SAP B1
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-2">
                  {isPosted ? (
                    <CheckCircle2 className="h-5 w-5 text-success" />
                  ) : isError ? (
                    <XCircle className="h-5 w-5 text-destructive" />
                  ) : (
                    <Clock className="h-5 w-5 text-muted-foreground" />
                  )}
                  <span className="text-sm font-medium">
                    {isPosted ? 'Intégrée' : isError ? 'Erreur' : 'En attente'}
                  </span>
                </div>
                {invoice.sapDocEntry && (
                  <InfoRow
                    label="DocEntry"
                    value={<span className="font-mono text-xs">{invoice.sapDocEntry}</span>}
                  />
                )}
                {invoice.sapDocNum && (
                  <InfoRow
                    label="DocNum"
                    value={<span className="font-mono text-xs">{invoice.sapDocNum}</span>}
                  />
                )}
                {invoice.integrationMode && (
                  <InfoRow label="Mode" value={invoice.integrationMode} />
                )}
                {invoice.sapAttachmentEntry && (
                  <a
                    href={`/api/invoices/${invoice.id}/files/xml`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 text-xs text-primary hover:underline"
                  >
                    <Paperclip className="h-3.5 w-3.5 flex-shrink-0" />
                    UBL attaché dans SAP (AttachmentEntry&nbsp;#{invoice.sapAttachmentEntry})
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                {invoice.statusReason && (
                  <div className="rounded-2xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                    {invoice.statusReason}
                  </div>
                )}

                {/* Mise à jour TVA intracommunautaire depuis la facture */}
                {['READY', 'TO_REVIEW', 'ERROR'].includes(invoice.status) &&
                  invoice.supplierB1Cardcode &&
                  invoice.supplierExtracted?.vatNumber && (
                    <div className="rounded-2xl border border-primary/20 bg-primary/5 px-3 py-2.5 text-xs space-y-2">
                      <p className="font-semibold text-foreground">TVA disponible sur la facture</p>
                      <div className="space-y-0.5 text-muted-foreground font-mono">
                        {(invoice.supplierExtracted?.siret || invoice.supplierExtracted?.siren) && (
                          <p>
                            N° identification :{' '}
                            <span className="text-foreground font-semibold">
                              {invoice.supplierExtracted?.siret ?? invoice.supplierExtracted?.siren}
                            </span>
                            <span className="text-muted-foreground/60">
                              {' '}
                              (à saisir manuellement dans SAP B1)
                            </span>
                          </p>
                        )}
                        <p>
                          TVA intracommunautaire :{' '}
                          <span className="text-foreground font-semibold">
                            {invoice.supplierExtracted.vatNumber}
                          </span>
                        </p>
                      </div>
                      {pushFiscalDone ? (
                        <div className="flex items-center gap-1.5 text-success text-xs font-medium">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          TVA appliquée dans SAP B1 — relancez l'intégration.
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          className="w-full"
                          onClick={() => {
                            void handlePushSupplierFiscal();
                          }}
                          disabled={pushingFiscal}
                        >
                          {pushingFiscal
                            ? 'Mise à jour en cours…'
                            : 'Appliquer la TVA sur la fiche fournisseur SAP B1'}
                        </Button>
                      )}
                    </div>
                  )}

                {isError && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={handleReset}
                    disabled={resetting}
                  >
                    <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
                    {resetting ? 'Remise en traitement…' : 'Remettre en traitement'}
                  </Button>
                )}

                {/* Re-enrichissement — visible si NEW ou TO_REVIEW */}
                {['NEW', 'TO_REVIEW'].includes(invoice.status) && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full text-xs"
                    onClick={handleReEnrich}
                    disabled={reEnriching}
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 mr-1.5 ${reEnriching ? 'animate-spin' : ''}`}
                    />
                    {reEnriching ? 'Recalcul en cours…' : 'Recalculer fournisseur / comptes / TVA'}
                  </Button>
                )}

                {/* Série + brouillon */}
                {isEditable && (
                  <div className="space-y-2 border-t border-border/70 pt-2">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        Série SAP
                      </label>
                      <input
                        className="app-input h-9 text-xs font-mono"
                        value={sapSeries}
                        onChange={(e) => setSapSeries(e.target.value)}
                        placeholder="ex: S1"
                        disabled={savingDraft}
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => {
                        void handleSaveDraft();
                      }}
                      disabled={savingDraft}
                    >
                      <Save className="h-4 w-4 mr-1.5" />
                      {savingDraft ? 'Enregistrement…' : 'Enregistrer (sans intégrer SAP)'}
                    </Button>
                  </div>
                )}

                {/* Alerte fournisseur non référencé dans SAP */}
                {invoice.supplierInCache === false &&
                  invoice.supplierB1Cardcode &&
                  !postResult &&
                  (invoice.status === 'READY' || invoice.status === 'TO_REVIEW') && (
                    <div className="mt-2 rounded-2xl border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs text-destructive flex items-start gap-2">
                      <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="font-semibold">Fournisseur non référencé dans SAP B1</p>
                        <p className="mt-0.5 text-destructive/80">
                          Le CardCode{' '}
                          <span className="font-mono font-semibold">
                            {invoice.supplierB1Cardcode}
                          </span>{' '}
                          est absent du cache fournisseurs. L'intégration échouera lors de la
                          validation SAP. Synchronisez les fournisseurs ou réassignez-en un
                          existant.
                        </p>
                      </div>
                    </div>
                  )}

                {/* Posting UI — visible only if READY and supplier resolved */}
                {(invoice.status === 'READY' || invoice.status === 'TO_REVIEW') &&
                  invoice.supplierB1Cardcode &&
                  !postResult && (
                    <div className="mt-2 space-y-3 border-t border-border/70 pt-2">
                      {postError && (
                        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
                          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                          <span>{postError}</span>
                        </div>
                      )}
                      <div className="space-y-1.5">
                        <label className="text-xs text-muted-foreground font-medium">
                          Mode d'intégration
                        </label>
                        <select
                          className="app-input h-10 text-xs"
                          value={integrationMode}
                          onChange={(e) => setIntegrationMode(e.target.value as IntegrationMode)}
                          disabled={posting}
                        >
                          <option value="SERVICE_INVOICE">Facture d'achat (Service)</option>
                          <option value="JOURNAL_ENTRY">Écriture comptable</option>
                        </select>
                      </div>
                      <Button className="w-full" size="sm" onClick={handlePost} disabled={posting}>
                        <Send className="h-4 w-4 mr-1.5" />
                        {posting ? 'Intégration en cours…' : 'Intégrer dans SAP B1'}
                      </Button>
                    </div>
                  )}

                {/* Success banner */}
                {postResult && (
                  <div className="space-y-2">
                    <div className="space-y-0.5 rounded-2xl border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
                      <p className="font-semibold flex items-center gap-1">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        {postResult.simulate ? 'Simulation réussie' : 'Intégrée dans SAP B1'}
                      </p>
                      <p>
                        DocEntry : <span className="font-mono">{postResult.sapDocEntry}</span>
                      </p>
                      <p>
                        DocNum : <span className="font-mono">{postResult.sapDocNum}</span>
                      </p>
                    </div>
                    {postResult.attachmentWarning && (
                      <div className="rounded-2xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                        ⚠ {postResult.attachmentWarning}
                      </div>
                    )}
                  </div>
                )}

                {/* Retour statut PA */}
                {['POSTED', 'REJECTED'].includes(invoice.status) && (
                  <div className="mt-2 space-y-2 border-t border-border/70 pt-2">
                    {invoice.paStatusSentAt ? (
                      <div className="alert-info text-xs">
                        <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
                        Statut retourné à la PA le {formatDate(invoice.paStatusSentAt)}
                      </div>
                    ) : (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full"
                          onClick={handleSendStatus}
                          disabled={sendingStatus}
                        >
                          <Send className="h-3.5 w-3.5 mr-1.5" />
                          {sendingStatus ? 'Envoi en cours…' : 'Retourner statut à la PA'}
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
          {/* fin col 2/3 */}
        </div>
        {/* fin grid 1/3 - 2/3 */}

        {/* Fichiers */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="font-display text-xl uppercase tracking-[0.08em]">
              Fichiers ({invoice.files.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <FilesTab files={invoice.files} invoiceId={invoice.id} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
