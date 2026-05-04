import { useEffect, useState } from 'react';
import {
  Plus,
  Pencil,
  Trash2,
  AlertCircle,
  ToggleLeft,
  ToggleRight,
  Wifi,
  HardDrive,
  CheckCircle2,
  Clock,
} from 'lucide-react';
import {
  apiGetPaChannels,
  apiCreatePaChannel,
  apiPatchPaChannel,
  apiDeletePaChannel,
  type PaChannel,
  type CreatePaChannelBody,
} from '../api/pa-channels.api';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { PageLoader } from '../components/ui/spinner';

// ── Modal state ──────────────────────────────────────────────────────────────

interface ModalState {
  mode: 'create' | 'edit';
  channel?: PaChannel;
  protocol: 'SFTP' | 'API';
  name: string;
  host: string;
  port: string;
  user: string;
  password: string;
  sshPublicKey: string;
  remotePathIn: string;
  remotePathProcessed: string;
  remotePathOut: string;
  apiBaseUrl: string;
  apiAuthType: 'BASIC' | 'API_KEY' | 'OAUTH2' | '';
  apiCredentials: string;
  pollIntervalSeconds: string;
  active: boolean;
}

function emptyModal(protocol: 'SFTP' | 'API' = 'SFTP'): ModalState {
  return {
    mode: 'create',
    protocol,
    name: '',
    host: '',
    port: '',
    user: '',
    password: '',
    sshPublicKey: '',
    remotePathIn: '',
    remotePathProcessed: '',
    remotePathOut: '',
    apiBaseUrl: '',
    apiAuthType: '',
    apiCredentials: '',
    pollIntervalSeconds: '60',
    active: true,
  };
}

function channelToModal(ch: PaChannel): ModalState {
  return {
    mode: 'edit',
    channel: ch,
    protocol: ch.protocol,
    name: ch.name,
    host: ch.host ?? '',
    port: ch.port !== null ? String(ch.port) : '',
    user: ch.user ?? '',
    password: '',
    sshPublicKey: ch.sshPublicKey ?? '',
    remotePathIn: ch.remotePathIn ?? '',
    remotePathProcessed: ch.remotePathProcessed ?? '',
    remotePathOut: ch.remotePathOut ?? '',
    apiBaseUrl: ch.apiBaseUrl ?? '',
    apiAuthType: (ch.apiAuthType as ModalState['apiAuthType']) ?? '',
    apiCredentials: '',
    pollIntervalSeconds: String(ch.pollIntervalSeconds),
    active: ch.active,
  };
}

// ── Label helpers ─────────────────────────────────────────────────────────────

