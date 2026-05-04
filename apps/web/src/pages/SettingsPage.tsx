import { useEffect, useState, useCallback } from 'react';
import {
  Settings2,
  Save,
  AlertCircle,
  CheckCircle2,
  Pencil,
  X,
  Wifi,
  WifiOff,
  RefreshCw,
} from 'lucide-react';
import {
  apiGetSettings,
  apiPutSetting,
  apiTestSap,
  SETTING_META,
  type SettingRow,
} from '../api/settings.api';
import {
  apiSyncSapChartOfAccounts,
  apiSyncSapVatCodes,
  apiCreateSapUdfPaRef,
  type SapChartSyncResult,
} from '../api/sap.api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { formatDate } from '../lib/utils';

const INTEGRATION_MODES = [
  { value: 'SERVICE_INVOICE', label: "Facture d'achat (Service)" },
  { value: 'JOURNAL_ENTRY', label: 'Écriture comptable' },
];

function valueToDisplay(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  const meta = SETTING_META[key];
  if (!meta) return String(value);
  if (meta.type === 'json') return JSON.stringify(value, null, 2);
  if (meta.type === 'select') {
    const found = INTEGRATION_MODES.find((m) => m.value === value);
    return found ? found.label : String(value);
  }
  return String(value);
}

function valueToEdit(key: string, value: unknown): string {
  if (value === null || value === undefined) return '';
  const meta = SETTING_META[key];
  if (meta?.type === 'json') return JSON.stringify(value, null, 2);
  return String(value);
}

function parseEditedValue(key: string, raw: string): unknown {
  const meta = SETTING_META[key];
  if (!meta) return raw;
  if (meta.type === 'number') {
    const n = Number(raw);
    return isNaN(n) ? raw : n;
  }
  if (meta.type === 'json') return JSON.parse(raw);
  return raw;
}

interface SettingEditorProps {
  row: SettingRow;
  onSaved: (updated: SettingRow) => void;
}

