import type { Prisma } from '@prisma/client';

/** Prisma Decimal → number JS (4 décimales max, précis pour les montants courants) */
export function dec(d: Prisma.Decimal): number {
  return d.toNumber();
}

export function decOrNull(d: Prisma.Decimal | null): number | null {
  return d == null ? null : d.toNumber();
}

/** BigInt → number (tailles de fichiers, raisonnablement sous Number.MAX_SAFE_INTEGER) */
export function bigInt(n: bigint): number {
  return Number(n);
}

/** Date → chaîne ISO date seule YYYY-MM-DD (pour les champs @db.Date) */
export function isoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

export function isoDateOrNull(d: Date | null): string | null {
  return d == null ? null : isoDate(d);
}
