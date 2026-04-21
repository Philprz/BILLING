/**
 * Parseur CII (Cross Industry Invoice / UN/CEFACT D16B) — NON IMPLÉMENTÉ
 *
 * Ce module est préparé pour Lot 7+. Le format CII est détecté correctement
 * mais le parsing structuré n'est pas encore réalisé.
 *
 * Namespace CII attendu :
 *   urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100
 */

export function parseCii(_xmlContent: string): never {
  throw new Error(
    'Format CII (Cross Industry Invoice) détecté mais non supporté dans ce lot. ' +
    'Déposez le fichier dans data/inbox/ une fois le parseur CII implémenté (Lot 7+).',
  );
}
