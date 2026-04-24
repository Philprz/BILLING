export type SapValidationMode = 'live';
export type SapAttachmentPolicy = 'strict' | 'warn' | 'skip';
export type SapPostPolicy = 'real' | 'simulate' | 'disabled';

export interface SapConfiguredPolicy {
  validationMode: SapValidationMode;
  attachmentPolicy: SapAttachmentPolicy;
  postPolicy: SapPostPolicy;
}

export interface SapExecutionPolicy extends SapConfiguredPolicy {
  requestSimulate: boolean;
  effectivePostPolicy: SapPostPolicy;
}

const SAP_VALIDATION_MODES: SapValidationMode[] = ['live'];
const SAP_ATTACHMENT_POLICIES: SapAttachmentPolicy[] = ['strict', 'warn', 'skip'];
const SAP_POST_POLICIES: SapPostPolicy[] = ['real', 'simulate', 'disabled'];

function parseEnumValue<T extends string>(
  rawValue: string | undefined,
  allowedValues: readonly T[],
  envName: string,
  fallback: T,
): T {
  const normalized = (rawValue ?? fallback).trim().toLowerCase() as T;
  if (allowedValues.includes(normalized)) {
    return normalized;
  }

  throw new Error(
    `${envName} invalide: "${rawValue}". Valeurs attendues: ${allowedValues.join(', ')}`,
  );
}

export function getConfiguredSapPolicy(): SapConfiguredPolicy {
  return {
    validationMode: parseEnumValue(
      process.env.SAP_VALIDATION_MODE,
      SAP_VALIDATION_MODES,
      'SAP_VALIDATION_MODE',
      'live',
    ),
    attachmentPolicy: parseEnumValue(
      process.env.SAP_ATTACHMENT_POLICY,
      SAP_ATTACHMENT_POLICIES,
      'SAP_ATTACHMENT_POLICY',
      'warn',
    ),
    postPolicy: parseEnumValue(
      process.env.SAP_POST_POLICY,
      SAP_POST_POLICIES,
      'SAP_POST_POLICY',
      'real',
    ),
  };
}

export function resolveSapExecutionPolicy(options?: { simulate?: boolean }): SapExecutionPolicy {
  const configured = getConfiguredSapPolicy();
  const requestSimulate = options?.simulate === true;

  let effectivePostPolicy: SapPostPolicy;
  if (configured.postPolicy === 'disabled') {
    effectivePostPolicy = 'disabled';
  } else if (requestSimulate || configured.postPolicy === 'simulate') {
    effectivePostPolicy = 'simulate';
  } else {
    effectivePostPolicy = 'real';
  }

  return {
    ...configured,
    requestSimulate,
    effectivePostPolicy,
  };
}

export function assertSapPolicyConfig(): void {
  void getConfiguredSapPolicy();
}
