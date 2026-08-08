// The DOM card component — Scryfall image when resolved, text frame until then
// (and as the permanent fallback), bundled card back for face-down. In the table
// client the *board* is the canvas (§10), so this renders only inside DOM modals:
// chooseTargets card grids, pile columns, the graveyard/exile browser. All
// highlights and click meanings still derive from the pending prompt (§7) via
// affordanceFor — identical to the classic client, so a grid card behaves exactly
// like its board twin. Ported from client/src/ui/cards/CardView.tsx.

import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { appScryfall, appStores } from '../app';
import type { ImagePriority } from '@night/core/images/scryfall';
import type { Card, Permanent } from '@night/core/protocol/protocol';
import { affordanceFor } from '@night/core/state/selectors';
import { answerObject, objectClick } from './interact';
import { hoverCard, hideHover } from './hover';
import { ManaSymbols, ManaText } from './ManaSymbols';

export type CardSize = 'hand' | 'bf' | 'small' | 'grid' | 'preview';

interface Props {
  card: Card;
  size: CardSize;
  priority?: ImagePriority;
  /** false for previews/piles that are not part of the live board */
  interactive?: boolean;
  /** modal grids own their click semantics */
  onClickOverride?: (() => void) | undefined;
  badge?: ReactNode;
  selectedOverride?: boolean;
}

/** Opponents' morphs arrive server-redacted with no identity (§6) — only those
 *  render the bundled back; own face-down cards show their real face, badged. */
const isRedacted = (card: Card) => card.faceDown === true && (card.name === '' || card.set === '');

function asPermanent(card: Card): Permanent | undefined {
  return 'tapped' in card ? (card as Permanent) : undefined;
}

