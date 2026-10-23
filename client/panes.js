// 界面"块（pane）"的定义：纯数据 + 纯函数，方便单测（不碰 DOM）。
//
// 设计（见 docs/ui-design.md）：
//   · 五块固定：主区 / 状态 / 信号 / 聊天（+ 大厅里的 玩家/角色/设置/聊天）
//   · 角色只决定两件事：主区里放什么（炸弹 / 轮廓 / 手册）、标签顺序
//   · 屏幕宽度决定"同时能看几块"：手机 1 块、平板 2 块、电脑 4 块；电脑可切专注模式变 1 块

// 「动手座位」只有三个：拆弹者 / 静默操作员 / 盲操猴。和 server/room.js 的 start() 校验必须一致。
const OPERATOR_ROLES = new Set(['defuser', 'mute', 'blindop']);
// 主区能看到"炸弹"的角色：动手的三个 + 聋桥猴（他看得见整颗炸弹，但不能操作）
const BOMB_VIEW_ROLES = new Set(['defuser', 'mute', 'blindop', 'deafsee']);
// 主区是"手册"的角色
const EXPERT_ROLES = new Set(['expert', 'blind', 'muteexp', 'expert2', 'expert3']);

/** 占"动手座位"的角色（决定大厅能不能点开始） */
export function isOperatorRole(role) {
  return OPERATOR_ROLES.has(role);
}

/** 能看手册的角色 */
export function isManualRole(role) {
  return EXPERT_ROLES.has(role);
}

/** 主区的标题/图标随角色变化 */
export function mainTitleForRole(role) {
  if (role === 'blindop') return { icon: '🧭', label: '轮廓' };
  if (EXPERT_ROLES.has(role)) return { icon: '📖', label: '手册' };
  if (BOMB_VIEW_ROLES.has(role)) return { icon: '💣', label: '炸弹' };
  return { icon: '💣', label: '炸弹' };
}

const SIDE_META = {
  status: { icon: '⏱', label: '状态' },
  signals: { icon: '✟', label: '信号' },
  chat: { icon: '💬', label: '聊天' },
};

/**
 * 该角色看到哪些块、什么顺序。主区永远第一个。
 * 顺序按"这个角色最缺什么情报"排：
 *   · 聋桥猴：要盯着队友信号转述 → 信号靠前
 *   · 哑手册猴：只能打字/发信号 → 聊天、信号靠前
 *   · 静默操作员：不能用嘴，全靠打字 → 聊天靠前
 *   · 其余：状态（报时）在前
 */
export function panesForRole(role) {
  const order =
    role === 'deafsee'
      ? ['signals', 'status', 'chat']
      : role === 'muteexp'
        ? ['chat', 'signals', 'status']
        : role === 'mute'
          ? ['chat', 'status', 'signals']
          : ['status', 'signals', 'chat'];
  return [{ key: 'main', ...mainTitleForRole(role) }, ...order.map((k) => ({ key: k, ...SIDE_META[k] }))];
}

/** 默认停在主区（手机上进来先看自己最该看的东西） */
export function defaultPaneForRole() {
  return 'main';
}

export const LOBBY_PANES = [
  { key: 'players', icon: '👥', label: '玩家' },
  { key: 'roles', icon: '🎭', label: '角色' },
  { key: 'settings', icon: '⚙️', label: '设置' },
  { key: 'chat', icon: '💬', label: '聊天' },
];

/** 准备阶段默认停在"角色"（进来第一件事是选角色） */
export function defaultLobbyPane() {
  return 'roles';
}

/**
 * 屏幕宽度 → 布局模式
 *   phone   < 640px   一次一块 + 底部标签
 *   tablet  640~1023  主区 + 一个可切换侧栏
 *   desktop >= 1024   全部可见（除非开专注模式）
 */
export function layoutForWidth(width) {
  if (!Number.isFinite(width)) return 'desktop';
  if (width < 640) return 'phone';
  if (width < 1024) return 'tablet';
  return 'desktop';
}

/** 专注模式下，键盘数字键 → 块（1..4） */
export function paneByIndex(panes, index) {
  return panes[index - 1]?.key || null;
}
