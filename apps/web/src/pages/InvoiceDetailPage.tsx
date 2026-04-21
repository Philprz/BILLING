import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, XCircle, Clock, FileText, Tag, AlertCircle, Paperclip, Send, Ban, ScrollText } from 'lucide-react';
import { apiGetInvoice, apiPostInvoice, apiRejectInvoice, apiSendStatus } from '../api/invoices.api';
import { apiGetAudit } from '../api/audit.api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { StatusBadge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { PageLoader } from '../components/ui/spinner';
import { formatAmount, formatDate } from '../lib/utils';
import type { InvoiceDetail, InvoiceLine, AuditEntry, AuditAction } from '../api/types';

type TabId = 'lines' | 'files' | 'audit';
type IntegrationMode = 'SERVICE_INVOICE' | 'JOURNAL_ENTRY';

const ACTION_LABELS: Record<AuditAction, string> = {
  LOGIN: 'Connexion', LOGOUT: 'Déconnexion', FETCH_PA: 'Ingestion PA',
  VIEW_INVOICE: 'Consultation', EDIT_MAPPING: 'Modif. règle',
  APPROVE: 'Approbation', REJECT: 'Rejet', POST_SAP: 'Intégration SAP',
  SEND_STATUS_PA: 'Retour statut PA', SYSTEM_ERROR: 'Erreur système', CONFIG_CHANGE: 'Config.',
};

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between py-2 border-b last:border-0 gap-4">
      <span className="text-sm text-muted-foreground flex-shrink-0">{label}</span>
      <span className="text-sm font-medium text-right">{value ?? '—'}</span>
    </div>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const color = value >= 80 ? 'bg-green-500' : value >= 50 ? 'bg-amber-400' : 'bg-red-400';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-xs text-muted-foreground w-8 text-right">{value}%</span>
    </div>
  );
}

