import { describe, expect, it } from 'vitest';
import { filterVatCodesByRate, type VatCodeOption } from '../../apps/web/src/lib/vat-code-filter';

function code(overrides: Partial<VatCodeOption> & { code: string; rate: number }): VatCodeOption {
  return {
    name: overrides.name ?? `Libellé ${overrides.code}`,
    active: overrides.active ?? true,
    ...overrides,
  };
}

const ALL: VatCodeOption[] = [
  code({ code: 'C0', rate: 0 }),
  code({ code: 'S0', rate: 0 }),
  code({ code: 'D0', rate: 0 }),
  code({ code: 'C55', rate: 5.5 }),
  code({ code: 'C10', rate: 10 }),
  code({ code: 'C20', rate: 20 }),
  code({ code: 'S20', rate: 20 }),
];

describe('filterVatCodesByRate', () => {
  it('ne retient que les codes à 0% pour une ligne à 0%', () => {
    const filtered = filterVatCodesByRate(ALL, 0);
    expect(filtered.map((c) => c.code)).toEqual(['C0', 'S0', 'D0']);
  });

  it('ne retient que les codes à 20% pour une ligne à 20%', () => {
    const filtered = filterVatCodesByRate(ALL, 20);
    expect(filtered.map((c) => c.code)).toEqual(['C20', 'S20']);
  });

  it('matche 5.5% pour une ligne à 5.5% (taux décimal exact)', () => {
    const filtered = filterVatCodesByRate(ALL, 5.5);
    expect(filtered.map((c) => c.code)).toEqual(['C55']);
  });

  it('matche 5.5% malgré un léger drift flottant (tolérance 0.01)', () => {
    // Un taux issu d'un calcul (ex. recomposition à partir de TVA/HT) peut
    // arriver légèrement décalé en IEEE-754. La tolérance doit l'absorber.
    expect(filterVatCodesByRate(ALL, 5.5 + 1e-7).map((c) => c.code)).toEqual(['C55']);
    expect(filterVatCodesByRate(ALL, 5.5 - 1e-7).map((c) => c.code)).toEqual(['C55']);
    // Mais au-delà de la tolérance, le code n'est plus retenu.
    expect(filterVatCodesByRate(ALL, 5.5 + 0.02).map((c) => c.code)).toEqual([]);
  });

  it('renvoie la liste inchangée si taxRate est null (fallback gracieux)', () => {
    const filtered = filterVatCodesByRate(ALL, null);
    expect(filtered).toBe(ALL);
  });

  it('renvoie la liste inchangée si taxRate est undefined', () => {
    const filtered = filterVatCodesByRate(ALL, undefined);
    expect(filtered).toBe(ALL);
  });

  it('renvoie la liste inchangée si taxRate est NaN', () => {
    const filtered = filterVatCodesByRate(ALL, Number.NaN);
    expect(filtered).toBe(ALL);
  });

  it('renvoie une liste vide pour une entrée vide (pas d’erreur, pas de filtre actif)', () => {
    expect(filterVatCodesByRate([], 0)).toEqual([]);
    expect(filterVatCodesByRate([], 20)).toEqual([]);
    expect(filterVatCodesByRate([], null)).toEqual([]);
  });

  it('ne mute pas la liste source', () => {
    const snapshot = [...ALL];
    filterVatCodesByRate(ALL, 20);
    expect(ALL).toEqual(snapshot);
  });

  it('retourne une nouvelle référence quand un filtre est appliqué', () => {
    const filtered = filterVatCodesByRate(ALL, 20);
    expect(filtered).not.toBe(ALL);
  });

  it('un code à 5.5% n’apparaît jamais pour une ligne à 0%', () => {
    const filtered = filterVatCodesByRate(ALL, 0);
    expect(filtered.some((c) => c.code === 'C55')).toBe(false);
  });

  it('un code incompatible déjà sélectionné est absent de la liste filtrée — le composant doit le ré-injecter', () => {
    // Scénario : la ligne est à 0% mais l'utilisateur avait sélectionné 'C20'
    // (taux 20% — incompatible). filterVatCodesByRate ne le retourne PAS ;
    // le composant InvoiceDetailPage est responsable de l'ajouter en tête
    // avec un marqueur visuel ⚠ pour ne pas afficher de valeur fantôme.
    const lineRate = 0;
    const chosen = 'C20';
    const filtered = filterVatCodesByRate(ALL, lineRate);
    const chosenInFiltered = filtered.some((c) => c.code === chosen);
    const chosenInFull = ALL.some((c) => c.code === chosen);
    expect(chosenInFiltered).toBe(false);
    expect(chosenInFull).toBe(true); // existait avant filtrage → "incompatible", pas "inconnu"
  });

  it('l’option vide n’est pas gérée par le filtre (responsabilité du composant)', () => {
    // L'option vide "(vide)" est un <option value=""> rendu en dur dans le
    // <select> par le composant, indépendant du contenu de vatCodes. Ce test
    // documente que le filtre n’a aucune notion de "vide" et ne doit pas en
    // injecter une.
    const filtered = filterVatCodesByRate(ALL, 20);
    expect(filtered.every((c) => c.code !== '')).toBe(true);
  });
});
