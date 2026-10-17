// Shared vocabulary for roles, colors, difficulty tiers and skills.
// All rule tables in this project are original content written for this game,
// in the spirit of "one screen sees the bomb, another screen sees the manual".

export const ROLES = {
  DEFUSER: 'defuser',
  EXPERT: 'expert',
  BLIND: 'blind',
  MUTE: 'mute',
  /** 三人经典配置：盲操 / 聋桥 / 哑手册 */
  BLIND_OP: 'blindop',
  DEAF_SEE: 'deafsee',
  MUTE_EXP: 'muteexp',
};

export const ROLE_INFO = {
  [ROLES.DEFUSER]: {
    id: ROLES.DEFUSER,
    name: '拆弹者',
    icon: '🧰',
    tagline: '看着炸弹，动手操作',
    canInteract: true,
    seesBomb: true,
    canManual: false,
    canChat: true,
    canSpeak: true,
    canSeeTime: true,
    canSeeStrikes: true,
    hint: '你是唯一能操作炸弹的人。把屏幕上的每一个细节读出来：颜色、顺序、闪烁、数字。',
  },
  [ROLES.EXPERT]: {
    id: ROLES.EXPERT,
    name: '专家',
    icon: '📖',
    tagline: '拥有手册，看不到炸弹',
    canInteract: false,
    seesBomb: false,
    canManual: true,
    canChat: true,
    canSpeak: true,
    canSeeTime: false,
    canSeeStrikes: true,
    hint: '你看不到炸弹，只能靠队友的描述查表。问得越准，拆得越快。',
  },
  [ROLES.BLIND]: {
    id: ROLES.BLIND,
    name: '盲眼观察员',
    icon: '🙈',
    tagline: '拥有手册，但只能看到部分条目',
    canInteract: false,
    seesBomb: false,
    canManual: true,
    canChat: true,
    canSpeak: true,
    canSeeTime: false,
    canSeeStrikes: true,
    /** 只能看到每张表的一部分行，必须和其他人拼信息 */
    manualRows: 'partial',
    hint: '你的手册只有部分条目。把你看到的念出来，并问问其他专家他们看到了什么。',
  },
  [ROLES.MUTE]: {
    id: ROLES.MUTE,
    name: '静默操作员',
    icon: '🤐',
    tagline: '能看炸弹、能操作，但不能说话',
    canInteract: true,
    seesBomb: true,
    canManual: false,
    canChat: true,
    canSpeak: false,
    canSeeTime: true,
    canSeeStrikes: true,
    hint: '你可以操作炸弹，但只能通过文字频道告诉队友你看到了什么。',
  },
  // ---- 三人经典配置：参考"不听、不言、不见"的三不猴，做成语义等价的三种角色 ----
  [ROLES.BLIND_OP]: {
    id: ROLES.BLIND_OP,
    name: '盲操猴',
    icon: '🙈',
    tagline: '唯一能碰炸弹的人，但看不见颜色/数字/文字',
    canInteract: true,
    seesBomb: true,
    vision: 'blind',
    canManual: false,
    canChat: true,
    canSpeak: true,
    canSeeTime: false,
    canSeeStrikes: true,
    hint: '你的屏幕只有模块的白色轮廓：摸得到、点得动，但看不出颜色、数字和文字。要靠队友喊指令，你盲操作。',
  },
  [ROLES.DEAF_SEE]: {
    id: ROLES.DEAF_SEE,
    name: '聋桥猴',
    icon: '🙉',
    tagline: '看得见炸弹和队友的信号，但听不见任何人说话',
    canInteract: false,
    seesBomb: true,
    vision: 'full',
    canManual: false,
    canChat: true,
    canSpeak: true,
    canSeeTime: true,
    canSeeStrikes: true,
    hint: '你是唯一的沟通桥梁：看得到炸弹上的颜色数字，也看得到队友发出的信号。把两条信息拼起来，口头转述给盲操猴。',
  },
  [ROLES.MUTE_EXP]: {
    id: ROLES.MUTE_EXP,
    name: '哑手册猴',
    icon: '🙊',
    tagline: '手里有手册，但只能靠信号和打字表达',
    canInteract: false,
    seesBomb: false,
    canManual: true,
    canChat: true,
    canSpeak: false,
    canSeeTime: false,
    canSeeStrikes: true,
    hint: '手册在你手上。你不能说话（请自觉闭嘴），只能发信号、打字，或用手指/比划让聋桥猴看懂。',
  },
};

/** 三人经典配置（盲操 / 聋桥 / 哑手册） */
export const CLASSIC_THREE = [ROLES.BLIND_OP, ROLES.DEAF_SEE, ROLES.MUTE_EXP];

