/**
 * Nettoyage hebdomadaire des règles de mappage stagnantes (CDC §8).
 *
 * Désactive toute règle dont :
 *   - confidence < 20  (règle peu fiable)
 *   - ET lastUsedAt est null ou > 180 jours sans utilisation
 */

import { prisma } from '@pa-sap-bridge/database';

function log(level: 'INFO' | 'WARN', msg: string): void {
  console.log(`[RuleCleanup][${new Date().toISOString()}][${level}] ${msg}`);
}

export async function runRuleCleanupJob(): Promise<void> {
  const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);

  const result = await prisma.mappingRule.updateMany({
    where: {
      active: true,
      confidence: { lt: 20 },
      OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: cutoff } }],
    },
    data: { active: false },
  });

  if (result.count > 0) {
    log(
      'WARN',
      `${result.count} règle(s) stagnante(s) désactivée(s) (confiance < 20, non utilisées depuis 180 j).`,
    );
  } else {
    log('INFO', 'Aucune règle stagnante à désactiver.');
  }
}
