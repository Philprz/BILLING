/**
 * Tests unitaires — échelle U_NOVA_Statut et consolidation « le plus avancé gagne »
 * (packages/database/src/nova-statut.ts). Logique pure, aucun mock nécessaire.
 */
import { describe, expect, it } from 'vitest';
import {
  NOVA_STATUT_SCALE,
  novaStatutRank,
  isNovaStatut,
  mapSapSettlementToNovaStatut,
  mapPaLifecycleToNovaStatut,
  consolidateNovaStatut,
} from '../../packages/database/src/nova-statut';

describe('échelle NOVA_STATUT', () => {
  it('est strictement ordonnée NON_PAYE<PROGRAMME<PARTIEL<PAYE<SOLDE', () => {
    expect(NOVA_STATUT_SCALE).toEqual(['NON_PAYE', 'PROGRAMME', 'PARTIEL', 'PAYE', 'SOLDE']);
    expect(novaStatutRank('NON_PAYE')).toBeLessThan(novaStatutRank('PROGRAMME'));
    expect(novaStatutRank('PROGRAMME')).toBeLessThan(novaStatutRank('PARTIEL'));
    expect(novaStatutRank('PARTIEL')).toBeLessThan(novaStatutRank('PAYE'));
    expect(novaStatutRank('PAYE')).toBeLessThan(novaStatutRank('SOLDE'));
  });

  it('reconnaît les valeurs valides et rejette le reste', () => {
    expect(isNovaStatut('SOLDE')).toBe(true);
    expect(isNovaStatut('INCONNU')).toBe(false);
    expect(isNovaStatut(null)).toBe(false);
    expect(novaStatutRank('INCONNU')).toBe(-1);
  });
});

describe('mapSapSettlementToNovaStatut', () => {
  it('poste plein ouvert (PaidToDate 0) → NON_PAYE', () => {
    expect(
      mapSapSettlementToNovaStatut({ docTotal: 1000, paidToDate: 0, documentStatus: 'bost_Open' }),
    ).toBe('NON_PAYE');
  });

  it('poste partiellement réglé → PARTIEL', () => {
    expect(
      mapSapSettlementToNovaStatut({
        docTotal: 1000,
        paidToDate: 400,
        documentStatus: 'bost_Open',
      }),
    ).toBe('PARTIEL');
  });

  it('poste réglé en totalité (PaidToDate ≥ DocTotal) → SOLDE', () => {
    expect(
      mapSapSettlementToNovaStatut({
        docTotal: 1000,
        paidToDate: 1000,
        documentStatus: 'bost_Open',
      }),
    ).toBe('SOLDE');
  });

  it('poste clos (bost_Close) → SOLDE même si PaidToDate non renseigné', () => {
    expect(
      mapSapSettlementToNovaStatut({ docTotal: 1000, paidToDate: 0, documentStatus: 'bost_Close' }),
    ).toBe('SOLDE');
  });

  it('ne produit jamais PROGRAMME ni PAYE (réservés à la PA)', () => {
    const sapValues = [
      mapSapSettlementToNovaStatut({ docTotal: 1000, paidToDate: 0 }),
      mapSapSettlementToNovaStatut({ docTotal: 1000, paidToDate: 500 }),
      mapSapSettlementToNovaStatut({ docTotal: 1000, paidToDate: 1000 }),
    ];
    expect(sapValues).not.toContain('PROGRAMME');
    expect(sapValues).not.toContain('PAYE');
  });
});

describe('mapPaLifecycleToNovaStatut', () => {
  it('mappe les libellés métier PA vers l’échelle', () => {
    expect(mapPaLifecycleToNovaStatut('PROGRAMMED')).toBe('PROGRAMME');
    expect(mapPaLifecycleToNovaStatut('paid')).toBe('PAYE');
    expect(mapPaLifecycleToNovaStatut('SETTLED')).toBe('SOLDE');
  });

  it('passe les valeurs déjà à l’échelle (idempotent)', () => {
    expect(mapPaLifecycleToNovaStatut('PAYE')).toBe('PAYE');
  });

  it('retourne null si non interprétable ou absent', () => {
    expect(mapPaLifecycleToNovaStatut(null)).toBeNull();
    expect(mapPaLifecycleToNovaStatut('???')).toBeNull();
  });
});

describe('consolidateNovaStatut — l’état le plus avancé gagne', () => {
  const t0 = new Date('2026-06-05T10:00:00.000Z');
  const t1 = new Date('2026-06-05T11:00:00.000Z');

  it('SAP plus avancé que PA → retient SAP', () => {
    const r = consolidateNovaStatut([
      { value: 'SOLDE', source: 'SAP', at: t1 },
      { value: 'PROGRAMME', source: 'PA', at: t0 },
    ]);
    expect(r).toEqual({ value: 'SOLDE', source: 'SAP', at: t1 });
  });

  it('PA plus avancé que SAP → retient PA (avec source + horodatage)', () => {
    const r = consolidateNovaStatut([
      { value: 'NON_PAYE', source: 'SAP', at: t1 },
      { value: 'PAYE', source: 'PA', at: t0 },
    ]);
    expect(r).toEqual({ value: 'PAYE', source: 'PA', at: t0 });
  });

  it('à rang égal, départage par horodatage le plus récent', () => {
    const r = consolidateNovaStatut([
      { value: 'PARTIEL', source: 'SAP', at: t0 },
      { value: 'PARTIEL', source: 'PA', at: t1 },
    ]);
    expect(r).toEqual({ value: 'PARTIEL', source: 'PA', at: t1 });
  });

  it('ignore les candidats invalides et retourne null si aucun valide', () => {
    expect(consolidateNovaStatut([null, undefined])).toBeNull();
  });
});
