// ============================================================
// supabase/functions/_shared/l1cache.ts
// 进程内 L1 内存缓存（Map + TTL + 容量 FIFO 淘汰）—— 读型 EF 共用，避免每次命中都走一次
// Postgres（L2 aggregation_cache）往返。
//
// ★ 2026-10-13（P1-9）：由 opendota-proxy 的实例内存热缓存**抽取为共享模块**，供
//   opendota-proxy / liquipedia-proxy / steam-proxy / haglund-proxy / bundle-aggregator 复用。
//   ⚠️ 实例级 best-effort：EF 多实例 / 冷启动下命中率有限（跨实例不共享）⇒ 收益以实测为准，勿高估。
//
// 语义（与 opendota-proxy 原实现一致）：
//   · 每次 set 的驻留时长 = min(传入 ttlMs, MAX_TTL)；表 TTL 才是权威，L1 仅加速。
//   · 容量满时按插入顺序 FIFO 淘汰一条（防大响应撑爆 512MB 内存）。
//   · get 命中已过期条目 ⇒ 删除并返回 null（视为 miss）。
//
// 用法：
//   import { createL1Cache } from "../_shared/l1cache.ts";
//   const L1 = createL1Cache({ cap: 40, ttlMs: 10 * 60 * 1000 });
//   // getCache: 先 L1.get(key)；miss 再查 L2，命中回填 L1.set(key, payload, ttl)
//   // setCache: 写 L2 后 L1.set(key, value, ttl)
// ============================================================

export interface L1Cache {
  get(key: string): any | null;
  set(key: string, payload: any, ttlMs?: number): void;
  del(key: string): void;
  size(): number;
}

export interface L1Options {
  /** 容量上限（防大响应撑爆内存）。默认 40。 */
  cap?: number;
  /** 单条最长驻留（毫秒）。默认 10min。 */
  ttlMs?: number;
}

export function createL1Cache(opts: L1Options = {}): L1Cache {
  const CAP = opts.cap ?? 40;
  const MAX_TTL_MS = opts.ttlMs ?? 10 * 60 * 1000;
  const MEM = new Map<string, { payload: any; expire: number }>();

  function get(key: string): any | null {
    const m = MEM.get(key);
    if (!m) return null;
    if (m.expire < Date.now()) { MEM.delete(key); return null; }
    return m.payload;
  }

  function set(key: string, payload: any, ttlMs?: number): void {
    if (MEM.size >= CAP && !MEM.has(key)) {
      const oldest = MEM.keys().next().value;
      if (oldest !== undefined) MEM.delete(oldest);   // FIFO 淘汰
    }
    const ttl = (typeof ttlMs === "number" && ttlMs > 0) ? ttlMs : MAX_TTL_MS;
    MEM.set(key, { payload, expire: Date.now() + Math.min(ttl, MAX_TTL_MS) });
  }

  function del(key: string): void { MEM.delete(key); }
  function size(): number { return MEM.size; }

  return { get, set, del, size };
}
