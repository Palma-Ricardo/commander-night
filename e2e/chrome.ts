// The chrome flow both clients share (T5): home → lobby → deck → ready → start,
// chat, and the post-game rematch. This half stays DOM-driven on purpose — the
// screens outside the board *are* DOM in both clients (the table client ported the
// classic chrome verbatim at T3, same classes and labels), and driving them
// through the UI is exactly what the specs are for. Only the board went to canvas,
// and that is what the semantic driver covers.

import { expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const repoFile = (rel: string): string =>
  fs.readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

/** Land on home with a live socket and a display name typed in. */
export async function openHome(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.status')).toHaveText('connected');
  await page.getByPlaceholder('how the table sees you').fill(name);
}

/** Host a lobby; returns its code. */
export async function createLobby(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Create lobby' }).click();
  await expect(page.locator('.lobby-code .code')).toBeVisible();
  return (await page.locator('.lobby-code .code').textContent())!.trim();
}

/** Join by invite deep link (the field prefills from the URL — protocol §4).
 *  `expectLobby: false` for a recovery join, which re-binds a live seat by name
 *  (protocol §5) and so lands on the board without ever showing a lobby. */
export async function joinViaLink(
  page: Page, code: string, name: string, opts: { expectLobby?: boolean } = {},
): Promise<void> {
  await page.goto(`/#/join/${code}`);
  await page.getByPlaceholder('how the table sees you').fill(name);
  await expect(page.getByPlaceholder('XKCD42')).toHaveValue(code);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  if (opts.expectLobby !== false) await expect(page.locator('.lobby-code .code')).toHaveText(code);
}

/** Submit a deck and flip ready. The ready gate opens on this seat's own deck
 *  verdict; the other seat's may land before or after, so poll the checkbox. */
export async function submitDeckAndReady(page: Page, deck: string): Promise<void> {
  await page.locator('.deck-editor textarea').fill(deck);
  await page.getByRole('button', { name: 'Submit deck' }).click();
  await expect(page.locator('.deck-controls input[type=checkbox]')).toBeEnabled({ timeout: 20_000 });
  await page.locator('.deck-controls input[type=checkbox]').click();
}

/** Host starts; "fill empty seats with AI" is checked by default. */
export async function startGame(page: Page): Promise<void> {
  await expect(page.locator('.host-controls')).toBeVisible();
  await page.getByRole('button', { name: 'Start game' }).click();
}

export async function sendChat(page: Page, text: string): Promise<void> {
  await page.locator('.chat-input input').fill(text);
  await page.locator('.chat-input input').press('Enter');
}

export async function openChat(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Chat' }).click();
}
