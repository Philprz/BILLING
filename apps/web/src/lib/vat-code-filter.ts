export type VatCodeOption = {
  code: string;
  name: string;
  rate: number;
  active: boolean;
};

// Filtre les codes TVA B1 sur le taux de la ligne. Comparaison en pourcentage
// (ex. 20, 5.5, 0) avec tolérance 0.01 pour absorber les flottants.
// taxRate null/undefined/NaN ou liste vide → renvoie la liste inchangée
// (comportement dégradé gracieux).
export function filterVatCodesByRate(
  codes: VatCodeOption[],
  taxRate: number | null | undefined,
): VatCodeOption[] {
  if (codes.length === 0) return codes;
  if (taxRate == null) return codes;
  const target = Number(taxRate);
  if (!Number.isFinite(target)) return codes;
  return codes.filter((v) => Math.abs(Number(v.rate) - target) < 0.01);
}
