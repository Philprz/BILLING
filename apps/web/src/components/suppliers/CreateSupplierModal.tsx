import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AlertCircle, BookmarkPlus } from 'lucide-react';
import { Button } from '../ui/button';
import type { SupplierCache } from '../../api/suppliers.api';

// ── Zod schema ─────────────────────────────────────────────────────────────────

export const supplierSchema = z.object({
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
export type SupplierForm = z.infer<typeof supplierSchema>;

/**
 * Calcule le prochain CardCode fournisseur disponible (format F00001, F00002…)
 * à partir des fournisseurs déjà chargés.
 */
export function nextSupplierCardCode(suppliers: SupplierCache[]): string {
  const max = suppliers.reduce((current, supplier) => {
    const match = /^F(\d+)$/i.exec(supplier.cardcode);
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return `F${String(max + 1).padStart(5, '0')}`;
}

// ── FieldRow ───────────────────────────────────────────────────────────────────

export function FieldRow({
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

// ── CreateSupplierModal ─────────────────────────────────────────────────────────

interface CreateSupplierModalProps {
  initialValues?: Partial<SupplierForm>;
  onConfirm: (data: SupplierForm) => Promise<void>;
  onClose: () => void;
}

export function CreateSupplierModal({
  initialValues,
  onConfirm,
  onClose,
}: CreateSupplierModalProps) {
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
