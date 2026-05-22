import { describe, expect, it } from 'vitest';
import {
  assertLitigeStatusOk,
  assertLiftLitigeStatusOk,
  canLiftLitige,
  canPutInLitige,
  DISPUTABLE_STATUSES,
  LITIGE_MIN_MOTIF_LENGTH,
  validateLitigeMotif,
} from '../../apps/api/src/services/litige.service';
import { buildPaStatusPayload } from '@pa-sap-bridge/database';

describe('litige.service — validation du motif', () => {
  it('rejette un motif vide', () => {
    expect(validateLitigeMotif('')).toEqual({ kind: 'INVALID_MOTIF', reason: 'EMPTY' });
  });

  it('rejette un motif uniquement whitespace', () => {
    expect(validateLitigeMotif('     ')).toEqual({ kind: 'INVALID_MOTIF', reason: 'EMPTY' });
  });

  it('rejette un motif trop court', () => {
    expect(validateLitigeMotif('court')).toEqual({ kind: 'INVALID_MOTIF', reason: 'TOO_SHORT' });
  });

  it(`accepte un motif d'au moins ${LITIGE_MIN_MOTIF_LENGTH} caractères`, () => {
    expect(validateLitigeMotif('Motif valide pour test')).toBeNull();
  });
});

describe('litige.service — transitions de statut', () => {
  it('autorise les statuts actifs non-terminaux pour la mise en litige', () => {
    for (const status of DISPUTABLE_STATUSES) {
      expect(canPutInLitige(status)).toBe(true);
      expect(assertLitigeStatusOk(status)).toBeNull();
    }
  });

  it('refuse la mise en litige depuis un statut terminal', () => {
    for (const status of ['POSTED', 'LINKED', 'REJECTED', 'DISPUTED', 'ERROR']) {
      expect(canPutInLitige(status)).toBe(false);
      const err = assertLitigeStatusOk(status);
      expect(err?.kind).toBe('INVALID_STATUS');
    }
  });

  it('n’autorise la levée du litige que depuis DISPUTED', () => {
    expect(canLiftLitige('DISPUTED')).toBe(true);
    expect(assertLiftLitigeStatusOk('DISPUTED')).toBeNull();
    for (const status of ['NEW', 'TO_REVIEW', 'READY', 'POSTED', 'LINKED', 'REJECTED', 'ERROR']) {
      expect(canLiftLitige(status)).toBe(false);
      expect(assertLiftLitigeStatusOk(status)?.kind).toBe('INVALID_STATUS');
    }
  });
});

describe('pa-status payload — mapping DISPUTED → IN_DISPUTE et override RECEIVED', () => {
  it('mappe DISPUTED sur IN_DISPUTE et utilise litigeMotif comme reason', () => {
    const payload = buildPaStatusPayload({
      paMessageId: 'MSG-DISP-1',
      docNumberPa: 'DOC-DISP-1',
      paSource: 'TEST',
      status: 'DISPUTED',
      statusReason: null,
      sapDocEntry: null,
      sapDocNum: null,
      litigeMotif: 'Désaccord sur les quantités livrées',
    });
    expect(payload.outcome).toBe('IN_DISPUTE');
    expect(payload.reason).toBe('Désaccord sur les quantités livrées');
  });

  it('force RECEIVED via outcomeOverride lors d’une levée de litige', () => {
    const payload = buildPaStatusPayload(
      {
        paMessageId: 'MSG-DISP-2',
        docNumberPa: 'DOC-DISP-2',
        paSource: 'TEST',
        status: 'TO_REVIEW',
        statusReason: null,
        sapDocEntry: null,
        sapDocNum: null,
      },
      'RECEIVED',
    );
    expect(payload.outcome).toBe('RECEIVED');
  });
});
