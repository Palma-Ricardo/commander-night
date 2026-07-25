// The instruction line (prompts-on-the-table §8): the prompt message's one
// home — top-center under the turn ribbon, unconditional for every prompt
// kind. The dock no longer renders the message; for several kinds ("Select a
// nonland card from Miguel's graveyard") the message is the entire meaning,
// so this line is load-bearing, not decoration.

import { useStore } from 'zustand';
import { appStores } from '../app';
import { ManaText } from './ManaSymbols';

export function InstructionLine() {
  const p = useStore(appStores.prompt, s => s.pending);
  if (p === undefined || p.message === '') return null;
  return (
    <div className="instruction-line" data-prompt-kind={p.kind}>
      <ManaText text={p.message} />
    </div>
  );
}
