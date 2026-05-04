import type { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import { requireSession } from '../middleware/require-session';
import { findSuppliers } from '../repositories/supplier.repository';
import {
  generateAndSave,
  enrichSupplier,
  getGeneratedFilePath,
  InvoiceValidationError,
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
            limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
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
  // Génère une facture de frais de gestion (XML UBL 2.1 + PDF + ZIP)
  // Validation bloquante : toutes les lignes doivent avoir un compte classe 6
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
            invoiceDate: { type: 'string', format: 'date' },
            dueDate: { type: 'string', format: 'date' },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            direction: { type: 'string', enum: ['INVOICE', 'CREDIT_NOTE'] },
            buyerName: { type: 'string', maxLength: 200 },
            buyerSiret: { type: 'string', maxLength: 14 },
            buyerVatNumber: { type: 'string', maxLength: 20 },
            note: { type: 'string', maxLength: 500 },
            supplier: {
              type: 'object',
              required: ['name'],
              properties: {
                name: { type: 'string', minLength: 1, maxLength: 200 },
                legalForm: { type: 'string', maxLength: 200 },
                address: { type: 'string', maxLength: 200 },
                city: { type: 'string', maxLength: 100 },
                postalCode: { type: 'string', maxLength: 10 },
                country: { type: 'string', maxLength: 2 },
                taxId: { type: 'string', maxLength: 50 },
                siret: { type: 'string', maxLength: 14 },
                iban: { type: 'string', maxLength: 40 },
                bic: { type: 'string', maxLength: 12 },
                phone: { type: 'string', maxLength: 30 },
                email: { type: 'string', maxLength: 100 },
              },
            },
            lines: {
              type: 'array',
              minItems: 1,
              maxItems: 50,
              items: {
                type: 'object',
                required: ['description', 'quantity', 'unitPrice', 'taxRate', 'accountingCode'],
                properties: {
                  description: { type: 'string', minLength: 1, maxLength: 300 },
                  quantity: { type: 'number', minimum: 0.001 },
                  unitPrice: { type: 'number', minimum: 0 },
                  taxRate: { type: 'number', minimum: 0, maximum: 100 },
                  // Compte de charge classe 6 — pattern ^6 validé aussi dans le service
                  accountingCode: { type: 'string', minLength: 1, maxLength: 10, pattern: '^6' },
                  accountingLabel: { type: 'string', maxLength: 200 },
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
        if (err instanceof InvoiceValidationError) {
          return reply.code(400).send({ success: false, error: err.message });
        }
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
  // Sert un fichier généré (XML, PDF ou ZIP) — protection anti path-traversal
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

      const ext = path.extname(filePath).toLowerCase();
      const contentTypeMap: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.xml': 'application/xml',
        '.zip': 'application/zip',
      };
      const contentType = contentTypeMap[ext] ?? 'application/octet-stream';
      const basename = path.basename(filePath);

      reply.header('Content-Type', contentType);
      reply.header('Content-Disposition', `attachment; filename="${basename}"`);

      const stream = fs.createReadStream(filePath);
      return reply.send(stream);
    },
  );
}
