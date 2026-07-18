// The one hash deep link (design §1/§10): #/join/<CODE> — the whole invite UX.

export function parseJoinHash(hash: string): string | null {
  const m = /^#\/join\/([A-Za-z0-9]{1,12})$/.exec(hash);
  return m ? m[1]!.toUpperCase() : null;
}

export function inviteUrl(base: string, code: string): string {
  return `${base}#/join/${code}`;
}