function SettingEditor({ row, onSaved }: SettingEditorProps) {
  const meta = SETTING_META[row.key];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function startEdit() {
    setDraft(valueToEdit(row.key, row.value));
    setError(null);
    setSaved(false);
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const parsed = parseEditedValue(row.key, draft);
      const updated = await apiPutSetting(row.key, parsed);
      onSaved(updated);
      setSaved(true);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de sauvegarde');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-b border-border/70 py-4 last:border-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{meta?.label ?? row.key}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{meta?.description ?? row.key}</p>
          {row.updatedAt && (
            <p className="mt-1 text-[10px] text-muted-foreground/60">
              Modifié le {formatDate(row.updatedAt)}
            </p>
          )}
        </div>

        <div className="flex-shrink-0">
          {!editing && (
            <button
              onClick={startEdit}
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              title="Modifier"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <div className="mt-3 space-y-2">
          {meta?.type === 'select' ? (
            <select
              className="app-input h-9 text-xs"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={saving}
            >
              {INTEGRATION_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          ) : meta?.type === 'json' ? (
            <textarea
              className="app-textarea resize-none font-mono text-xs"
              rows={6}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={saving}
              spellCheck={false}
            />
          ) : (
            <input
              className="app-input h-9 text-xs"
              type={meta?.type === 'number' ? 'number' : 'text'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={saving}
              autoFocus
            />
          )}
          {error && (
            <p className="flex items-center gap-1.5 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" /> {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={saving}>
              <Save className="h-3.5 w-3.5 mr-1" />
              {saving ? 'Sauvegarde…' : 'Sauvegarder'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              disabled={saving}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          {meta?.type === 'json' ? (
            <pre className="flex-1 overflow-x-auto rounded-2xl border border-border/70 bg-card-muted/60 p-3 font-mono text-[11px] text-foreground">
              {valueToDisplay(row.key, row.value)}
            </pre>
          ) : (
            <span
              className={`font-mono text-sm font-semibold ${row.value == null ? 'text-muted-foreground' : 'text-foreground'}`}
            >
              {valueToDisplay(row.key, row.value)}
            </span>
          )}
          {saved && <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-success" />}
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const [rows, setRows] = useState<SettingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testingConn, setTestingConn] = useState(false);
  const [connResult, setConnResult] = useState<{ ok: boolean; ms: number } | null>(null);
  const [syncingChart, setSyncingChart] = useState(false);
  const [chartResult, setChartResult] = useState<SapChartSyncResult | null>(null);
  const [syncingVat, setSyncingVat] = useState(false);
  const [vatResult, setVatResult] = useState<{ imported: number; source: string } | null>(null);
  const [creatingUdf, setCreatingUdf] = useState(false);
  const [udfResult, setUdfResult] = useState<{ alreadyExists: boolean; fieldName: string } | null>(
    null,
  );
  const [udfError, setUdfError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGetSettings();
      setRows(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function handleSaved(updated: SettingRow) {
    setRows((prev) => prev.map((r) => (r.key === updated.key ? updated : r)));
  }

  async function handleTestSap() {
    setTestingConn(true);
    setConnResult(null);
    try {
      const result = await apiTestSap();
      setConnResult(result);
    } catch {
      setConnResult({ ok: false, ms: 0 });
    } finally {
      setTestingConn(false);
    }
  }

  async function handleSyncVat() {
    setSyncingVat(true);
    setVatResult(null);
    try {
      const result = await apiSyncSapVatCodes();
      setVatResult(result);
    } finally {
      setSyncingVat(false);
    }
  }

  async function handleCreateUdfPaRef() {
    setCreatingUdf(true);
    setUdfResult(null);
    setUdfError(null);
    try {
      const result = await apiCreateSapUdfPaRef();
      setUdfResult(result);
    } catch (err) {
      setUdfError(err instanceof Error ? err.message : 'Erreur lors de la création du champ');
    } finally {
      setCreatingUdf(false);
    }
  }

  async function handleSyncChart() {
    setSyncingChart(true);
    setChartResult(null);
    try {
      const result = await apiSyncSapChartOfAccounts();
      setChartResult(result);
    } finally {
      setSyncingChart(false);
    }
  }

  const integrationRows = rows.filter((r) =>
    ['DEFAULT_INTEGRATION_MODE', 'DEFAULT_SAP_SERIES', 'AUTO_VALIDATION_THRESHOLD'].includes(r.key),
  );
  const accountingRows = rows.filter((r) =>
    [
      'TAX_RATE_MAPPING',
      'AP_TAX_ACCOUNT_MAP',
      'AP_ACCOUNT_CODE',
      'DEFAULT_ENERGY_ACCOUNT_CODE',
      'DEFAULT_MAINTENANCE_ACCOUNT_CODE',
      'DEFAULT_HOSTING_ACCOUNT_CODE',
      'DEFAULT_SUPPLIES_ACCOUNT_CODE',
    ].includes(r.key),
  );
  const systemRows = rows.filter((r) =>
    ['SESSION_DURATION_MINUTES', 'AMOUNT_GAP_ALERT_THRESHOLD'].includes(r.key),
  );

  return (
    <div className="app-page">
      <div className="page-header">
        <div>
          <p className="page-eyebrow">Administration</p>
          <h1 className="page-title">Paramètres</h1>
          <p className="page-subtitle">Configuration de la plateforme PA-SAP Bridge</p>
        </div>
      </div>

      {error && (
        <div className="alert-error">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-12" role="status" aria-label="Chargement…">
          <div
            className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"
            aria-hidden="true"
          />
        </div>
      ) : (
        <div className="space-y-5">
          {/* Intégration */}
          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="font-display text-xl uppercase tracking-[0.08em] flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-primary" />
                Intégration
              </CardTitle>
            </CardHeader>
            <CardContent>
              {integrationRows.map((r) => (
                <SettingEditor key={r.key} row={r} onSaved={handleSaved} />
              ))}
            </CardContent>
          </Card>

          {/* Comptabilité */}
          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="font-display text-xl uppercase tracking-[0.08em] flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-primary" />
                Comptabilité SAP B1
              </CardTitle>
            </CardHeader>
            <CardContent>
              {accountingRows.map((r) => (
                <SettingEditor key={r.key} row={r} onSaved={handleSaved} />
              ))}
            </CardContent>
          </Card>

          {/* Système */}
          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="font-display text-xl uppercase tracking-[0.08em] flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-primary" />
                Système
              </CardTitle>
            </CardHeader>
            <CardContent>
              {systemRows.map((r) => (
                <SettingEditor key={r.key} row={r} onSaved={handleSaved} />
              ))}
            </CardContent>
          </Card>

          {/* Test connexion SAP */}
          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="font-display text-xl uppercase tracking-[0.08em] flex items-center gap-2">
                <Wifi className="h-4 w-4 text-primary" />
                Connexion SAP B1
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground mb-3">
                Vérifie que le Service Layer SAP B1 est joignable avec la session en cours.
              </p>
              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void handleTestSap();
                  }}
                  disabled={testingConn}
                >
                  {testingConn ? (
                    <>
                      <div className="h-3.5 w-3.5 mr-1.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      Test en cours…
                    </>
                  ) : (
                    <>
                      <Wifi className="h-3.5 w-3.5 mr-1.5" />
                      Tester la connexion SAP B1
                    </>
                  )}
                </Button>
                {connResult && (
                  <div
                    className={`flex items-center gap-1.5 text-xs font-medium ${connResult.ok ? 'text-success' : 'text-destructive'}`}
                  >
                    {connResult.ok ? (
                      <>
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Connexion OK ({connResult.ms} ms)
                      </>
                    ) : (
                      <>
                        <WifiOff className="h-3.5 w-3.5" />
                        SAP injoignable
                      </>
                    )}
                  </div>
                )}
              </div>
              <div className="mt-4 flex items-center gap-3 border-t border-border/70 pt-3">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void handleSyncChart();
                  }}
                  disabled={syncingChart}
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 mr-1.5 ${syncingChart ? 'animate-spin' : ''}`}
                  />
                  {syncingChart ? 'Synchronisation…' : 'Resynchroniser plan comptable SAP'}
                </Button>
                {chartResult && (
                  <div className="flex items-center gap-1.5 text-xs font-medium text-success">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {chartResult.imported} compte(s) importé(s) · {chartResult.activePostable}{' '}
                    actifs+imputables
                  </div>
                )}
              </div>
              <div className="mt-3 flex items-center gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void handleSyncVat();
                  }}
                  disabled={syncingVat}
                >
                  <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${syncingVat ? 'animate-spin' : ''}`} />
                  {syncingVat ? 'Synchronisation…' : 'Resynchroniser codes TVA SAP'}
                </Button>
                {vatResult && (
                  <div className="flex items-center gap-1.5 text-xs font-medium text-success">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {vatResult.imported} code(s) TVA · source : {vatResult.source}
                  </div>
                )}
              </div>
              <div className="mt-3 flex items-center gap-3 border-t border-border/70 pt-3">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void handleCreateUdfPaRef();
                  }}
                  disabled={creatingUdf}
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 mr-1.5 ${creatingUdf ? 'animate-spin' : ''}`}
                  />
                  {creatingUdf ? 'Création…' : 'Créer le champ U_PA_REF dans SAP B1'}
                </Button>
                {udfResult && (
                  <div className="flex items-center gap-1.5 text-xs font-medium text-success">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {udfResult.alreadyExists
                      ? `Champ ${udfResult.fieldName} déjà présent dans SAP B1`
                      : `Champ ${udfResult.fieldName} créé avec succès dans SAP B1 (table OPCH)`}
                  </div>
                )}
                {udfError && (
                  <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {udfError}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