function LinesTab({ lines }: { lines: InvoiceLine[] }) {
  if (lines.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Aucune ligne de facture.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-2 font-medium">#</th>
            <th className="text-left px-3 py-2 font-medium">Description</th>
            <th className="text-right px-3 py-2 font-medium">Qté</th>
            <th className="text-right px-3 py-2 font-medium">P.U. HT</th>
            <th className="text-right px-3 py-2 font-medium">Montant HT</th>
            <th className="text-right px-3 py-2 font-medium">TVA</th>
            <th className="text-right px-3 py-2 font-medium">Montant TTC</th>
            <th className="text-left px-3 py-2 font-medium">Compte suggéré</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {lines.map((l) => (
            <tr key={l.id} className="hover:bg-muted/30">
              <td className="px-3 py-2 text-muted-foreground">{l.lineNo}</td>
              <td className="px-3 py-2 max-w-[200px]">
                <span className="line-clamp-2">{l.description}</span>
              </td>
              <td className="px-3 py-2 text-right">{l.quantity}</td>
              <td className="px-3 py-2 text-right">{formatAmount(l.unitPrice)}</td>
              <td className="px-3 py-2 text-right font-medium">{formatAmount(l.amountExclTax)}</td>
              <td className="px-3 py-2 text-right text-muted-foreground">
                {l.taxRate != null ? `${l.taxRate}%` : l.taxCode ?? '—'}
              </td>
              <td className="px-3 py-2 text-right font-medium">{formatAmount(l.amountInclTax)}</td>
              <td className="px-3 py-2 min-w-[180px]">
                {l.suggestedAccountCode ? (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-xs font-semibold">
                        {l.chosenAccountCode ?? l.suggestedAccountCode}
                      </span>
                      {l.suggestedTaxCodeB1 && (
                        <span className="text-[10px] bg-blue-50 text-blue-700 border border-blue-200 rounded px-1">
                          {l.suggestedTaxCodeB1}
                        </span>
                      )}
                    </div>
                    {!l.chosenAccountCode && (
                      <ConfidenceBar value={l.suggestedAccountConfidence} />
                    )}
                    {l.suggestionSource && !l.chosenAccountCode && (
                      <p className="text-[10px] text-muted-foreground leading-tight line-clamp-2" title={l.suggestionSource}>
                        {l.suggestionSource}
                      </p>
                    )}
                  </div>
                ) : (
                  <div>
                    <span className="text-muted-foreground">—</span>
                    {l.suggestionSource && (
                      <p className="text-[10px] text-amber-600 mt-0.5">{l.suggestionSource}</p>
                    )}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t bg-muted/30">
          <tr>
            <td colSpan={4} />
            <td className="px-3 py-2 text-right text-xs text-muted-foreground">
              {formatAmount(lines.reduce((s, l) => s + l.amountExclTax, 0))}
            </td>
            <td className="px-3 py-2 text-right text-xs text-muted-foreground">
              {formatAmount(lines.reduce((s, l) => s + l.taxAmount, 0))}
            </td>
            <td className="px-3 py-2 text-right font-semibold">
              {formatAmount(lines.reduce((s, l) => s + l.amountInclTax, 0))}
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function FilesTab({ files }: { files: InvoiceDetail['files'] }) {
  const KIND_ICON: Record<string, typeof FileText> = { PDF: FileText, XML: Tag, ATTACHMENT: Paperclip };

  if (files.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Aucun fichier attaché.</p>;
  }
  return (
    <div className="divide-y">
      {files.map((f) => {
        const Icon = KIND_ICON[f.kind] ?? Paperclip;
        const kb = Math.round(f.sizeBytes / 1024);
        return (
          <div key={f.id} className="flex items-center gap-3 px-4 py-3">
            <Icon className="h-5 w-5 text-muted-foreground flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{f.path.split('/').pop()}</p>
              <p className="text-xs text-muted-foreground font-mono truncate">{f.path}</p>
            </div>
            <div className="text-right flex-shrink-0 text-xs text-muted-foreground space-y-0.5">
              <p>{kb} Ko</p>
              <p className="font-mono">{f.kind}</p>
            </div>
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

  if (loading) return <div className="py-8 flex justify-center"><div className="h-5 w-5 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  if (entries.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">Aucune entrée d'audit pour cette facture.</p>;

  return (
    <div className="divide-y">
      {entries.map((e) => (
        <div key={e.id} className={`flex items-start gap-3 px-4 py-3 ${e.outcome === 'ERROR' ? 'bg-red-50/50' : ''}`}>
          {e.outcome === 'OK'
            ? <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0 mt-0.5" />
            : <XCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
          }
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold">{ACTION_LABELS[e.action] ?? e.action}</span>
              {e.sapUser && <span className="text-[10px] text-muted-foreground">par {e.sapUser}</span>}
            </div>
            <p className={`text-xs ${e.outcome === 'ERROR' ? 'text-destructive' : 'text-foreground'}`}>{e.summary}</p>
            {e.outcome === 'ERROR' && e.errorMessage && (
              <p className="text-[10px] text-destructive/80">{e.errorMessage}</p>
            )}
            {(Boolean(e.payloadBefore) || Boolean(e.payloadAfter)) && (
              <details className="text-[10px] text-muted-foreground font-mono">
                <summary className="cursor-pointer hover:text-foreground">Voir le détail</summary>
                <div className="mt-1 rounded border bg-muted/30 p-2 space-y-2">
                  {Boolean(e.payloadBefore) && (
                    <div>
                      <p className="text-[9px] uppercase tracking-wide text-muted-foreground mb-1">Avant</p>
                      <pre className="whitespace-pre-wrap break-words">{String(JSON.stringify(e.payloadBefore, null, 2))}</pre>
                    </div>
                  )}
                  {Boolean(e.payloadAfter) && (
                    <div>
                      <p className="text-[9px] uppercase tracking-wide text-muted-foreground mb-1">Après</p>
                      <pre className="whitespace-pre-wrap break-words">{String(JSON.stringify(e.payloadAfter, null, 2))}</pre>
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
  const [activeTab, setActiveTab] = useState<TabId>('lines');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [postResult, setPostResult] = useState<{ sapDocEntry: number; sapDocNum: number; simulate: boolean } | null>(null);
  const [integrationMode, setIntegrationMode] = useState<IntegrationMode>('SERVICE_INVOICE');
  const [simulate, setSimulate] = useState(false);
  // Reject
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [rejectError, setRejectError] = useState<string | null>(null);
  // Send status PA
  const [sendingStatus, setSendingStatus] = useState(false);
  const [sendStatusError, setSendStatusError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    apiGetInvoice(id)
      .then(setInvoice)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Erreur'))
      .finally(() => setLoading(false));
  }, [id]);

  const reloadInvoice = useCallback(async () => {
    if (!id) return;
    const updated = await apiGetInvoice(id);
    setInvoice(updated);
  }, [id]);

  async function handlePost() {
    if (!id) return;
    setPosting(true);
    setPostError(null);
    setPostResult(null);
    try {
      const result = await apiPostInvoice(id, { integrationMode, simulate });
      setPostResult({ sapDocEntry: result.sapDocEntry, sapDocNum: result.sapDocNum, simulate: result.simulate });
      await reloadInvoice();
    } catch (err: unknown) {
      setPostError(err instanceof Error ? err.message : 'Erreur lors de l\'intégration');
    } finally {
      setPosting(false);
    }
  }

  async function handleReject() {
    if (!id || rejectReason.trim().length === 0) return;
    setRejecting(true);
    setRejectError(null);
    try {
      await apiRejectInvoice(id, rejectReason.trim());
      setShowReject(false);
      setRejectReason('');
      await reloadInvoice();
    } catch (err: unknown) {
      setRejectError(err instanceof Error ? err.message : 'Erreur lors du rejet');
    } finally {
      setRejecting(false);
    }
  }

  async function handleSendStatus() {
    if (!id) return;
    setSendingStatus(true);
    setSendStatusError(null);
    try {
      await apiSendStatus(id);
      await reloadInvoice();
    } catch (err: unknown) {
      setSendStatusError(err instanceof Error ? err.message : 'Erreur lors de l\'envoi du statut');
    } finally {
      setSendingStatus(false);
    }
  }

  if (loading) return <PageLoader />;

  if (error || !invoice) {
    return (
      <div className="p-6">
        <Link to="/invoices" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="h-4 w-4" /> Retour
        </Link>
        <div className="rounded-md bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {error ?? 'Facture introuvable.'}
        </div>
      </div>
    );
  }

  const isPosted = invoice.status === 'POSTED';
  const isError = invoice.status === 'ERROR';

  return (
    <div className="p-6 space-y-5">
      {/* Breadcrumb */}
      <Link to="/invoices" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Retour aux factures
      </Link>

      {/* Title + status */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-foreground">{invoice.supplierNameRaw}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {invoice.docNumberPa} · reçue le {formatDate(invoice.receivedAt)}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <StatusBadge status={invoice.status} />
          {['NEW', 'TO_REVIEW', 'READY'].includes(invoice.status) && (
            <Button variant="outline" size="sm" onClick={() => setShowReject(true)} className="text-destructive border-destructive/30 hover:bg-destructive/10">
              <Ban className="h-3.5 w-3.5 mr-1" /> Rejeter
            </Button>
          )}
        </div>
      </div>

      {/* Reject modal */}
      {showReject && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-background rounded-lg shadow-xl w-full max-w-md space-y-4 p-6">
            <h2 className="text-base font-semibold flex items-center gap-2">
              <Ban className="h-4 w-4 text-destructive" /> Rejeter la facture
            </h2>
            <p className="text-sm text-muted-foreground">Le motif est obligatoire et sera enregistré dans l'audit log.</p>
            <textarea
              className="w-full border rounded-md px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-destructive/40"
              rows={4}
              placeholder="Motif du rejet…"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              disabled={rejecting}
            />
            {rejectError && (
              <div className="text-xs text-destructive flex items-start gap-1.5">
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /> {rejectError}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => { setShowReject(false); setRejectReason(''); setRejectError(null); }} disabled={rejecting}>
                Annuler
              </Button>
              <Button size="sm" variant="destructive" onClick={handleReject} disabled={rejecting || rejectReason.trim().length === 0}>
                {rejecting ? 'Rejet en cours…' : 'Confirmer le rejet'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 2-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Left — invoice info */}
        <div className="lg:col-span-2 space-y-5">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Informations document</CardTitle>
            </CardHeader>
            <CardContent>
              <InfoRow label="Fournisseur (PA)" value={invoice.supplierNameRaw} />
              <InfoRow label="Identifiant PA" value={<span className="font-mono text-xs">{invoice.supplierPaIdentifier}</span>} />
              {invoice.supplierB1Cardcode && (
                <InfoRow label="CardCode SAP" value={<span className="font-mono text-xs">{invoice.supplierB1Cardcode}</span>} />
              )}
              <InfoRow label="N° document PA" value={<span className="font-mono text-xs">{invoice.docNumberPa}</span>} />
              <InfoRow label="Date document" value={formatDate(invoice.docDate)} />
              {invoice.dueDate && <InfoRow label="Échéance" value={formatDate(invoice.dueDate)} />}
              <InfoRow label="Devise" value={invoice.currency} />
              <InfoRow label="Format" value={invoice.format} />
              <InfoRow label="Source PA" value={invoice.paSource} />
            </CardContent>
          </Card>

          {/* Montants */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Montants</CardTitle>
            </CardHeader>
            <CardContent>
              <InfoRow label="Total HT" value={formatAmount(invoice.totalExclTax, invoice.currency)} />
              <InfoRow label="Total TVA" value={formatAmount(invoice.totalTax, invoice.currency)} />
              <div className="flex items-center justify-between py-2 gap-4">
                <span className="text-sm font-semibold">Total TTC</span>
                <span className="text-lg font-bold">{formatAmount(invoice.totalInclTax, invoice.currency)}</span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right — SAP + matching */}
        <div className="space-y-5">
          {/* SAP Integration */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Intégration SAP B1</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                {isPosted ? (
                  <CheckCircle2 className="h-5 w-5 text-green-500" />
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
                <InfoRow label="DocEntry" value={<span className="font-mono text-xs">{invoice.sapDocEntry}</span>} />
              )}
              {invoice.sapDocNum && (
                <InfoRow label="DocNum" value={<span className="font-mono text-xs">{invoice.sapDocNum}</span>} />
              )}
              {invoice.integrationMode && (
                <InfoRow label="Mode" value={invoice.integrationMode} />
              )}
              {invoice.statusReason && (
                <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
                  {invoice.statusReason}
                </div>
              )}

              {/* Posting UI — visible only if READY and supplier resolved */}
              {(invoice.status === 'READY' || invoice.status === 'TO_REVIEW') && invoice.supplierB1Cardcode && !postResult && (
                <div className="pt-2 space-y-3 border-t mt-2">
                  <div className="space-y-1.5">
                    <label className="text-xs text-muted-foreground font-medium">Mode d'intégration</label>
                    <select
                      className="w-full text-xs border rounded-md px-2 py-1.5 bg-background"
                      value={integrationMode}
                      onChange={(e) => setIntegrationMode(e.target.value as IntegrationMode)}
                      disabled={posting}
                    >
                      <option value="SERVICE_INVOICE">Facture d'achat (Service)</option>
                      <option value="JOURNAL_ENTRY">Écriture comptable</option>
                    </select>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={simulate}
                      onChange={(e) => setSimulate(e.target.checked)}
                      disabled={posting}
                      className="rounded"
                    />
                    Mode simulation (sans appel SAP réel)
                  </label>
                  {postError && (
                    <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive flex items-start gap-1.5">
                      <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                      {postError}
                    </div>
                  )}
                  <Button
                    className="w-full"
                    size="sm"
                    onClick={handlePost}
                    disabled={posting}
                  >
                    <Send className="h-4 w-4 mr-1.5" />
                    {posting ? 'Intégration en cours…' : 'Intégrer dans SAP B1'}
                  </Button>
                </div>
              )}

              {/* Success banner */}
              {postResult && (
                <div className="rounded-md bg-green-50 border border-green-200 px-3 py-2 text-xs text-green-800 space-y-0.5">
                  <p className="font-semibold flex items-center gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {postResult.simulate ? 'Simulation réussie' : 'Intégrée dans SAP B1'}
                  </p>
                  <p>DocEntry : <span className="font-mono">{postResult.sapDocEntry}</span></p>
                  <p>DocNum : <span className="font-mono">{postResult.sapDocNum}</span></p>
                </div>
              )}

              {/* Retour statut PA */}
              {['POSTED', 'REJECTED'].includes(invoice.status) && (
                <div className="pt-2 border-t mt-2 space-y-2">
                  {invoice.paStatusSentAt ? (
                    <div className="rounded-md bg-teal-50 border border-teal-200 px-3 py-2 text-xs text-teal-800 flex items-center gap-1.5">
                      <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
                      Statut retourné à la PA le {formatDate(invoice.paStatusSentAt)}
                    </div>
                  ) : (
                    <>
                      {sendStatusError && (
                        <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive flex items-start gap-1.5">
                          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                          {sendStatusError}
                        </div>
                      )}
                      <Button variant="outline" size="sm" className="w-full" onClick={handleSendStatus} disabled={sendingStatus}>
                        <Send className="h-3.5 w-3.5 mr-1.5" />
                        {sendingStatus ? 'Envoi en cours…' : 'Retourner statut à la PA'}
                      </Button>
                    </>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Matching fournisseur */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Matching fournisseur</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-2">Score de confiance</p>
              <ConfidenceBar value={invoice.supplierMatchConfidence} />
              {!invoice.supplierB1Cardcode && (
                <p className="mt-3 text-xs text-amber-600 bg-amber-50 rounded-md px-2 py-1.5 border border-amber-200">
                  Fournisseur non résolu dans SAP B1
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Tabs: Lignes / Fichiers / Audit */}
      <Card>
        <div className="border-b px-4">
          <nav className="flex gap-0 -mb-px">
            {([
              { id: 'lines' as TabId, label: `Lignes (${invoice.lines.length})` },
              { id: 'files' as TabId, label: `Fichiers (${invoice.files.length})` },
              { id: 'audit' as TabId, label: 'Audit', icon: <ScrollText className="h-3.5 w-3.5 inline mr-1" /> },
            ]).map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors flex items-center ${
                  activeTab === tab.id
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {'icon' in tab ? tab.icon : null}{tab.label}
              </button>
            ))}
          </nav>
        </div>
        <div>
          {activeTab === 'lines' && <LinesTab lines={invoice.lines} />}
          {activeTab === 'files' && <FilesTab files={invoice.files} />}
          {activeTab === 'audit' && id && <AuditTab invoiceId={id} />}
        </div>
      </Card>
    </div>
  );
}