/** 各种角色组合的推荐预设，准备区可以一键套用 */
export const ROLE_PRESETS = [
  {
    id: 'classic3',
    name: '三人经典（不看不听不说）',
    desc: '盲操猴动手、聋桥猴转述、哑手册猴查手册 —— 三人各有残缺，必须靠"中间商式"转述',
    roles: [ROLES.BLIND_OP, ROLES.DEAF_SEE, ROLES.MUTE_EXP],
  },
  {
    id: 'classic4',
    name: '四人：盲操 + 聋桥 + 两个哑手册',
    desc: '手册拆成两半，两个哑手册猴各拿一半，都得靠信号/打字传出去',
    roles: [ROLES.BLIND_OP, ROLES.DEAF_SEE, ROLES.MUTE_EXP, 'expert2'],
  },
  {
    id: 'duo',
    name: '双人：拆弹者 + 专家',
    desc: '最经典的两人配置，你念我查表',
    roles: [ROLES.DEFUSER, ROLES.EXPERT],
  },
  {
    id: 'trio',
    name: '三人：拆弹者 + 专家 + 观察员',
    desc: '拆弹者能看能说，专家有手册，观察员有另一部分手册',
    roles: [ROLES.DEFUSER, ROLES.EXPERT, ROLES.BLIND],
  },
];

/** 4 人以上时的额外专家座位（只看到手册的一部分） */
export const EXTRA_EXPERT_ROLES = [
  {
    id: 'expert2',
    name: '专家 II',
    icon: '📗',
    tagline: '手册的另外半本',
    canInteract: false,
    seesBomb: false,
    canManual: true,
    canChat: true,
    canSpeak: true,
    canSeeTime: false,
    canSeeStrikes: true,
    manualRows: 'partial',
  },
  {
    id: 'expert3',
    name: '专家 III',
    icon: '📘',
    tagline: '手册的另外半本',
    canInteract: false,
    seesBomb: false,
    canManual: true,
    canChat: true,
    canSpeak: true,
    canSeeTime: false,
    canSeeStrikes: true,
    manualRows: 'partial',
  },
];

export const MAX_PLAYERS = 6;

export const TIERS = [1, 2, 3, 4, 5];

export const COLORS = {
  red: { id: 'red', name: '红', css: '#e5484d', text: '#fff' },
  blue: { id: 'blue', name: '蓝', css: '#3b82f6', text: '#fff' },
  yellow: { id: 'yellow', name: '黄', css: '#eab308', text: '#1a1a1a' },
  green: { id: 'green', name: '绿', css: '#22c55e', text: '#0b1a10' },
  white: { id: 'white', name: '白', css: '#f4f4f5', text: '#1a1a1a' },
  black: { id: 'black', name: '黑', css: '#27272a', text: '#fff' },
  orange: { id: 'orange', name: '橙', css: '#f97316', text: '#1a1a1a' },
  purple: { id: 'purple', name: '紫', css: '#a855f7', text: '#fff' },
};

export const COLOR_ORDER = ['red', 'blue', 'yellow', 'green', 'white', 'black', 'orange', 'purple'];

export function colorName(id) { return (COLORS[id] || { name: id }).name; }
export function colorCss(id) { return (COLORS[id] || { css: '#888' }).css; }

export const DIFFICULTIES = {
  easy: {
    id: 'easy',
    name: '简单',
    desc: '模块少、时间宽裕、失误上限高',
    modules: [3, 3],
    tierWeights: { 1: 6, 2: 4, 3: 1, 4: 0, 5: 0 },
    timeSec: 300,
    maxStrikes: 5,
    manualRows: 'full',
    timePenaltySec: 15,
  },
  normal: {
    id: 'normal',
    name: '普通',
    desc: '标准体验',
    modules: [4, 4],
    tierWeights: { 1: 3, 2: 5, 3: 4, 4: 1, 5: 0 },
    timeSec: 300,
    maxStrikes: 3,
    manualRows: 'full',
    timePenaltySec: 20,
  },
  hard: {
    id: 'hard',
    name: '困难',
    desc: '模块更多、失误上限 3',
    modules: [5, 5],
    tierWeights: { 1: 1, 2: 3, 3: 5, 4: 4, 5: 1 },
    timeSec: 270,
    maxStrikes: 3,
    manualRows: 'full',
    timePenaltySec: 25,
  },
  expert: {
    id: 'expert',
    name: '专家',
    desc: '2 次失误就爆炸，专家只能看到部分条目',
    modules: [6, 6],
    tierWeights: { 1: 0, 2: 1, 3: 3, 4: 5, 5: 5 },
    timeSec: 210,
    maxStrikes: 2,
    manualRows: 'partial',
    timePenaltySec: 30,
  },
  nightmare: {
    id: 'nightmare',
    name: '噩梦',
    desc: '7 个高难度模块、1 次失误、部分条目',
    modules: [7, 7],
    tierWeights: { 1: 0, 2: 0, 3: 1, 4: 4, 5: 6 },
    timeSec: 240,
    maxStrikes: 1,
    manualRows: 'partial',
    timePenaltySec: 30,
  },
};

export const DIFFICULTY_ORDER = ['easy', 'normal', 'hard', 'expert', 'nightmare'];

export const INDICATORS = ['SIG', 'CAR', 'FRK', 'BOB', 'TRN', 'MSA', 'FRQ', 'CLR', 'SND', 'NSA', 'IND', 'BOO'];
export const PORTS = [
  { id: 'serial', name: 'Serial' },
  { id: 'parallel', name: 'Parallel' },
  { id: 'rca', name: 'Stereo RCA' },
  { id: 'dvid', name: 'DVI-D' },
  { id: 'usb', name: 'USB' },
  { id: 'rj45', name: 'RJ-45' },
];
export const BATTERY_TYPES = [
  { id: 'AA', name: 'AA 电池' },
  { id: 'D', name: 'D 电池' },
];