const AUTH_LABELS: Record<string, string> = {
  BASIC: 'HTTP Basic',
  API_KEY: 'API Key',
  OAUTH2: 'OAuth 2',
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function PaChannelsPage() {
  const [channels, setChannels] = useState<PaChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [modal, setModal] = useState<ModalState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  async function load() {
    setLoadError(null);
    try {
      setChannels(await apiGetPaChannels());
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleToggleActive(ch: PaChannel) {
    try {
      const updated = await apiPatchPaChannel(ch.id, { active: !ch.active });
      setChannels((prev) => prev.map((c) => (c.id === ch.id ? updated : c)));
    } catch {
      // ignore — user sees no change
    }
  }

  async function handleSave() {
    if (!modal) return;
    setSaving(true);
    setSaveError(null);
    try {
      const body: CreatePaChannelBody = {
        name: modal.name.trim(),
        protocol: modal.protocol,
        host: modal.host.trim() || null,
        port: modal.port ? parseInt(modal.port, 10) : null,
        user: modal.user.trim() || null,
        password: modal.password || null,
        sshPublicKey: modal.sshPublicKey.trim() || null,
        remotePathIn: modal.remotePathIn.trim() || null,
        remotePathProcessed: modal.remotePathProcessed.trim() || null,
        remotePathOut: modal.remotePathOut.trim() || null,
        apiBaseUrl: modal.apiBaseUrl.trim() || null,
        apiAuthType: (modal.apiAuthType as CreatePaChannelBody['apiAuthType']) || null,
        apiCredentials: modal.apiCredentials || null,
        pollIntervalSeconds: parseInt(modal.pollIntervalSeconds, 10) || 60,
        active: modal.active,
      };

      if (modal.mode === 'create') {
        const created = await apiCreatePaChannel(body);
        setChannels((prev) => [...prev, created]);
      } else {
        const { protocol: _p, ...patch } = body;
        const updated = await apiPatchPaChannel(modal.channel!.id, patch);
        setChannels((prev) => prev.map((c) => (c.id === modal.channel!.id ? updated : c)));
      }
      setModal(null);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Erreur lors de la sauvegarde');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      await apiDeletePaChannel(id);
      setChannels((prev) => prev.filter((c) => c.id !== id));
    } catch {
      // ignore
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  }

  if (loading) return <PageLoader />;

  if (loadError) {
    return (
      <div className="app-page">
        <div className="alert-error">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          {loadError}
        </div>
      </div>
    );
  }

  return (
    <div className="app-page">
      {/* Header */}
      <section className="page-header">
        <div>
          <p className="page-eyebrow">Configuration</p>
          <h2 className="page-title">Canaux PA</h2>
          <p className="page-subtitle">
            Points de collecte des factures fournisseurs (SFTP ou API).
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setSaveError(null);
            setModal(emptyModal());
          }}
        >
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Nouveau canal
        </Button>
      </section>

      {/* List */}
      {channels.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Aucun canal configuré.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {channels.map((ch) => (
            <Card key={ch.id} className={ch.active ? '' : 'opacity-60'}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {ch.protocol === 'SFTP' ? (
                      <HardDrive className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <Wifi className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <CardTitle className="truncate text-base">{ch.name}</CardTitle>
                  </div>
                  <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-muted text-muted-foreground">
                    {ch.protocol}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="space-y-1 text-xs text-muted-foreground">
                {ch.protocol === 'SFTP' ? (
                  <>
                    {ch.host && (
                      <p>
                        Hôte :{' '}
                        <span className="text-foreground">
                          {ch.host}
                          {ch.port ? `:${ch.port}` : ''}
                        </span>
                      </p>
                    )}
                    {ch.user && (
                      <p>
                        Utilisateur : <span className="text-foreground">{ch.user}</span>
                      </p>
                    )}
                    {ch.remotePathIn && (
                      <p>
                        Dossier entrant :{' '}
                        <span className="text-foreground font-mono">{ch.remotePathIn}</span>
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    {ch.apiBaseUrl && (
                      <p>
                        URL : <span className="text-foreground break-all">{ch.apiBaseUrl}</span>
                      </p>
                    )}
                    {ch.apiAuthType && (
                      <p>
                        Auth :{' '}
                        <span className="text-foreground">
                          {AUTH_LABELS[ch.apiAuthType] ?? ch.apiAuthType}
                        </span>
                      </p>
                    )}
                  </>
                )}
                <p>
                  Polling : <span className="text-foreground">{ch.pollIntervalSeconds}s</span>
                </p>

                {/* Statut dernier poll */}
                {ch.lastPollAt && (
                  <div
                    className={`flex items-start gap-1.5 rounded-lg px-2 py-1.5 text-[11px] ${
                      ch.lastPollError
                        ? 'bg-destructive/10 text-destructive'
                        : 'bg-success/10 text-success'
                    }`}
                  >
                    {ch.lastPollError ? (
                      <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                    ) : (
                      <CheckCircle2 className="h-3 w-3 mt-0.5 shrink-0" />
                    )}
                    <span className="break-words min-w-0">
                      {ch.lastPollError ?? 'OK'}{' '}
                      <span className="opacity-60">
                        {new Date(ch.lastPollAt).toLocaleString('fr-FR', {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                      </span>
                    </span>
                  </div>
                )}
                {!ch.lastPollAt && (
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Clock className="h-3 w-3" /> Jamais interrogé
                  </div>
                )}

                <div className="flex items-center justify-between pt-3">
                  <button
                    onClick={() => handleToggleActive(ch)}
                    className="flex items-center gap-1.5 text-xs hover:text-foreground transition-colors"
                    title={ch.active ? 'Désactiver' : 'Activer'}
                  >
                    {ch.active ? (
                      <ToggleRight className="h-4 w-4 text-success" />
                    ) : (
                      <ToggleLeft className="h-4 w-4" />
                    )}
                    {ch.active ? 'Actif' : 'Inactif'}
                  </button>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      onClick={() => {
                        setSaveError(null);
                        setModal(channelToModal(ch));
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    {confirmDeleteId === ch.id ? (
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-7 px-2 text-xs"
                          disabled={deletingId === ch.id}
                          onClick={() => handleDelete(ch.id)}
                        >
                          Confirmer
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          Annuler
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                        onClick={() => setConfirmDeleteId(ch.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Modal */}
      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-lg border border-border bg-background shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <h3 className="font-semibold text-foreground">
                {modal.mode === 'create' ? 'Nouveau canal PA' : `Modifier — ${modal.channel?.name}`}
              </h3>
              <button
                onClick={() => setModal(null)}
                className="text-muted-foreground hover:text-foreground transition-colors text-xl leading-none"
              >
                ×
              </button>
            </div>

            <div className="max-h-[70vh] overflow-y-auto px-6 py-4 space-y-4">
              {saveError && (
                <div className="alert-error text-sm">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  {saveError}
                </div>
              )}

              {/* Nom */}
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Nom *
                </label>
                <input
                  className="input w-full"
                  value={modal.name}
                  onChange={(e) => setModal((m) => m && { ...m, name: e.target.value })}
                  placeholder="Ex. : SFTP Fournisseur A"
                />
              </div>

              {/* Connexion SFTP */}
              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  Connexion SFTP
                </p>
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2 space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Hôte</label>
                    <input
                      className="input w-full"
                      value={modal.host}
                      onChange={(e) => setModal((m) => m && { ...m, host: e.target.value })}
                      placeholder="sftp.exemple.com"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Port</label>
                    <input
                      className="input w-full"
                      type="number"
                      value={modal.port}
                      onChange={(e) => setModal((m) => m && { ...m, port: e.target.value })}
                      placeholder="22"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Utilisateur</label>
                    <input
                      className="input w-full"
                      value={modal.user}
                      onChange={(e) => setModal((m) => m && { ...m, user: e.target.value })}
                      placeholder="user"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">
                      Mot de passe
                    </label>
                    <input
                      className="input w-full"
                      type="password"
                      value={modal.password}
                      onChange={(e) => setModal((m) => m && { ...m, password: e.target.value })}
                      placeholder={modal.mode === 'edit' ? '(inchangé si vide)' : ''}
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Clé publique SSH du connecteur
                  </label>
                  <textarea
                    className="input w-full font-mono text-xs leading-relaxed"
                    rows={3}
                    value={modal.sshPublicKey}
                    onChange={(e) => setModal((m) => m && { ...m, sshPublicKey: e.target.value })}
                    placeholder="ssh-rsa AAAA... (à ajouter dans authorized_keys du serveur distant)"
                    spellCheck={false}
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
              <Button variant="outline" onClick={() => setModal(null)} disabled={saving}>
                Annuler
              </Button>
              <Button onClick={handleSave} disabled={saving || !modal.name.trim()}>
                {saving ? 'Enregistrement…' : modal.mode === 'create' ? 'Créer' : 'Enregistrer'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