export function CardView({ card, size, priority = 1, interactive = true, onClickOverride, badge, selectedOverride }: Props) {
  const prompt = useStore(appStores.prompt);
  const [menuOpen, setMenuOpen] = useState(false);
  const redacted = isRedacted(card);
  const key = appScryfall.keyOf(card);
  const image = useStore(appScryfall.store, s => (redacted ? undefined : s.images[key]));

  useEffect(() => {
    if (!redacted) appScryfall.resolve(card, priority);
  }, [key, redacted, priority]);

  const perm = asPermanent(card);
  const aff = interactive && onClickOverride === undefined ? affordanceFor(prompt, card.id) : undefined;
  const spinner = prompt.inflight && prompt.actedOn === card.id;
  const selected = selectedOverride ?? (aff?.kind === 'target' && aff.selected);

  const classes = ['card', `card-${size}`];
  if (perm?.tapped) classes.push('card-tapped');
  if (perm?.summoningSick) classes.push('card-sick');
  if (card.token) classes.push('card-token');
  if (aff !== undefined) {
    if (aff.kind === 'action') classes.push('hl-action');
    if (aff.kind === 'target') classes.push('hl-target');
    if (aff.kind === 'source') classes.push(aff.cantPay ? 'hl-source-cantpay' : 'hl-source');
    if (aff.kind === 'combatCandidate') classes.push('hl-combat');
    if (aff.kind === 'combatDeclared') classes.push('hl-declared');
  }
  if (selected) classes.push('card-selected');
  if (onClickOverride !== undefined) classes.push('hl-target');

  const handleClick = () => {
    if (onClickOverride !== undefined) return onClickOverride();
    if (aff === undefined || prompt.inflight) return;
    if (aff.kind === 'action' && aff.actions.filter(a => a.kind !== 'mana').length > 1) {
      setMenuOpen(true);   // ambiguous: show what's here; the server disambiguates (§7)
      return;
    }
    objectClick(prompt, card.id);
  };

  const handleContextMenu = (e: ReactMouseEvent) => {
    // mana-only actions live here, never on click — the float-mana lesson (§7)
    if (aff?.kind === 'manaOnly' || aff?.kind === 'action') {
      e.preventDefault();
      setMenuOpen(true);
    }
  };

  const menuActions = aff?.kind === 'action' || aff?.kind === 'manaOnly' ? aff.actions : [];

  return (
    <div
      className={classes.join(' ')}
      data-card-id={card.id}
      data-card-name={redacted ? undefined : card.name}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={e => {
        if (redacted) return;
        const r = e.currentTarget.getBoundingClientRect();
        hoverCard(card, { left: r.left, top: r.top, width: r.width, height: r.height });
      }}
      onMouseLeave={() => { hideHover('dom'); setMenuOpen(false); }}
      role={aff !== undefined || onClickOverride !== undefined ? 'button' : undefined}
    >
      {redacted
        ? <img className="card-face" src="/cardback.svg" alt="face-down card" draggable={false} />
        : image?.status === 'ok'
          ? <img className="card-face" src={image.url} alt={card.name} draggable={false} />
          : <TextFrame card={card} size={size} />}

      {/* Trigger-order picker (§7): the card art shows *which* permanent fired, but
          its printed box is unreadable at grid scale and lists every ability — so
          overlay a gilt plate with this one ability's rule, mirroring the stack. */}
      {card.ability === true && card.text.length > 0 && (
        <div className="ability-plate">
          <span className="ability-plate-head">Ability</span>
          {card.text.map((line, i) => <p key={i}><ManaText text={line} /></p>)}
        </div>
      )}

      {/* overlays */}
      {card.faceDown === true && !redacted && <span className="badge badge-facedown">face-down</span>}
      {perm !== undefined && perm.damage !== undefined && perm.damage > 0 && (
        <span className="badge badge-damage">{perm.damage}</span>
      )}
      {(card.counters ?? []).length > 0 && (
        <span className="badge badge-counters" title={(card.counters ?? []).map(c => `${c.count}× ${c.name}`).join(', ')}>
          {(card.counters ?? []).reduce((n, c) => n + c.count, 0)}
        </span>
      )}
      {/* XMage sends power "0" for some non-creatures — badge creatures only. Ability
          cards (trigger-order picker) hide it: the plate covers the whole lower card
          and the source's P/T is noise there. */}
      {image?.status === 'ok' && card.ability !== true && card.power !== undefined && card.types.includes('CREATURE') && (
        <span className="badge badge-pt">{card.power}/{card.toughness}</span>
      )}
      {selected && <span className="badge badge-check">✓</span>}
      {aff?.kind === 'combatDeclared' && (
        aff.role === 'attackers'
          ? <span className="badge badge-swords">⚔</span>
          : <span className="badge badge-shield">🛡</span>
      )}
      {aff?.kind === 'source' && aff.cantPay && <span className="badge badge-cantpay">can’t pay this</span>}
      {spinner && <span className="badge badge-spinner" aria-label="waiting for server" />}
      {badge}

      {menuOpen && menuActions.length > 0 && prompt.pending !== undefined && (
        <div className="card-menu" onClick={e => e.stopPropagation()}>
          {menuActions.map((a, i) => (
            <button
              key={i}
              disabled={prompt.inflight}
              onClick={() => {
                setMenuOpen(false);
                answerObject(prompt.pending!.promptId, card.id);
              }}
            >
              {a.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** §9: every field the frame needs is in Card — an unresolved image is
 *  cosmetic, never functional. Also the body of the hover preview. */
export function TextFrame({ card, size }: { card: Card; size: CardSize }) {
  const big = size === 'preview' || size === 'grid' || size === 'hand';
  return (
    <div className={`text-frame colors-${card.colors.join('') || 'C'}`}>
      <div className="tf-head">
        <span className="tf-name">{card.name}</span>
        {big && <ManaSymbols cost={card.manaCost} />}
      </div>
      {big && <div className="tf-type">{[...card.supertypes, ...card.types].join(' ')}{card.subtypes.length > 0 ? ` — ${card.subtypes.join(' ')}` : ''}</div>}
      {big && card.text.length > 0 && (
        <div className="tf-text">{card.text.map((line, i) => <p key={i}><ManaText text={line} /></p>)}</div>
      )}
      {card.power !== undefined && card.types.includes('CREATURE') && (
        <span className="tf-pt">{card.power}/{card.toughness}</span>
      )}
      {card.loyalty !== undefined && <span className="tf-pt">{card.loyalty}</span>}
    </div>
  );
}
