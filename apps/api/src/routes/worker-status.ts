import type { FastifyInstance } from 'fastify';
import { prisma } from '@pa-sap-bridge/database';
import { requireSession } from '../middleware/require-session';

export async function workerStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/worker/status', { preHandler: requireSession }, async (_request, reply) => {
    const channels = await prisma.paChannel.findMany({
      select: {
        id: true,
        name: true,
        protocol: true,
        active: true,
        pollIntervalSeconds: true,
        lastPollAt: true,
        lastPollError: true,
      },
      orderBy: { name: 'asc' },
    });

    return reply.send({
      success: true,
      data: {
        channels: channels.map((ch) => ({
          id: ch.id,
          name: ch.name,
          protocol: ch.protocol,
          active: ch.active,
          pollIntervalSeconds: ch.pollIntervalSeconds,
          lastPollAt: ch.lastPollAt?.toISOString() ?? null,
          lastPollError: ch.lastPollError ?? null,
        })),
      },
    });
  });
}
