import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

// Charge le .env depuis la racine du monorepo
dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma;
}
