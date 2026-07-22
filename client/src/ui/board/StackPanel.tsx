// The stack (§8): bottom→top in state, rendered top-first (what resolves next
// is what the table is looking at). Target names resolve via selectors; stack
// items themselves can be prompt candidates (countering a spell), so the item
// wrapper carries the affordance, not the inner card face.

import { useStore } from 'zustand';
import { appStores } from '../../app';
import type { GameState } from '@night/core/protocol/protocol';
import { affordanceFor, targetName } from '@night/core/state/selectors';
import { CardView } from '../cards/CardView';
import { objectClick } from './interact';

export function StackPanel({ state }: { state: GameState }) {
  const prompt = useStore(appStores.prompt);
  if (state.stack.length === 0) return null;
  const topFirst = [...state.stack].reverse();
  return (
    <div className="stack-panel">
      <h3>Stack</h3>
      <ol className="stack-items">
        {topFirst.map((item, i) => {
          const aff = affordanceFor(prompt, item.id);
          const classes = ['stack-item'];
          if (aff?.kind === 'target') classes.push('hl-target');
          if (aff?.kind === 'target' && aff.selected) classes.push('card-selected');
          return (
            <li
              key={item.id}
              className={classes.join(' ')}
              onClick={aff !== undefined ? () => objectClick(prompt, item.id) : undefined}
              role={aff !== undefined ? 'button' : undefined}
            >
              {item.card !== undefined && (
                <CardView card={item.card} size="small" priority={1} interactive={false} />
              )}
              <div className="stack-text">
                <span className="stack-name">
                  {i === 0 && <em className="stack-top">next: </em>}
                  {item.card?.name ?? (item.kind === 'ability' ? 'Ability' : 'Spell')}
                  {item.kind === 'ability' && item.card !== undefined ? ' (ability)' : ''}
                </span>
                {item.text.length > 0 && <span className="stack-rules">{item.text.join(' ')}</span>}
                {(item.targets ?? []).length > 0 && (
                  <span className="stack-targets">
                    → {(item.targets ?? []).map(t => targetName(state, t)).join(', ')}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
