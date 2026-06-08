import type { FastifyInstance } from 'fastify';
import {
  findSuppliers,
  updateSupplierCacheFiscal,
  mergeSuppliers,
  findReconcilePlan,
  listSupplierMerges,
  detachSupplier,
} from '../repositories/supplier.repository';
import { requireSession } from '../middleware/require-session';
import { createAuditLogBestEffort, prisma } from '@pa-sap-bridge/database';
import {
  createBusinessPartner,
  patchBusinessPartnerFiscal,
  SapSlError,
} from '../services/sap-sl.service';
import {
  getSuppliersSyncStatus,
  syncSuppliersFromSap,
} from '../services/sap-suppliers-sync.service';

interface CreateSupplierBody {
  cardCode: string;
  cardName: string;
  /** N° TVA intracommunautaire (FR + 11 chiffres). */
  federalTaxId?: string;
  /** SIRET 14 chiffres. */
  licTradNum?: string;
  /** Code de routage PA (Piste d'Audit Fiable) propre au fournisseur. */
  routageCode?: string;
  vatRegNum?: string;
  street?: string;
  street2?: string;
  city?: string;
  postalCode?: string;
  country?: string;
  email?: string;
  phone?: string;
  invoiceId?: string;
}

const SIRET_RE = /^\d{14}$/;
const FR_VAT_RE = /^FR[0-9A-Z]{2}\d{9}$/;

