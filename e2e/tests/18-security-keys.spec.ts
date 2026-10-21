import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login, register, uniqueEmail, watchConsole } from '../support/helpers';

const PW = 'e2e-Passw0rd-original';
const axe = async (page: Page, label: string) => {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
};

/**
 * Chrome's own virtual FIDO2 authenticator (DevTools protocol): an independent implementation of the browser and
 * authenticator sides of WebAuthn, so these tests exercise our server against something we did not write.
 */
async function virtualKey(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: false, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return {
    credentials: async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials,
    clear: () => cdp.send('WebAuthn.clearCredentials', { authenticatorId }),
  };
}
const signOut = async (page: Page) => { await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page).toHaveURL(/\/$/); };

/** Register the virtual key through the account page; returns the recovery codes the page showed. */
async function addKey(page: Page, name = 'Desk key') {
  await page.goto('/account');
  await page.getByRole('button', { name: 'Add a security key' }).click();
  await page.getByLabel('Name for this key').fill(name);
  await page.getByLabel('Password to add this key').fill(PW);
  await page.getByRole('button', { name: 'Continue' }).click();
  const list = page.getByRole('list', { name: 'Your recovery codes' });
  await expect(list).toBeVisible();
  const recovery = (await list.getByRole('listitem').allInnerTexts()).map((s) => s.trim());
  await page.getByRole('button', { name: 'I have saved them' }).click();
  return recovery;
}

test.describe('security keys (WebAuthn)', () => {
  test('add a key, sign out, sign in with password then the key; Chrome\'s authenticator confirms what happened', async ({ page }) => {
    const mon = watchConsole(page);
    const key = await virtualKey(page);
    const email = uniqueEmail('webauthn');
    await register(page, email, PW);

    const recovery = await addKey(page);
    expect(recovery).toHaveLength(10);
    const keys = page.getByRole('list', { name: 'Your security keys' });
    await expect(keys).toContainText('Desk key');
    await expect(keys).toContainText('never used to sign in');
    await axe(page, 'security keys card');
    // the authenticator (not our server) holds exactly one credential, bound to the site's RP ID
    const [cred] = await key.credentials();
    expect((await key.credentials())).toHaveLength(1);
    expect(cred!.rpId).toBe('localhost');
    const signCountAtRegistration = cred!.signCount;

    await signOut(page);
    await page.goto('/signin');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PW);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
    await axe(page, 'second step');
    await page.getByRole('button', { name: 'Use security key' }).click();
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Your security keys' })).toContainText(/last used/);

    // the signature counter really moved on the authenticator
    expect((await key.credentials())[0]!.signCount).toBeGreaterThan(signCountAtRegistration);
    expect(mon.problems).toEqual([]);
    expect(await mon.cspViolations()).toEqual([]);
  });

  test('a recovery code signs in when the key is gone; the code works once', async ({ page }) => {
    const key = await virtualKey(page);
    const email = uniqueEmail('webauthn-lost');
    await register(page, email, PW);
    const recovery = await addKey(page);
    await signOut(page);

    await key.clear(); // the key is lost
    await page.goto('/signin');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PW);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'Use security key' }).click();
    await expect(page.getByRole('alert')).toBeVisible(); // refused, not a silent hang or a session
    await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();

    await page.getByLabel('Recovery code').fill(recovery[0]!);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
    await signOut(page);

    await page.goto('/signin');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PW);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Recovery code').fill(recovery[0]!);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(page.getByRole('alert')).toContainText(/not a valid recovery code/i);
  });

  test('removing the only key needs the password and a recovery code, and turns two-step sign-in off', async ({ page }) => {
    await virtualKey(page);
    const email = uniqueEmail('webauthn-remove');
    await register(page, email, PW);
    const recovery = await addKey(page);

    await page.getByRole('button', { name: 'Remove Desk key' }).click();
    await page.getByLabel('Password to remove this key').fill(PW);
    await page.getByLabel('Recovery code or authenticator code').fill('AAAAA-BBBBB');
    await page.getByRole('button', { name: 'Remove key' }).click();
    await expect(page.getByRole('alert')).toContainText(/not a valid recovery code/i);
    await page.getByLabel('Recovery code or authenticator code').fill(recovery[0]!);
    await page.getByRole('button', { name: 'Remove key' }).click();
    await expect(page.getByRole('list', { name: 'Your security keys' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add a security key' })).toBeVisible();

    await signOut(page);
    await login(page, email, PW); // straight in: no second step any more
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  });
});
