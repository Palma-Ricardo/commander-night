// Auto-answer policy for the client live tier — the client-side twin of the
// bridge live tier's auto-answering seat (design §13). Pacifist baseline: keep
// every hand, pass every priority, declare no combat, satisfy forced choices
// minimally. The 3 AI opponents supply the aggression that ends the game.
//
// `attempt` escalates when a policy answer bounced (INVALID_ANSWER left the
// same prompt pending): 1 → cancel, 2 → confirm-false, then give up (null)
// and let the test time out loudly.

import type { AnswerValue, Prompt } from '@night/core/protocol/protocol';

export function policyAnswer(prompt: Prompt, attempt: number): AnswerValue | null {
  if (attempt === 1) return { type: 'cancel' };
  if (attempt === 2) return { type: 'confirm', value: false };
  if (attempt > 2) return null;

  switch (prompt.kind) {
    case 'confirm':
      return { type: 'confirm', value: false };            // keep hands, decline options
    case 'priority':
      return prompt.combat !== undefined
        ? { type: 'confirm', value: true }                 // done declaring (nothing)
        : { type: 'confirm', value: false };               // pass
    case 'chooseTargets': {
      if (!prompt.required || prompt.min === 0) return { type: 'cancel' };
      const already = prompt.progress?.chosen ?? 0;
      const need = Math.max(0, prompt.min - already);
      if (need === 0) return { type: 'confirm', value: true };   // done with chosen so far
      return { type: 'objects', objectIds: prompt.candidates.slice(0, need) };
    }
    case 'payMana':
      return prompt.canCancel
        ? { type: 'cancel' }
        : { type: 'object', objectId: prompt.sources?.[0] ?? '' };
    case 'chooseAbility':
      return { type: 'object', objectId: prompt.options[0]?.id ?? '' };
    case 'chooseOption':
      return prompt.options.length > 0
        ? { type: 'option', key: prompt.options[0]!.key }
        : { type: 'cancel' };
    case 'choosePile':
      return { type: 'pile', index: 0 };
    case 'chooseAmount':
      return { type: 'number', value: prompt.min };
    case 'distribute': {
      // rows at their minima, remainder (up to prompt.min total) on the first row
      const amounts = prompt.among.map(row => ({ id: row.id, amount: row.min ?? 0 }));
      let sum = amounts.reduce((a, r) => a + r.amount, 0);
      for (const row of amounts) {
        if (sum >= prompt.min) break;
        const rowMax = prompt.among.find(r => r.id === row.id)?.max ?? prompt.total;
        const add = Math.min(prompt.min - sum, rowMax - row.amount);
        row.amount += add;
        sum += add;
      }
      return { type: 'distribution', amounts };
    }
    case 'playerRequest':
      return prompt.options.length > 0
        ? { type: 'option', key: prompt.options[0]!.key }
        : null;
  }
}
