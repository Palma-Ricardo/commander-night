// Battlefield rows (§8): controller-grouped, lands compressed into a small
// overlapping row, attachments nested under their host, tapped = rotation.

import type { Permanent, Player } from '../../protocol/protocol';
import { CardView } from '../cards/CardView';

const isLand = (p: Permanent) => p.types.includes('LAND') && !p.types.includes('CREATURE');

export function Battlefield({ player, mine }: { player: Player; mine: boolean }) {
  const perms = player.battlefield;
  const byId = new Map(perms.map(p => [p.id, p]));
  const nested = new Set(
    perms.filter(p => p.attachedTo !== undefined && byId.has(p.attachedTo)).map(p => p.id),
  );
  const hosts = perms.filter(p => !nested.has(p.id));
  const lands = hosts.filter(isLand);
  const spells = hosts.filter(p => !isLand(p));
  const attachmentsOf = (host: Permanent) => perms.filter(p => p.attachedTo === host.id);

  const size = mine ? 'bf' : 'small';

  return (
    <div className={`battlefield ${mine ? 'battlefield-mine' : ''}`}>
      {spells.length > 0 && (
        <div className="bf-row bf-spells">
          {spells.map(p => (
            <div key={p.id} className="perm-stack">
              {attachmentsOf(p).map(a => (
                <CardView key={a.id} card={a} size={size} priority={1} />
              ))}
              <CardView card={p} size={size} priority={1} />
            </div>
          ))}
        </div>
      )}
      {lands.length > 0 && (
        <div className="bf-row bf-lands">
          {lands.map(p => <CardView key={p.id} card={p} size="small" priority={1} />)}
        </div>
      )}
      {perms.length === 0 && <span className="bf-empty">—</span>}
    </div>
  );
}
