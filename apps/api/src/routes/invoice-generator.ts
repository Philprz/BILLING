import type { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import { requireSession } from '../middleware/require-session';
import { findSuppliers } from '../repositories/supplier.repository';
import {
  generateAndSave,
  enrichSupplier,
  getGeneratedFilePath,
  type InvoiceGenData,
} from '../services/invoice-generator.service';

interface EnrichBody {
  siren: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function invoiceGeneratorRoutes(app: FastifyInstance): Promise<void> {
  // ────────────────────────────────────────────────────────────────────────────
  // GET /api/invoice-generator/suppliers
  // Recherche un fournisseur dans le cache SAP (réutilise supplier.repository)
  // ────────────────────────────────────────────────────────────────────────────
  app.get<{ Querystring: { search?: string; limit?: number } }>(
    '/api/invoice-generator/suppliers',
    {
      preHandler: requireSession,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            search: { type: 'string', maxLength: 100 },
            limit:  { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
          },
        },
      },
    },
    async (request, reply) => {
      const { search, limit = DEFAULT_LIMIT } = request.query;
      const { items, total } = await findSuppliers({ page: 1, limit, search });
      return reply.send({ success: true, data: { items, total } });
    },
  );

  // ────────────────────────────────────────────────────────────────────────────
  // POST /api/invoice-generator/enrich-supplier
  // Enrichit un fournisseur via Pappers (priorité) puis INSEE
  // Body : { siren: string }
  // ────────────────────────────────────────────────────────────────────────────
  app.post<{ Body: EnrichBody }>(
    '/api/invoice-generator/enrich-supplier',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          required: ['siren'],
          properties: {
            siren: { type: 'string', minLength: 9, maxLength: 14, pattern: '^[0-9]+$' },
          },
        },
      },
    },
    async (request, reply) => {
      const { siren } = request.body;

      const result = await enrichSupplier(siren);
      if (!result) {
        return reply.code(404).send({
          success: false,
          error: `Aucune donnée trouvée pour le SIREN ${siren} (Pappers et INSEE non configurés ou entreprise introuvable).`,
        });
      }

      return reply.send({ success: true, data: result });
    },
  );

  // ────────────────────────────────────────────────────────────────────────────
  // POST /api/invoice-generator/generate
  // Génère une facture de test (XML UBL 2.1 + PDF)
  // Body : InvoiceGenData
  // ────────────────────────────────────────────────────────────────────────────
  app.post<{ Body: InvoiceGenData }>(
    '/api/invoice-generator/generate',
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: 'object',
          required: ['invoiceNumber', 'invoiceDate', 'currency', 'direction', 'supplier', 'lines'],
          properties: {
            invoiceNumber: { type: 'string', minLength: 1, maxLength: 100 },
            invoiceDate:   { type: 'string', format: 'date' },
            dueDate:       { type: 'string', format: 'date' },
            currency:      { type: 'string', minLength: 3, maxLength: 3 },
            direction:     { type: 'string', enum: ['INVOICE', 'CREDIT_NOTE'] },
            buyerName:     { type: 'string', maxLength: 200 },
            note:          { type: 'string', maxLength: 500 },
            supplier: {
              type: 'object',
              required: ['name'],
              properties: {
                name:       { type: 'string', minLength: 1, maxLength: 200 },
                address:    { type: 'string', maxLength: 200 },
                city:       { type: 'string', maxLength: 100 },
                postalCode: { type: 'string', maxLength: 10 },
                country:    { type: 'string', maxLength: 2 },
                taxId:      { type: 'string', maxLength: 50 },
                siret:      { type: 'string', maxLength: 14 },
              },
            },
            lines: {
              type: 'array',
              minItems: 1,
              maxItems: 50,
              items: {
                type: 'object',
                required: ['description', 'quantity', 'unitPrice', 'taxRate'],
                properties: {
                  description: { type: 'string', minLength: 1, maxLength: 300 },
                  quantity:    { type: 'number', minimum: 0.001 },
                  unitPrice:   { type: 'number', minimum: 0 },
                  taxRate:     { type: 'number', minimum: 0, maximum: 100 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await generateAndSave(request.body);
        return reply.send({ success: true, data: result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        app.log.error({ err }, 'Erreur génération facture de test');
        return reply.code(500).send({
          success: false,
          error: `Erreur lors de la génération : ${message}`,
        });
      }
    },
  );

  // ────────────────────────────────────────────────────────────────────────────
  // GET /api/invoice-generator/download/:filename
  // Sert un fichier généré (XML ou PDF) — protection anti path-traversal intégrée
  // ────────────────────────────────────────────────────────────────────────────
  app.get<{ Params: { filename: string } }>(
    '/api/invoice-generator/download/:filename',
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: 'object',
          required: ['filename'],
          properties: {
            filename: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const filePath = getGeneratedFilePath(request.params.filename);

      if (!fs.existsSync(filePath)) {
        return reply.code(404).send({ success: false, error: 'Fichier introuvable.' });
      }

      const ext         = path.extname(filePath).toLowerCase();
      const contentType = ext === '.pdf' ? 'application/pdf' : 'application/xml';
      const basename    = path.basename(filePath);

      reply.header('Content-Type', contentType);
      reply.header('Content-Disposition', `attachment; filename="${basename}"`);

      const stream = fs.createReadStream(filePath);
      return reply.send(stream);
    },
  );
}
