import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@pa-sap-bridge/database';
import { runPaStatusJob } from '../../apps/worker/src/jobs/pa-status-job';
import { buildAuthenticatedApp } from '../helpers/http';
import { createTestInvoice, deleteInvoicesByIds } from '../helpers/fixtures';

describe.sequential('local smoke e2e', () => {
  const createdIds: string[] = [];
  let app: Awaited<ReturnType<typeof buildAuthenticatedApp>>['app'];
  let cookieHeader: string;

  beforeAll(async () => {
    const built = await buildAuthenticatedApp('e2e.user');
    app = built.app;
    cookieHeader = built.cookieHeader;
  });

  afterAll(async () => {
    await deleteInvoicesByIds(createdIds);
    await app.close();
  });

  it('retries PA status after simulated worker failures and succeeds on recovery', async () => {
    const invoiceId = await createTestInvoice({ status: 'POSTED', paSource: 'TEST_E2E' });
    createdIds.push(invoiceId);

    const previousStatusOut = process.env.STATUS_OUT_PATH;
    const previousRetryDelays = process.env.PA_STATUS_RETRY_DELAYS_MS;

    const blockedPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sap-status-ko-')), 'blocked.txt');
    fs.writeFileSync(blockedPath, 'blocked', 'utf-8');
    process.env.STATUS_OUT_PATH = blockedPath;
    process.env.PA_STATUS_RETRY_DELAYS_MS = '0,0,0';

    await runPaStatusJob();
    await runPaStatusJob();

    let auditEntries = await prisma.auditLog.findMany({
      where: { entityId: invoiceId, action: 'SEND_STATUS_PA' },
      orderBy: { occurredAt: 'asc' },
    });

    expect(auditEntries.filter((entry) => entry.outcome === 'ERROR')).toHaveLength(2);

    const recoveredDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sap-status-ok-'));
    process.env.STATUS_OUT_PATH = recoveredDir;

    await runPaStatusJob();

    process.env.STATUS_OUT_PATH = previousStatusOut;
    process.env.PA_STATUS_RETRY_DELAYS_MS = previousRetryDelays;

    auditEntries = await prisma.auditLog.findMany({
      where: { entityId: invoiceId, action: 'SEND_STATUS_PA' },
      orderBy: { occurredAt: 'asc' },
    });

    expect(auditEntries.some((entry) => entry.outcome === 'OK')).toBe(true);
    expect(fs.readdirSync(recoveredDir).some((name) => name.startsWith('status_'))).toBe(true);

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.paStatusSentAt).not.toBeNull();

    const auditResponse = await app.inject({
      method: 'GET',
      url: `/api/audit?entityId=${invoiceId}&limit=20`,
      headers: { cookie: cookieHeader },
    });

    expect(auditResponse.statusCode).toBe(200);
    const items = auditResponse.json().data.items as Array<{ summary: string }>;
    expect(items.some((entry) => entry.summary.includes('Statut PA'))).toBe(true);
  });
});
