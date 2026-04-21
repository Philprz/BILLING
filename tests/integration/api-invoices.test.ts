import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@pa-sap-bridge/database';
import { buildAuthenticatedApp } from '../helpers/http';
import { createTestInvoice, deleteInvoicesByIds } from '../helpers/fixtures';

describe.sequential('API invoice integration', () => {
  const createdIds: string[] = [];
  let app: Awaited<ReturnType<typeof buildAuthenticatedApp>>['app'];
  let cookieHeader: string;

  beforeAll(async () => {
    const built = await buildAuthenticatedApp('integration.user');
    app = built.app;
    cookieHeader = built.cookieHeader;
  });

  afterAll(async () => {
    await deleteInvoicesByIds(createdIds);
    await app.close();
  });

  it('requires authentication on invoice detail', async () => {
    const invoiceId = await createTestInvoice({ status: 'READY', paSource: 'TEST_INT' });
    createdIds.push(invoiceId);

    const response = await app.inject({
      method: 'GET',
      url: `/api/invoices/${invoiceId}`,
    });

    expect(response.statusCode).toBe(401);
  });

  it('loads an invoice detail and creates a VIEW_INVOICE audit entry', async () => {
    const invoiceId = await createTestInvoice({ status: 'READY', paSource: 'TEST_INT' });
    createdIds.push(invoiceId);

    const response = await app.inject({
      method: 'GET',
      url: `/api/invoices/${invoiceId}`,
      headers: { cookie: cookieHeader },
    });

    expect(response.statusCode).toBe(200);
    const audit = await prisma.auditLog.findFirst({
      where: { entityId: invoiceId, action: 'VIEW_INVOICE' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit?.outcome).toBe('OK');
  });

  it('rejects an invoice with a mandatory reason and writes an audit log', async () => {
    const invoiceId = await createTestInvoice({ status: 'TO_REVIEW', paSource: 'TEST_INT' });
    createdIds.push(invoiceId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/reject`,
      headers: {
        cookie: cookieHeader,
        'content-type': 'application/json',
      },
      payload: { reason: 'Rejet intégration test' },
    });

    expect(response.statusCode).toBe(200);

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('REJECTED');
    expect(invoice.statusReason).toBe('Rejet intégration test');

    const audit = await prisma.auditLog.findFirst({
      where: { entityId: invoiceId, action: 'REJECT' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit?.outcome).toBe('OK');
  });

  it('posts a READY invoice in simulate mode and then sends PA status manually', async () => {
    const invoiceId = await createTestInvoice({ status: 'READY', paSource: 'TEST_INT' });
    createdIds.push(invoiceId);

    const postResponse = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/post`,
      headers: {
        cookie: cookieHeader,
        'content-type': 'application/json',
      },
      payload: { integrationMode: 'SERVICE_INVOICE', simulate: true },
    });

    expect(postResponse.statusCode).toBe(200);

    const statusOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sap-status-manual-'));
    const previousStatusOut = process.env.STATUS_OUT_PATH;
    process.env.STATUS_OUT_PATH = statusOutDir;

    const sendStatusResponse = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/send-status`,
      headers: { cookie: cookieHeader },
    });

    process.env.STATUS_OUT_PATH = previousStatusOut;

    expect(sendStatusResponse.statusCode).toBe(200);
    expect(fs.readdirSync(statusOutDir).some((name) => name.startsWith('status_'))).toBe(true);

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('POSTED');
    expect(invoice.paStatusSentAt).not.toBeNull();

    const auditEntries = await prisma.auditLog.findMany({
      where: {
        entityId: invoiceId,
        action: { in: ['APPROVE', 'POST_SAP', 'SEND_STATUS_PA'] },
      },
    });
    expect(auditEntries.some((entry) => entry.action === 'APPROVE' && entry.outcome === 'OK')).toBe(true);
    expect(auditEntries.some((entry) => entry.action === 'POST_SAP' && entry.outcome === 'OK')).toBe(true);
    expect(auditEntries.some((entry) => entry.action === 'SEND_STATUS_PA' && entry.outcome === 'OK')).toBe(true);
  });
});
