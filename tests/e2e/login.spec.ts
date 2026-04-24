import { test, expect } from '@playwright/test';

const COMPANY = process.env.E2E_COMPANY ?? 'SBODemoFR';
const USER = process.env.E2E_USER ?? 'manager';
const PASS = process.env.E2E_PASS ?? 'manager';

test.describe('Authentification', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
  });

  test('affiche le formulaire de connexion', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /accès sap/i })).toBeVisible();
    await expect(page.getByLabel(/société sap/i)).toBeVisible();
    await expect(page.getByLabel(/utilisateur sap/i)).toBeVisible();
    await expect(page.getByLabel(/mot de passe/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /se connecter/i })).toBeVisible();
  });

  test('affiche une erreur de validation si les champs sont vides', async ({ page }) => {
    await page.getByRole('button', { name: /se connecter/i }).click();
    await expect(page.getByText(/utilisateur requis/i)).toBeVisible();
    await expect(page.getByText(/mot de passe requis/i)).toBeVisible();
  });

  test('affiche une erreur SAP sur des identifiants incorrects', async ({ page }) => {
    await page.getByLabel(/utilisateur sap/i).fill('wrong_user');
    await page.getByLabel(/mot de passe/i).fill('wrong_pass');
    await page.getByRole('button', { name: /se connecter/i }).click();
    await expect(page.getByText(/erreur de connexion|non autorisé|invalid/i)).toBeVisible({
      timeout: 15_000,
    });
  });

  test('connecte et redirige vers le tableau de bord', async ({ page }) => {
    test.skip(
      !process.env.E2E_USER,
      'identifiants E2E non fournis — passer E2E_USER, E2E_PASS, E2E_COMPANY',
    );

    await page.selectOption('[id="companyDb"]', COMPANY);
    await page.getByLabel(/utilisateur sap/i).fill(USER);
    await page.getByLabel(/mot de passe/i).fill(PASS);
    await page.getByRole('button', { name: /se connecter/i }).click();

    await expect(page).toHaveURL('/', { timeout: 15_000 });
    await expect(page.getByRole('navigation', { name: /navigation principale/i })).toBeVisible();
  });
});

test.describe('Navigation (authentifié)', () => {
  test.skip(true, 'nécessite une session active — à étendre avec storageState');

  test('affiche la liste des factures', async ({ page }) => {
    await page.goto('/invoices');
    await expect(page.getByRole('heading', { name: /factures/i })).toBeVisible();
  });
});
