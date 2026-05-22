import { buildPaStatusPayload, type PaStatusOutcome } from '@pa-sap-bridge/database';
import { deliverPaStatus, type DeliveryResult } from './pa-status-delivery';

export type { DeliveryResult };
export type { DeliveryMode } from './pa-status-delivery';

export interface SendPaStatusResult {
  payload: ReturnType<typeof buildPaStatusPayload>;
  deliveryMode: DeliveryResult['mode'];
  target: string;
}

export async function sendPaStatus(
  invoice: {
    id: string;
    paMessageId: string;
    docNumberPa: string;
    paSource: string;
    status: string;
    statusReason: string | null;
    sapDocEntry: number | null;
    sapDocNum: number | null;
    litigeMotif?: string | null;
  },
  outcomeOverride?: PaStatusOutcome,
): Promise<SendPaStatusResult> {
  const result = await deliverPaStatus(invoice, outcomeOverride);
  return {
    payload: result.payload,
    deliveryMode: result.mode,
    target: result.target,
  };
}
