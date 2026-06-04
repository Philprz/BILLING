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

// Schéma JSON d'une remise/charge (AllowanceCharge) — ligne (BG-27/28) ou document (BG-20/21).
// vatCategory/vatRate sont ignorés au niveau ligne (hérités) et obligatoires au niveau document
// (validation métier dans le service : validateAllowanceCharges).
const allowanceChargeSchema = {
  type: 'object',
  required: ['isCharge', 'amount'],
  properties: {
    isCharge: { type: 'boolean' },
    amount: { type: 'number', exclusiveMinimum: 0 },
    reason: { type: 'string', maxLength: 300 },
    reasonCode: { type: 'string', maxLength: 20 },
    vatCategory: { type: 'string', enum: ['S', 'Z', 'E', 'AE', 'K', 'O', 'G'] },
    vatRate: { type: 'number', minimum: 0, maximum: 100 },
  },
} as const;

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
            // BT-6 — devise de comptabilisation TVA (défaut EUR côté usage)
            taxCurrency: { type: 'string', minLength: 3, maxLength: 3 },
            // Taux de conversion devise facture → devise de comptabilisation (BT-111)
            taxExchangeRate: { type: 'number', exclusiveMinimum: 0 },
            // BT-72 — date de livraison / fin de prestation
            deliveryDate: { type: 'string', format: 'date' },
            direction: {
              type: 'string',
              enum: [
                'INVOICE',
                'CREDIT_NOTE',
                'ADVANCE_INVOICE',
                'CORRECTIVE_INVOICE',
                'ADVANCE_CREDIT_NOTE',
                'SELF_BILLED', // 389 — autofacturation
                'FACTORING', // 393 — affacturage
              ],
            },
            prepaidAmount: { type: 'number', minimum: 0 },
            // Statut de paiement à l'émission — pilote le chiffre 1/2 du cadre BT-23
            paymentStatus: { type: 'string', enum: ['unpaid', 'paid'] },
            // BT-9 — date de paiement (cadre chiffre 2 / BR-FR-CO-09). Non persistée.
            paymentDate: { type: 'string', format: 'date' },
            correctedInvoiceRef: { type: 'string', maxLength: 100 },
            buyerName: { type: 'string', maxLength: 200 },
            buyerSiret: { type: 'string', maxLength: 14 },
            buyerVatNumber: { type: 'string', maxLength: 20 },
            buyerLegalForm: { type: 'string', maxLength: 200 },
            buyerAddress: { type: 'string', maxLength: 200 },
            buyerCity: { type: 'string', maxLength: 100 },
            buyerPostalCode: { type: 'string', maxLength: 10 },
            buyerCountry: { type: 'string', maxLength: 2 },
            // Code de routage CTC (EAS 0225) acheteur — identifiants TVA OSS/étrangers sans EAS national
            buyerRoutingCode: { type: 'string', maxLength: 100 },
            buyerReference: { type: 'string', maxLength: 100 },
            orderReference: { type: 'string', maxLength: 100 },
            salesOrderId: { type: 'string', maxLength: 100 },
            typeTransaction: { type: 'string', enum: ['1', '2', '3'] },
            optionTVA: { type: 'string', enum: ['S', 'E'] },
            // BG-20/21 — remises/charges au niveau document (catégorie TVA obligatoire)
            documentAllowanceCharges: {
              type: 'array',
              maxItems: 20,
              items: allowanceChargeSchema,
            },
            // BG-10 / BT-59-61 — partie bénéficiaire (factor). Obligatoire si direction=FACTORING
            // (validation métier dans le service : validatePayee).
            payee: {
              type: 'object',
              required: ['name'],
              properties: {
                name: { type: 'string', minLength: 1, maxLength: 200 },
                identifier: { type: 'string', maxLength: 100 },
                legalId: { type: 'string', maxLength: 50 },
              },
            },
            // BG-1 / BT-21-22 — mentions structurées (tableau de notes). Remplace `note` (déprécié).
            notes: {
              type: 'array',
              maxItems: 20,
              items: {
                type: 'object',
                required: ['text'],
                properties: {
                  subjectCode: { type: 'string', maxLength: 10 },
                  text: { type: 'string', minLength: 1, maxLength: 1000 },
                },
              },
            },
            // Déprécié : note libre unique (conservée pour compatibilité ascendante).
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
                // Code de routage CTC (EAS 0225) — vendeur étranger/OSS sans EAS de TVA national
                routingCode: { type: 'string', maxLength: 100 },
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
                  taxCategoryCode: { type: 'string', enum: ['S', 'Z', 'E', 'AE', 'K', 'O'] },
                  taxExemptionReasonCode: { type: 'string', maxLength: 50 },
                  taxExemptionReason: { type: 'string', maxLength: 300 },
                  // Compte de charge classe 6 — pattern ^6 validé aussi dans le service
                  accountingCode: { type: 'string', minLength: 1, maxLength: 10, pattern: '^6' },
                  accountingLabel: { type: 'string', maxLength: 200 },
                  // BG-27/28 — remises/charges de ligne (héritent de la catégorie TVA de la ligne)
                  allowanceCharges: {
                    type: 'array',
                    maxItems: 20,
                    items: allowanceChargeSchema,
                  },
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
