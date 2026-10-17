// Bomb generation + defusal engine (server-side authority).
//
// The engine owns: bomb casing facts (serial, batteries, indicators, ports),
// the module instances with their hidden solutions, the strike counter and the
// score. Clients only ever receive role-filtered projections built in
// lib/view.js.

import { Rng, makeSerial, fmtTime } from './rng.js';
import { MODULES } from './modules.js';
import { DIFFICULTIES, INDICATORS, PORTS, BATTERY_TYPES } from './vocab.js';

function pickTier(rng, weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng.next() * total;
  for (const [tier, w] of entries) {
    r -= w;
    if (r <= 0) return Number(tier);
  }
  return Number(entries[entries.length - 1][0]);
}

export function makeBomb({ seed, difficulty = 'normal', moduleCount, modulePick, tier: forcedTier }) {
  const diff = DIFFICULTIES[difficulty] || DIFFICULTIES.normal;
  const rng = new Rng(seed);
  const serial = makeSerial(rng);

  const batteries = rng.range(0, 3);
  const batteryTypes = [];
  for (let i = 0; i < batteries; i++) batteryTypes.push(rng.pick(BATTERY_TYPES).id);

  const indicatorMap = {};
  for (const ind of rng.sample(INDICATORS, rng.range(1, 3))) indicatorMap[ind] = true;

  const ports = rng.sample(PORTS.map((p) => p.id), rng.range(0, 3));

  const cfg = { serial, batteries, batteryTypes, indicatorMap, ports };

  const chosen = [];
  if (modulePick) {
    // 模块测试台：只生成指定的那一个模块
    const ids = Array.isArray(modulePick) ? modulePick : [modulePick];
    ids.forEach((id, i) => {
      if (!MODULES[id]) return;
      const tier = forcedTier != null ? Math.max(1, Math.min(5, Number(forcedTier) | 0))
        : (MODULES[id].tier ? MODULES[id].tier(3) : 3);
      chosen.push({ id, tier });
    });
  } else {
    const ids = Object.keys(MODULES);
    const count = moduleCount || rng.range(diff.modules[0], diff.modules[1]);
    let guard = 0;
    while (chosen.length < count && guard++ < count * 30) {
      const tier = pickTier(rng, diff.tierWeights);
      const candidates = ids.filter((id) => !chosen.some((c) => c.id === id));
      const id = rng.pick(candidates.length ? candidates : ids);
      chosen.push({ id, tier });
    }
  }

  const mods = [];
  chosen.forEach(({ id, tier }, i) => {
    const def = MODULES[id];
    const built = def.make(rng, cfg, tier, i);
    mods.push({
      uid: `${id}-${i}`,
      id,
      tier,
      title: def.title,
      icon: def.icon,
      state: built.state,
      rules: built.rules,
      solution: built.solution,
      asks: built.asks || [],
      reset: !!built.reset,
      status: 'active', // active | solved
      note: '',
    });
  });

  return {
    seed,
    difficulty: diff.id,
    cfg,
    serial,
    batteries,
    batteryTypes,
    indicatorMap,
    ports,
    modules: mods,
    maxStrikes: diff.maxStrikes,
    durationMs: diff.timeSec * 1000,
    timePenaltyMs: diff.timePenaltySec * 1000,
    manualRows: diff.manualRows,
  };
}

/** Score for a finished run. */
export function scoreRun(bomb, { remainingMs, strikes, status }) {
  const solved = bomb.modules.filter((m) => m.status === 'solved').length;
  const base = solved * 100;
  const total = bomb.modules.length;
  if (status !== 'defused') {
    return { score: base, solved, total, timeBonus: 0, strikePenalty: strikes * 50, note: '炸弹爆炸' };
  }
  const timeBonus = Math.max(0, Math.floor(remainingMs / 1000) * 3);
  const strikePenalty = strikes * 50;
  const perfect = strikes === 0 ? 250 : 0;
  return { score: base + timeBonus - strikePenalty + perfect, solved, total, timeBonus, strikePenalty, perfect, note: perfect ? '完美拆除！' : '拆除成功' };
}

export { fmtTime };
