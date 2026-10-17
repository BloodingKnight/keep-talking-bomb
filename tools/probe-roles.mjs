// Focused probe: join 5 players with the same order as the e2e test and print
// the role each player actually ended up with.
const B = process.argv[2] || 'http://127.0.0.1:3390';

async function api(path, body) {
  const res = await fetch(B + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const state = async (room, player) => (await fetch(`${B}/api/state?room=${room}&player=${player}`).then((r) => r.json())).state;

const host = (await api('/api/create', { name: '房主', difficulty: 'normal' })).data;
const room = host.roomCode;
console.log('room', room, 'host role', host.role);

const seq = [
  ['defuser', 'defuser'],
  ['expert', 'expert'],
  ['blind', 'blind'],
  ['mute', 'mute'],
  ['extra', 'expert2'],
];
const ids = {};
for (const [name, role] of seq) {
  const r = await api('/api/join', { room, name, role });
  ids[name] = r.data.playerId;
  console.log(`join ${name.padEnd(8)} role=${String(role).padEnd(8)} -> status ${r.status} returned role=${r.data.role} ${r.data.error || ''}`);
}
const lobby = await state(room, ids.defuser);
console.log('players:', lobby.room.players.map((p) => `${p.name}=${p.role}`).join(', '));

await api('/api/action', { room, playerId: host.playerId, type: 'start' });
for (const name of Object.keys(ids)) {
  const s = await state(room, ids[name]);
  console.log(`${name.padEnd(8)} view: role=${s.you.role} canInteract=${s.canInteract} manual=${s.manual ? s.manual.mode : 'none'} bombState=${s.bomb?.moduleStates?.[0]?.state ? 'yes' : 'no'}`);
}
