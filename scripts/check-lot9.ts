import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function nowPlusMinutes(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

async function main(): Promise<void> {
  const { prisma } = await import('@pa-sap-bridge/database');
  const { buildApp } = await import('../apps/api/src/app');
  const { createSession } = await import('../apps/api/src/session/store');
  const { COOKIE_NAME } = await import('../apps/api/src/config');
  const { runPaStatusJob } = await import('../apps/worker/src/jobs/pa-status-job');

  const app = buildApp();
  await app.ready();

  const session = createSession({
    b1Session: 'LOT9-TEST-SESSION',
    companyDb: 'LOT9_TEST_DB',
    sapUser: 'lot9.tester',
    expiresAt: nowPlusMinutes(30),
  });
  const signedCookie = app.signCookie(session.sessionId);
  const cookieHeader = `${COOKIE_NAME}=${signedCookie}`;

  const dummyDir = path.join(process.cwd(), 'data', 'lot9-check');
  fs.mkdirSync(dummyDir, { recursive: true });

  async function createInvoice(status: 'READY' | 'TO_REVIEW' | 'POSTED'): Promise<string> {
    const suffix = randomUUID().slice(0, 8);
    const dummyFile = path.join(dummyDir, `invoice_${suffix}.xml`);
    fs.writeFileSync(dummyFile, `<invoice id="${suffix}" />`, 'utf-8');

    const invoice = await prisma.invoice.create({
      data: {
        paMessageId: `LOT9-${status}-${suffix}`,
        paSource: 'LOT9_VALIDATION',
        direction: 'INVOICE',
        format: 'UBL',
        supplierPaIdentifier: `SIREN-${suffix}`,
        supplierNameRaw: `Lot 9 Supplier ${suffix}`,
        supplierB1Cardcode: 'F_LOT9',
        supplierMatchConfidence: 95,
        docNumberPa: `L9-${suffix}`,
        docDate: new Date('2026-04-21'),
        dueDate: new Date('2026-05-21'),
        currency: 'EUR',
        totalExclTax: 100,
        totalTax: 20,
        totalInclTax: 120,
        status,
        statusReason: status === 'TO_REVIEW' ? 'Contrôle manuel requis' : null,
        sapDocEntry: status === 'POSTED' ? 45000 : null,
        sapDocNum: status === 'POSTED' ? 46000 : null,
        lines: {
          create: [{
            lineNo: 1,
            description: `Lot 9 line ${suffix}`,
            quantity: 1,
            unitPrice: 100,
            amountExclTax: 100,
            taxCode: 'TVA20',
            taxRate: 20,
            taxAmount: 20,
            amountInclTax: 120,
            suggestedAccountCode: '601000',
            suggestedAccountConfidence: 90,
            suggestedTaxCodeB1: 'S1',
            suggestionSource: 'Fixture validation lot 9',
          }],
        },
        files: {
          create: [{
            kind: 'XML',
            path: dummyFile,
            sizeBytes: BigInt(fs.statSync(dummyFile).size),
            sha256: `lot9-${suffix}`,
          }],
        },
      },
    });

    return invoice.id;
  }

  const readyInvoiceId = await createInvoice('READY');
  const rejectInvoiceId = await createInvoice('TO_REVIEW');
  const retryInvoiceId = await createInvoice('POSTED');

  const validStatusOut = fs.mkdtempSync(path.join(os.tmpdir(), 'lot9-status-ok-'));
  process.env.STATUS_OUT_PATH = validStatusOut;

  const viewResponse = await app.inject({
    method: 'GET',
    url: `/api/invoices/${readyInvoiceId}`,
    headers: { cookie: cookieHeader },
  });
  assert(viewResponse.statusCode === 200, `Consultation facture en échec (${viewResponse.statusCode})`);

  const approveResponse = await app.inject({
    method: 'POST',
    url: `/api/invoices/${readyInvoiceId}/post`,
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/json',
    },
    payload: { integrationMode: 'SERVICE_INVOICE', simulate: true },
  });
  assert(approveResponse.statusCode === 200, `Validation facture en échec (${approveResponse.statusCode})`);

  const rejectResponse = await app.inject({
    method: 'POST',
    url: `/api/invoices/${rejectInvoiceId}/reject`,
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/json',
    },
    payload: { reason: 'Motif obligatoire de test lot 9' },
  });
  assert(rejectResponse.statusCode === 200, `Rejet facture en échec (${rejectResponse.statusCode})`);

  const manualStatusResponse = await app.inject({
    method: 'POST',
    url: `/api/invoices/${readyInvoiceId}/send-status`,
    headers: { cookie: cookieHeader },
  });
  assert(manualStatusResponse.statusCode === 200, `Retour de statut manuel en échec (${manualStatusResponse.statusCode})`);

  const blockedPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lot9-status-ko-')), 'blocked.txt');
  fs.writeFileSync(blockedPath, 'blocked', 'utf-8');
  process.env.PA_STATUS_RETRY_DELAYS_MS = '0,0,0';
  process.env.STATUS_OUT_PATH = blockedPath;

  await runPaStatusJob();
  await runPaStatusJob();

  let retryLogs = await prisma.auditLog.findMany({
    where: {
      entityId: retryInvoiceId,
      action: 'SEND_STATUS_PA',
    },
    orderBy: { occurredAt: 'asc' },
  });

  const retryErrors = retryLogs.filter((entry) => entry.outcome === 'ERROR');
  assert(retryErrors.length >= 2, 'Les retries ERROR attendus n’ont pas été produits');

  process.env.STATUS_OUT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'lot9-status-recover-'));
  await runPaStatusJob();

  retryLogs = await prisma.auditLog.findMany({
    where: {
      entityId: retryInvoiceId,
      action: 'SEND_STATUS_PA',
    },
    orderBy: { occurredAt: 'asc' },
  });

  const retryOk = retryLogs.find((entry) => entry.outcome === 'OK');
  assert(retryOk, 'Le retry final OK attendu n’a pas été produit');

  const readyLogs = await prisma.auditLog.findMany({
    where: {
      entityId: readyInvoiceId,
      action: { in: ['VIEW_INVOICE', 'APPROVE', 'POST_SAP', 'SEND_STATUS_PA'] },
    },
    orderBy: { occurredAt: 'asc' },
  });
  assert(readyLogs.some((entry) => entry.action === 'VIEW_INVOICE'), 'Le log VIEW_INVOICE attendu est absent');
  assert(readyLogs.some((entry) => entry.action === 'APPROVE' && entry.outcome === 'OK'), 'Le log APPROVE attendu est absent');
  assert(readyLogs.some((entry) => entry.action === 'POST_SAP' && entry.outcome === 'OK'), 'Le log POST_SAP attendu est absent');
  assert(readyLogs.some((entry) => entry.action === 'SEND_STATUS_PA' && entry.outcome === 'OK'), 'Le log SEND_STATUS_PA manuel attendu est absent');

  const rejectedInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: rejectInvoiceId } });
  assert(rejectedInvoice.status === 'REJECTED', 'La facture rejetée n’est pas au statut REJECTED');
  assert(rejectedInvoice.statusReason === 'Motif obligatoire de test lot 9', 'Le motif de rejet n’a pas été persisté');

  const rejectLogs = await prisma.auditLog.findMany({
    where: {
      entityId: rejectInvoiceId,
      action: 'REJECT',
    },
  });
  assert(rejectLogs.some((entry) => entry.outcome === 'OK'), 'Le log REJECT attendu est absent');

  const auditResponse = await app.inject({
    method: 'GET',
    url: `/api/audit?entityId=${readyInvoiceId}&limit=20`,
    headers: { cookie: cookieHeader },
  });
  assert(auditResponse.statusCode === 200, `Lecture audit en échec (${auditResponse.statusCode})`);
  const auditPayload = auditResponse.json().data.items as Array<{ summary?: string }>;
  assert(auditPayload.length > 0, 'La route audit n’a retourné aucune entrée utile');
  assert(auditPayload.some((entry) => typeof entry.summary === 'string' && entry.summary.length > 0), 'Les résumés audit attendus sont absents');

  const retryInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: retryInvoiceId } });
  assert(retryInvoice.paStatusSentAt, 'Le retry de statut PA n’a pas fini par renseigner paStatusSentAt');

  console.log('Lot 9 check OK');
  console.log(`  READY invoice   : ${readyInvoiceId}`);
  console.log(`  REJECT invoice  : ${rejectInvoiceId}`);
  console.log(`  RETRY invoice   : ${retryInvoiceId}`);
  console.log(`  Retry logs      : ${retryLogs.length} (${retryErrors.length} ERROR, 1 OK attendu)`);

  await app.close();
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('Lot 9 check FAILED');
  console.error(error);
  process.exitCode = 1;
});