function getRequestMeta(request: { ip: string; headers: Record<string, unknown> }) {
  return {
    ipAddress: request.ip,
    userAgent:
      typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
interface SupplierListQuery {
  page?: number;
  limit?: number;
  search?: string;
}

export async function supplierRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/suppliers-cache ────────────────────────────────────────────────
  app.get<{ Querystring: SupplierListQuery }>(
    '/api/suppliers-cache',
    {
      preHandler: requireSession,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
            search: { type: 'string', maxLength: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const q = request.query;
      const page = q.page ?? 1;
      const limit = Math.min(q.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

      const { items, total } = await findSuppliers({ page, limit, search: q.search });
      const totalPages = Math.ceil(total / limit);

      return reply.send({
        success: true,
        data: { items, total, page, limit, totalPages },
      });
    },
  );

  // ── POST /api/suppliers/sync ───────────────────────────────────────────────
  app.post('/api/suppliers/sync', { preHandler: requireSession }, async (request, reply) => {
    const { sapCookieHeader, sapUser } = request.sapSession!;
    const result = await syncSuppliersFromSap(sapCookieHeader, sapUser);
    if (result.errors.length > 0 && result.total === 0) {
      return reply
        .code(502)
        .send({ success: false, error: result.errors[0].message, data: result });
    }
    return reply.send({ success: true, data: result });
  });

  // Compatibilité avec l'ancien front.
  app.post('/api/suppliers-cache/sync', { preHandler: requireSession }, async (request, reply) => {
    const { sapCookieHeader, sapUser } = request.sapSession!;
    const result = await syncSuppliersFromSap(sapCookieHeader, sapUser);
    return reply.send({
      success: result.errors.length === 0,
      data: { ...result, upserted: result.inserted + result.updated },
      error: result.errors[0]?.message,
    });
  });

  app.get('/api/suppliers/sync/status', { preHandler: requireSession }, async (_request, reply) => {
    return reply.send({ success: true, data: await getSuppliersSyncStatus() });
  });

  app.get<{ Querystring: { q?: string; limit?: number } }>(
    '/api/suppliers/search',
    {
      preHandler: requireSession,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string', maxLength: 100 },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
        },
      },
    },
    async (request, reply) => {
      const q = request.query.q?.trim();
      const limit = Math.min(request.query.limit ?? 20, 50);
      const { items, total } = await findSuppliers({ page: 1, limit, search: q });
      return reply.send({ success: true, data: { items, total } });
    },
  );

  // ── POST /api/suppliers/create-in-sap ──────────────────────────────────────
  // Crée un fournisseur dans SAP B1 et l'ajoute au cache local.
  app.post<{ Body: CreateSupplierBody }>(
    '/api/suppliers/create-in-sap',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          required: ['cardCode', 'cardName'],
          properties: {
            cardCode: { type: 'string', minLength: 1, maxLength: 15 },
            cardName: { type: 'string', minLength: 1, maxLength: 100 },
            federalTaxId: { type: 'string', maxLength: 32 },
            licTradNum: { type: 'string', maxLength: 32 },
            routageCode: { type: 'string', maxLength: 50 },
            vatRegNum: { type: 'string', maxLength: 32 },
            street: { type: 'string', maxLength: 200 },
            street2: { type: 'string', maxLength: 200 },
            city: { type: 'string', maxLength: 100 },
            postalCode: { type: 'string', maxLength: 20 },
            country: { type: 'string', maxLength: 3 },
            email: { type: 'string', maxLength: 200 },
            phone: { type: 'string', maxLength: 50 },
            invoiceId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request, reply) => {
      const {
        cardCode,
        cardName,
        federalTaxId,
        licTradNum,
        routageCode,
        vatRegNum,
        street,
        street2,
        city,
        postalCode,
        country,
        email,
        phone,
        invoiceId,
      } = request.body;
      const { sapCookieHeader, sapUser } = request.sapSession!;

      // Validation et warnings sur les 3 champs clés. Aucune valeur n'est inventée :
      // si le format est invalide, on n'envoie pas le champ à SAP plutôt que de
      // polluer la fiche fournisseur avec une valeur erronée.
      const cleanLicTradNum = licTradNum?.trim() || undefined;
      const cleanFederalTaxId = federalTaxId?.trim() || undefined;
      const cleanRoutageCode = routageCode?.trim() || undefined;

      let sapLicTradNum: string | undefined;
      if (cleanLicTradNum) {
        if (SIRET_RE.test(cleanLicTradNum)) {
          sapLicTradNum = cleanLicTradNum;
        } else {
          request.log.warn(
            `[BP-CREATE] LicTradNum ignoré pour CardCode ${cardCode} — format SIRET invalide (attendu 14 chiffres) : "${cleanLicTradNum}"`,
          );
        }
      } else {
        request.log.warn(
          `[BP-CREATE] LicTradNum absent pour CardCode ${cardCode} — SIRET non extrait`,
        );
      }

      let sapFederalTaxId: string | undefined;
      if (cleanFederalTaxId) {
        if (FR_VAT_RE.test(cleanFederalTaxId.toUpperCase())) {
          sapFederalTaxId = cleanFederalTaxId.toUpperCase();
        } else {
          request.log.warn(
            `[BP-CREATE] FederalTaxID ignoré pour CardCode ${cardCode} — format TVA intracom invalide (attendu FRxx + 9 chiffres) : "${cleanFederalTaxId}"`,
          );
        }
      } else {
        request.log.warn(
          `[BP-CREATE] FederalTaxID absent pour CardCode ${cardCode} — TVA non extraite`,
        );
      }

      if (!cleanRoutageCode) {
        request.log.warn(`[BP-CREATE] Code de routage PA absent pour CardCode ${cardCode}`);
      }

      try {
        const result = await createBusinessPartner(sapCookieHeader, {
          cardCode,
          cardName,
          federalTaxId: sapFederalTaxId,
          licTradNum: sapLicTradNum,
          routageCode: cleanRoutageCode,
          vatRegNum,
          street,
          street2,
          city,
          postalCode,
          country,
          email,
          phone,
        });

        await prisma.supplierCache.upsert({
          where: { cardcode: result.cardCode },
          create: {
            cardcode: result.cardCode,
            cardname: cardName,
            federaltaxid: sapFederalTaxId ?? null,
            vatregnum: vatRegNum ?? null,
            taxId0: sapLicTradNum ?? null,
            pa_identifier: cleanRoutageCode ?? null,
            cardtype: 'cSupplier',
            validFor: true,
            rawPayload: {
              source: 'create-in-sap',
              cardCode: result.cardCode,
              cardName,
              federalTaxId: sapFederalTaxId ?? null,
              licTradNum: sapLicTradNum ?? null,
              routageCode: cleanRoutageCode ?? null,
              vatRegNum: vatRegNum ?? null,
            },
            lastSyncAt: new Date(),
          },
          update: {
            cardname: cardName,
            federaltaxid: sapFederalTaxId ?? null,
            vatregnum: vatRegNum ?? null,
            taxId0: sapLicTradNum ?? null,
            pa_identifier: cleanRoutageCode ?? null,
            cardtype: 'cSupplier',
            validFor: true,
            syncAt: new Date(),
            lastSyncAt: new Date(),
          },
        });

        await createAuditLogBestEffort({
          action: 'CREATE_SUPPLIER',
          entityType: 'INVOICE',
          entityId: invoiceId ?? null,
          sapUser,
          outcome: 'OK',
          payloadAfter: {
            cardCode: result.cardCode,
            cardName,
            federalTaxId: sapFederalTaxId ?? null,
            licTradNum: sapLicTradNum ?? null,
            routageCode: cleanRoutageCode ?? null,
            vatRegNum: vatRegNum ?? null,
            street: street ?? null,
            street2: street2 ?? null,
            city: city ?? null,
            postalCode: postalCode ?? null,
            country: country ?? null,
            email: email ?? null,
            phone: phone ?? null,
          },
          ...getRequestMeta(request),
        });

        return reply
          .code(201)
          .send({ success: true, data: { cardCode: result.cardCode, cardName } });
      } catch (err) {
        const msg =
          err instanceof SapSlError
            ? err.sapDetail
            : err instanceof Error
              ? err.message
              : String(err);
        const httpStatus = err instanceof SapSlError ? err.httpStatus : 502;

        await createAuditLogBestEffort({
          action: 'CREATE_SUPPLIER',
          entityType: 'INVOICE',
          entityId: invoiceId ?? null,
          sapUser,
          outcome: 'ERROR',
          errorMessage: msg,
          payloadAfter: {
            cardCode,
            cardName,
            federalTaxId: sapFederalTaxId ?? null,
            licTradNum: sapLicTradNum ?? null,
            routageCode: cleanRoutageCode ?? null,
            vatRegNum: vatRegNum ?? null,
          },
          ...getRequestMeta(request),
        });

        return reply.code(httpStatus).send({ success: false, error: msg });
      }
    },
  );

  // ── PATCH /api/suppliers/:cardCode/fiscal ──────────────────────────────────
  // Correction des identifiants fiscaux (TVA / SIRET / Identifiant PA) poussée
  // vers SAP B1, puis miroir dans le cache local. Ne jamais inventer de valeur :
  // un champ absent n'est pas écrasé, un format invalide est refusé (422).
  app.patch<{
    Params: { cardCode: string };
    Body: { federalTaxId?: string; licTradNum?: string; routageCode?: string };
  }>(
    '/api/suppliers/:cardCode/fiscal',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          properties: {
            federalTaxId: { type: 'string', maxLength: 32 },
            licTradNum: { type: 'string', maxLength: 32 },
            routageCode: { type: 'string', maxLength: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      const { cardCode } = request.params;
      const { federalTaxId, licTradNum, routageCode } = request.body;
      const { sapCookieHeader } = request.sapSession!;

      // Validation format : on n'envoie pas un champ invalide (jamais de valeur inventée).
      const cleanFederalTaxId = federalTaxId?.trim();
      const cleanLicTradNum = licTradNum?.trim();
      const cleanRoutageCode = routageCode?.trim();

      const fields: { federalTaxId?: string; licTradNum?: string; routageCode?: string } = {};
      if (cleanFederalTaxId !== undefined) {
        if (cleanFederalTaxId === '' || FR_VAT_RE.test(cleanFederalTaxId.toUpperCase())) {
          fields.federalTaxId = cleanFederalTaxId.toUpperCase();
        } else {
          return reply
            .code(422)
            .send({ success: false, error: 'Format TVA invalide (attendu FRxx + 9 chiffres)' });
        }
      }
      if (cleanLicTradNum !== undefined) {
        if (cleanLicTradNum === '' || SIRET_RE.test(cleanLicTradNum)) {
          fields.licTradNum = cleanLicTradNum;
        } else {
          return reply
            .code(422)
            .send({ success: false, error: 'Format SIRET invalide (attendu 14 chiffres)' });
        }
      }
      if (cleanRoutageCode !== undefined) fields.routageCode = cleanRoutageCode;

      try {
        await patchBusinessPartnerFiscal(sapCookieHeader, cardCode, fields);
        // Met à jour le cache local (mêmes colonnes que create-in-sap : federaltaxid,
        // taxId0 ← SIRET/LicTradNum, pa_identifier ← routageCode).
        const updated = await updateSupplierCacheFiscal(cardCode, {
          federaltaxid: fields.federalTaxId,
          taxId0: fields.licTradNum,
          pa_identifier: fields.routageCode,
        });
        return reply.send({ success: true, data: updated });
      } catch (err) {
        const code = err instanceof SapSlError ? err.httpStatus : 502;
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(code).send({ success: false, error: msg });
      }
    },
  );

  // ── POST /api/suppliers/merge ──────────────────────────────────────────────
  // Rattachement manuel (groupes ambigus, ≥ 2 fiches SAP) : re-pointe les factures
  // des alias vers le maître, mémorise le mapping, pose le flag U_NOVA_Doublon sur
  // les alias RÉELS (validFor:true) en best-effort. AUCUNE fusion SAP.
  app.post<{
    Body: { masterCardcode: string; aliasCardcodes: string[]; reason?: string };
  }>(
    '/api/suppliers/merge',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          required: ['masterCardcode', 'aliasCardcodes'],
          properties: {
            masterCardcode: { type: 'string', minLength: 1, maxLength: 15 },
            aliasCardcodes: {
              type: 'array',
              minItems: 1,
              items: { type: 'string', minLength: 1, maxLength: 15 },
            },
            reason: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const { masterCardcode, aliasCardcodes, reason } = request.body;
      const { sapCookieHeader, sapUser } = request.sapSession!;

      // Principe verrouillé : le maître DOIT être une fiche SAP active (validFor:true).
      const master = await prisma.supplierCache.findUnique({
        where: { cardcode: masterCardcode },
        select: { validFor: true },
      });
      if (!master || !master.validFor) {
        return reply
          .code(422)
          .send({ success: false, error: 'Le maître doit être une fiche SAP active (validFor).' });
      }
      const aliases = aliasCardcodes.filter((c) => c && c !== masterCardcode);
      if (aliases.length === 0) {
        return reply
          .code(422)
          .send({ success: false, error: 'Aucun alias à rattacher (hors maître).' });
      }

      try {
        const result = await mergeSuppliers({
          masterCardcode,
          aliasCardcodes: aliases,
          reason,
          createdBy: sapUser,
        });

        // Pose le flag U_NOVA_Doublon='Y' sur les alias RÉELS (validFor:true) — best-effort.
        // Les orphelins (validFor:false) n'ont pas de BP SAP : on les ignore pour le flag.
        const realAliases = await prisma.supplierCache.findMany({
          where: { cardcode: { in: aliases }, validFor: true },
          select: { cardcode: true },
        });
        for (const a of realAliases) {
          try {
            await patchBusinessPartnerFiscal(sapCookieHeader, a.cardcode, { doublon: 'Y' });
          } catch (flagErr) {
            request.log.warn(
              `[SUPPLIER-MERGE] Flag U_NOVA_Doublon non posé sur ${a.cardcode} (rattachement conservé) : ${
                flagErr instanceof Error ? flagErr.message : String(flagErr)
              }`,
            );
          }
        }

        // Trace d'audit — payloadAfter.repoints = source de vérité pour une ré-version.
        await createAuditLogBestEffort({
          action: 'MERGE_SUPPLIER',
          entityType: 'SUPPLIER',
          entityId: masterCardcode,
          sapUser,
          outcome: 'OK',
          payloadAfter: {
            masterCardcode,
            mode: 'manual',
            reason: reason ?? null,
            repoints: result.repoints,
            invoicesRepointed: result.invoicesRepointed,
          },
          ...getRequestMeta(request),
        });

        return reply.send({
          success: true,
          data: {
            merged: result.merged,
            invoicesRepointed: result.invoicesRepointed,
          },
        });
      } catch (err) {
        const code = err instanceof SapSlError ? err.httpStatus : 502;
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(code).send({ success: false, error: msg });
      }
    },
  );

  // ── POST /api/suppliers/reconcile ──────────────────────────────────────────
  // Dry-run par défaut : construit le plan (groupes à maître SAP UNIQUE) en lecture
  // seule. `dryRun:true` → aperçu sans écriture. `dryRun:false` → exécute chaque
  // rattachement (mode auto) + audit. Le plan d'exécution est TOUJOURS recalculé
  // serveur (jamais un plan transmis par le client).
  app.post<{ Body: { dryRun?: boolean } }>(
    '/api/suppliers/reconcile',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          properties: { dryRun: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      const dryRun = request.body?.dryRun ?? false;
      const { sapUser } = request.sapSession!;
      try {
        const plan = await findReconcilePlan();

        if (dryRun) {
          const invoicesToRepoint = plan.reduce((sum, p) => sum + p.invoicesToRepoint, 0);
          return reply.send({
            success: true,
            data: { plan, groups: plan.length, invoicesToRepoint },
          });
        }

        let groupsReconciled = 0;
        let invoicesRepointed = 0;
        for (const entry of plan) {
          const res = await mergeSuppliers({
            masterCardcode: entry.masterCardcode,
            aliasCardcodes: entry.aliases.map((a) => a.cardcode),
            reason: 'auto-reconcile',
          });
          if (res.merged > 0) {
            groupsReconciled++;
            invoicesRepointed += res.invoicesRepointed;
            await createAuditLogBestEffort({
              action: 'MERGE_SUPPLIER',
              entityType: 'SUPPLIER',
              entityId: entry.masterCardcode,
              sapUser,
              outcome: 'OK',
              payloadAfter: {
                masterCardcode: entry.masterCardcode,
                mode: 'auto',
                reason: 'auto-reconcile',
                repoints: res.repoints,
                invoicesRepointed: res.invoicesRepointed,
              },
              ...getRequestMeta(request),
            });
          }
        }
        return reply.send({ success: true, data: { groupsReconciled, invoicesRepointed } });
      } catch (err) {
        const code = err instanceof SapSlError ? err.httpStatus : 502;
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(code).send({ success: false, error: msg });
      }
    },
  );

  // ── GET /api/suppliers/merges ──────────────────────────────────────────────
  // Liste des rattachements actifs (alias → maître), enrichis du cardname.
  app.get('/api/suppliers/merges', { preHandler: requireSession }, async (_request, reply) => {
    try {
      const items = await listSupplierMerges();
      return reply.send({ success: true, data: items });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ success: false, error: msg });
    }
  });

  // ── DELETE /api/suppliers/merge/:aliasCardcode ─────────────────────────────
  // Détachement : ré-version des factures (via l'audit MERGE_SUPPLIER) vers l'alias,
  // retrait du flag SAP (best-effort), suppression du mapping, audit UNMERGE.
  app.delete<{ Params: { aliasCardcode: string } }>(
    '/api/suppliers/merge/:aliasCardcode',
    { preHandler: requireSession },
    async (request, reply) => {
      const { aliasCardcode } = request.params;
      const { sapCookieHeader, sapUser } = request.sapSession!;
      try {
        const merge = await prisma.supplierMerge.findUnique({ where: { aliasCardcode } });
        if (!merge) {
          return reply.code(404).send({ success: false, error: 'Rattachement introuvable.' });
        }
        const { masterCardcode } = merge;

        // Retrouver les factures repointées depuis la dernière trace MERGE_SUPPLIER.
        const auditRows = await prisma.auditLog.findMany({
          where: { action: 'MERGE_SUPPLIER', entityType: 'SUPPLIER' },
          orderBy: { occurredAt: 'desc' },
          take: 200,
          select: { payloadAfter: true },
        });
        let invoiceIds: string[] = [];
        for (const row of auditRows) {
          const repoints = (
            row.payloadAfter as { repoints?: { aliasCardcode: string; invoiceIds: string[] }[] }
          )?.repoints;
          const match = Array.isArray(repoints)
            ? repoints.find((r) => r.aliasCardcode === aliasCardcode)
            : undefined;
          if (match) {
            invoiceIds = Array.isArray(match.invoiceIds) ? match.invoiceIds : [];
            break;
          }
        }

        const { invoicesReverted } = await detachSupplier({
          aliasCardcode,
          masterCardcode,
          invoiceIds,
        });

        // Retirer le flag SAP (best-effort) — ignore si l'alias n'est pas dans SAP.
        try {
          await patchBusinessPartnerFiscal(sapCookieHeader, aliasCardcode, { doublon: '' });
        } catch (flagErr) {
          request.log.warn(
            `[SUPPLIER-UNMERGE] Flag U_NOVA_Doublon non retiré sur ${aliasCardcode} : ${
              flagErr instanceof Error ? flagErr.message : String(flagErr)
            }`,
          );
        }

        await createAuditLogBestEffort({
          action: 'UNMERGE_SUPPLIER',
          entityType: 'SUPPLIER',
          entityId: aliasCardcode,
          sapUser,
          outcome: 'OK',
          payloadAfter: { aliasCardcode, masterCardcode, invoicesReverted },
          ...getRequestMeta(request),
        });

        return reply.send({
          success: true,
          data: { aliasCardcode, masterCardcode, invoicesReverted },
        });
      } catch (err) {
        const code = err instanceof SapSlError ? err.httpStatus : 502;
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(code).send({ success: false, error: msg });
      }
    },
  );
}
