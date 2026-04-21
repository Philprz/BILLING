import type { FastifyInstance } from 'fastify';
import { findSuppliers } from '../repositories/supplier.repository';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface SupplierListQuery {
  page?: number;
  limit?: number;
  search?: string;
}

export async function supplierRoutes(app: FastifyInstance): Promise<void> {
  // ────────────────────────────────────────────────────────────────────────────
  // GET /api/suppliers-cache
  // Paramètres : page, limit, search (cardname / cardcode / federaltaxid)
  // ────────────────────────────────────────────────────────────────────────────
  app.get<{ Querystring: SupplierListQuery }>(
    '/api/suppliers-cache',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page:   { type: 'integer', minimum: 1, default: 1 },
            limit:  { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
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
}
