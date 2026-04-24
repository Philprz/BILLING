import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@pa-sap-bridge/database';
import { buildAuthenticatedApp } from '../helpers/http';
import { createTestInvoice, deleteInvoicesByIds } from '../helpers/fixtures';

describe.sequential('API invoice integration', () => {
  const createdIds: string[] = [];
  let app: Awaited<ReturnType<typeof buildAuthenticatedApp>>['app'];
  let cookieHeader: string;
  const previousPolicyEnv = {
    validationMode: process.env.SAP_VALIDATION_MODE,
    attachmentPolicy: process.env.SAP_ATTACHMENT_POLICY,
    postPolicy: process.env.SAP_POST_POLICY,
    baseUrl: process.env.SAP_REST_BASE_URL,
  };

  beforeAll(async () => {
    const built = await buildAuthenticatedApp('integration.user');
    app = built.app;
    cookieHeader = built.cookieHeader;
  });

  afterAll(async () => {
    await deleteInvoicesByIds(createdIds);
    await app.close();
  });

  afterEach(() => {
    if (previousPolicyEnv.validationMode === undefined) delete process.env.SAP_VALIDATION_MODE;
    else process.env.SAP_VALIDATION_MODE = previousPolicyEnv.validationMode;

    if (previousPolicyEnv.attachmentPolicy === undefined) delete process.env.SAP_ATTACHMENT_POLICY;
    else process.env.SAP_ATTACHMENT_POLICY = previousPolicyEnv.attachmentPolicy;

    if (previousPolicyEnv.postPolicy === undefined) delete process.env.SAP_POST_POLICY;
    else process.env.SAP_POST_POLICY = previousPolicyEnv.postPolicy;

    if (previousPolicyEnv.baseUrl === undefined) delete process.env.SAP_REST_BASE_URL;
    else process.env.SAP_REST_BASE_URL = previousPolicyEnv.baseUrl;

    vi.restoreAllMocks();
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

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

    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { files: true },
    });
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
    process.env.SAP_REST_BASE_URL = 'https://sap.test.local/b1s/v1';
    process.env.SAP_POST_POLICY = 'real';

    const fetchSpy = vi.fn(async () => jsonResponse({ value: [{}] }));
    vi.stubGlobal('fetch', fetchSpy);

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
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(postResponse.json().data.simulate).toBe(true);

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

    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { files: true },
    });
    expect(invoice.status).toBe('POSTED');
    expect(invoice.paStatusSentAt).not.toBeNull();

    const auditEntries = await prisma.auditLog.findMany({
      where: {
        entityId: invoiceId,
        action: { in: ['APPROVE', 'POST_SAP', 'SEND_STATUS_PA'] },
      },
    });
    expect(auditEntries.some((entry) => entry.action === 'APPROVE' && entry.outcome === 'OK')).toBe(
      true,
    );
    expect(
      auditEntries.some((entry) => entry.action === 'POST_SAP' && entry.outcome === 'OK'),
    ).toBe(true);
    expect(
      auditEntries.some((entry) => entry.action === 'SEND_STATUS_PA' && entry.outcome === 'OK'),
    ).toBe(true);
  });

  it('refuses TO_REVIEW invoices before any SAP call', async () => {
    const invoiceId = await createTestInvoice({ status: 'TO_REVIEW', paSource: 'TEST_INT' });
    createdIds.push(invoiceId);

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const response = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/post`,
      headers: {
        cookie: cookieHeader,
        'content-type': 'application/json',
      },
      payload: { integrationMode: 'SERVICE_INVOICE', simulate: true },
    });

    expect(response.statusCode).toBe(422);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.json().error).toContain('Statut "TO_REVIEW"');
  });

  it('blocks on attachment upload failure when attachment policy is strict', async () => {
    const invoiceId = await createTestInvoice({ status: 'READY', paSource: 'TEST_INT' });
    createdIds.push(invoiceId);

    process.env.SAP_REST_BASE_URL = 'https://sap.test.local/b1s/v1';
    process.env.SAP_ATTACHMENT_POLICY = 'strict';
    process.env.SAP_POST_POLICY = 'real';

    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.includes('/Attachments2')) {
        return jsonResponse({ error: { message: { value: 'upload denied' } } }, 500);
      }
      return jsonResponse({ value: [{}] });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const response = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/post`,
      headers: {
        cookie: cookieHeader,
        'content-type': 'application/json',
      },
      payload: { integrationMode: 'SERVICE_INVOICE' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain('Échec upload pièce jointe');

    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { files: true },
    });
    expect(invoice.status).toBe('ERROR');

    const attachmentAudit = await prisma.auditLog.findFirst({
      where: {
        entityId: invoice.files[0]?.id,
        entityType: 'ATTACHMENT',
      },
      orderBy: { occurredAt: 'desc' },
    });

    expect(attachmentAudit?.outcome).toBe('ERROR');
  });
});
