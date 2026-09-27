// The shops online (docs/plans/gameplay.md, Phase 2): the price list a client needs before it offers
// anything (`catalog`: after every welcome, and again whenever game_config's `shops` changes a price),
// and the `shop` requests, which the shared rule (src/shared/sim/rules/Shops.ts) checks and carries
// out: where the player is, what they have, what it costs. What they spend goes to the activity log
// (Room.onSpend), and what they own is saved with their profile (db.ts, `gear`).
import type { ClientMsg } from '../../../src/shared/net/protocol';
import type { Shops as ShopsRule, ShopReq } from '../../../src/shared/sim/rules/Shops';
import { SLOTS_MAX } from '../../../src/shared/sim/shops/catalog';
import type { Room, Session } from '../Room';
import type { RemoteConfig } from './RemoteConfig';
import type { RoomFeature } from './RoomFeature';

type ShopMsg = Extract<ClientMsg, { t: 'shop' }>;

export class Shops implements RoomFeature {
  readonly id = 'shops';

  constructor(
    private room: Room,
    remoteConfig: RemoteConfig,
  ) {
    remoteConfig.onChange((v) => this.setPrices(v.shops));
  }

  private get rule() {
    return this.room.sim.rule<ShopsRule>('shops');
  }

  messages = {
    shop: (s: Session, m: ShopMsg) => {
      const req = parseShop(m);
      if (req) this.rule?.act(s.player, req);
    },
  };

  onHello(s: Session) {
    const rule = this.rule;
    if (rule) this.room.sendTo(s, { t: 'catalog', prices: rule.prices });
  }

  /** game_config's `shops`: any item with a sane price (the rest keep theirs); everyone online hears
   *  of a change */
  setPrices(v: unknown) {
    const rule = this.rule;
    if (!rule) return;
    const before = JSON.stringify(rule.prices);
    rule.setPrices(v);
    if (JSON.stringify(rule.prices) === before) return;
    for (const s of this.room.sessions.values()) if (s.conn) this.room.sendTo(s, { t: 'catalog', prices: rule.prices });
  }
}

/** a `shop` message as a request the rule takes, or null when it's malformed */
export function parseShop(m: ShopMsg): ShopReq | null {
  if (m.op === 'buy') return typeof m.item === 'string' && m.item.length > 0 && m.item.length <= 32 ? { op: 'buy', item: m.item } : null;
  if (m.op === 'store') return { op: 'store' };
  if (m.op === 'take') return Number.isInteger(m.slot) && m.slot! >= 0 && m.slot! < SLOTS_MAX ? { op: 'take', slot: m.slot! } : null;
  return null;
}
