import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSapPolicyConfig,
  getConfiguredSapPolicy,
  resolveSapExecutionPolicy,
} from '../../apps/api/src/services/sap-policy.service';

describe('sap-policy.service', () => {
  const previousEnv = {
    validationMode: process.env.SAP_VALIDATION_MODE,
    attachmentPolicy: process.env.SAP_ATTACHMENT_POLICY,
    postPolicy: process.env.SAP_POST_POLICY,
  };

  afterEach(() => {
    if (previousEnv.validationMode === undefined) delete process.env.SAP_VALIDATION_MODE;
    else process.env.SAP_VALIDATION_MODE = previousEnv.validationMode;

    if (previousEnv.attachmentPolicy === undefined) delete process.env.SAP_ATTACHMENT_POLICY;
    else process.env.SAP_ATTACHMENT_POLICY = previousEnv.attachmentPolicy;

    if (previousEnv.postPolicy === undefined) delete process.env.SAP_POST_POLICY;
    else process.env.SAP_POST_POLICY = previousEnv.postPolicy;
  });

  it('uses expected defaults', () => {
    delete process.env.SAP_VALIDATION_MODE;
    delete process.env.SAP_ATTACHMENT_POLICY;
    delete process.env.SAP_POST_POLICY;

    expect(getConfiguredSapPolicy()).toEqual({
      validationMode: 'live',
      attachmentPolicy: 'warn',
      postPolicy: 'real',
    });
  });

  it('resolves simulate execution from request override', () => {
    process.env.SAP_POST_POLICY = 'real';

    expect(resolveSapExecutionPolicy({ simulate: true })).toMatchObject({
      postPolicy: 'real',
      effectivePostPolicy: 'simulate',
      requestSimulate: true,
    });
  });

  it('keeps disabled post policy even when simulate is requested', () => {
    process.env.SAP_POST_POLICY = 'disabled';

    expect(resolveSapExecutionPolicy({ simulate: true })).toMatchObject({
      postPolicy: 'disabled',
      effectivePostPolicy: 'disabled',
    });
  });

  it('throws on invalid enum values', () => {
    process.env.SAP_ATTACHMENT_POLICY = 'maybe';

    expect(() => assertSapPolicyConfig()).toThrow(/SAP_ATTACHMENT_POLICY invalide/);
  });
});
