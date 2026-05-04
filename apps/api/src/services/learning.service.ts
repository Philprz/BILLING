/**
 * Boucle d'apprentissage des règles de mappage (CDC §8.2).
 *
 * Appelé après chaque intégration SAP réussie.
 * Pour chaque ligne intégrée :
 *   - Suggestion acceptée → renforcer la règle (confidence +2, usageCount++)
 *   - Compte modifié      → affaiblir l'ancienne règle (-5), créer/renforcer une règle SUPPLIER
 */

import { prisma } from '@pa-sap-bridge/database';
import type { LineData } from './sap-invoice-builder';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LearningInput {
  supplierB1Cardcode: string | null;
  lines: LineData[];
  sapUser: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Token le plus long (≥ 4 lettres) d'une description — mot-clé le plus discriminant. */
function extractKeyword(description: string): string | null {
  const tokens = description
    .toLowerCase()
    .replace(/[^a-zàâäéèêëîïôùûüç\s]/gi, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4);
  if (tokens.length === 0) return null;
  return tokens.reduce((a, b) => (b.length > a.length ? b : a));
}

/**
 * Cherche en DB la règle active qui correspond au mieux à cette ligne
 * (correspondance simple : scope + supplier + keyword dans description + taxRate).
 * Retourne null si aucune règle ne matche.
 */
async function findMatchingRule(
  description: string,
  taxRate: number | null,
  supplierCardcode: string | null,
) {
  const rules = await prisma.mappingRule.findMany({
    where: { active: true },
    orderBy: [{ scope: 'desc' }, { confidence: 'desc' }],
  });

  for (const rule of rules) {
    if (rule.scope === 'SUPPLIER' && rule.supplierCardcode !== supplierCardcode) continue;
    if (rule.matchKeyword && !description.toLowerCase().includes(rule.matchKeyword.toLowerCase()))
      continue;
    if (
      rule.matchTaxRate !== null &&
      taxRate !== null &&
      Math.abs(Number(rule.matchTaxRate) - taxRate) > 0.01
    )
      continue;
    if (rule.matchTaxRate !== null && taxRate === null) continue;
    return rule;
  }
  return null;
}

// ─── Apprentissage immédiat lors d'un choix manuel ───────────────────────────

/**
 * Appelé dès qu'un utilisateur valide manuellement un compte comptable pour une ligne.
 * Crée ou renforce une règle fournisseur (confidence 85) pour que les autres lignes
 * similaires de la même facture et les factures futures bénéficient du même choix.
 */
export async function learnFromManualChoice({
  invoiceId: _invoiceId,
  lineId,
  chosenAccountCode,
  sapUser,
}: {
  invoiceId: string;
  lineId: string;
  chosenAccountCode: string;
  sapUser: string;
}): Promise<void> {
  const line = await prisma.invoiceLine.findUnique({
    where: { id: lineId },
    include: { invoice: { select: { supplierB1Cardcode: true } } },
  });
  if (!line) return;

  const keyword = extractKeyword(line.description);
  const supplierCardcode = line.invoice.supplierB1Cardcode;
  const taxRate = line.taxRate ? Number(line.taxRate) : null;

  if (!supplierCardcode) return;

  const existing = await prisma.mappingRule.findFirst({
    where: {
      scope: 'SUPPLIER',
      supplierCardcode,
      accountCode: chosenAccountCode,
      matchKeyword: keyword ?? undefined,
      active: true,
    },
  });

  if (existing) {
    await prisma.mappingRule.update({
      where: { id: existing.id },
      data: {
        confidence: { set: Math.min(100, existing.confidence + 5) },
        usageCount: { increment: 1 },
        lastUsedAt: new Date(),
      },
    });
  } else {
    await prisma.mappingRule.create({
      data: {
        scope: 'SUPPLIER',
        supplierCardcode,
        matchKeyword: keyword,
        matchTaxRate: taxRate ?? undefined,
        accountCode: chosenAccountCode,
        confidence: 85, // > seuil par défaut (75) → auto-appliqué aux autres lignes similaires
        usageCount: 1,
        lastUsedAt: new Date(),
        createdByUser: sapUser,
      },
    });
  }
}

// ─── Point d'entrée ───────────────────────────────────────────────────────────

export async function applyLearningAfterPost(input: LearningInput): Promise<void> {
  const { supplierB1Cardcode, lines, sapUser } = input;

  for (const line of lines) {
    const resolvedAccount = line.chosenAccountCode ?? line.suggestedAccountCode;
    if (!resolvedAccount) continue;

    const taxRate = line.taxRate ? Number(line.taxRate) : null;
    const bestRule = await findMatchingRule(line.description, taxRate, supplierB1Cardcode);

    if (bestRule && bestRule.accountCode === resolvedAccount) {
      // Cas 1 : suggestion acceptée → renforcer
      await prisma.mappingRule.update({
        where: { id: bestRule.id },
        data: {
          usageCount: { increment: 1 },
          confidence: { set: Math.min(100, bestRule.confidence + 2) },
          lastUsedAt: new Date(),
        },
      });
    } else {
      // Cas 2 : compte modifié ou pas de règle → apprendre le nouveau compte

      if (bestRule) {
        // Affaiblir l'ancienne règle qui suggérait le mauvais compte
        await prisma.mappingRule.update({
          where: { id: bestRule.id },
          data: { confidence: { set: Math.max(0, bestRule.confidence - 5) } },
        });
      }

      const keyword = extractKeyword(line.description);

      // Chercher une règle SUPPLIER existante sur ce même compte + keyword
      const existingRule = supplierB1Cardcode
        ? await prisma.mappingRule.findFirst({
            where: {
              scope: 'SUPPLIER',
              supplierCardcode: supplierB1Cardcode,
              accountCode: resolvedAccount,
              matchKeyword: keyword ?? undefined,
              active: true,
            },
          })
        : null;

      if (existingRule) {
        await prisma.mappingRule.update({
          where: { id: existingRule.id },
          data: {
            usageCount: { increment: 1 },
            confidence: { set: Math.min(100, existingRule.confidence + 2) },
            lastUsedAt: new Date(),
          },
        });
      } else if (supplierB1Cardcode) {
        await prisma.mappingRule.create({
          data: {
            scope: 'SUPPLIER',
            supplierCardcode: supplierB1Cardcode,
            matchKeyword: keyword,
            matchTaxRate: taxRate ?? undefined,
            accountCode: resolvedAccount,
            costCenter: line.chosenCostCenter ?? line.suggestedCostCenter ?? undefined,
            taxCodeB1: line.chosenTaxCodeB1 ?? line.suggestedTaxCodeB1 ?? undefined,
            confidence: 60,
            usageCount: 1,
            lastUsedAt: new Date(),
            createdByUser: sapUser,
          },
        });
      }
    }
  }
}
