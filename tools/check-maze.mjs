// Consistency check for the generated maze walls: for every pair of adjacent
// cells, "cell A has an E wall" and "cell B has a W wall" must agree.
import { Rng } from '../lib/rng.js';
import { MODULES } from '../lib/modules.js';

const N = 6;
const cfg = { serial: 'AB1CD23', batteries: 1, batteryTypes: ['AA'], indicatorMap: {}, ports: [] };
let bad = 0;
for (let i = 0; i < 200; i++) {
  const mod = MODULES.maze.make(new Rng(`maze-${i}`), cfg, 4);
  const w = mod.solution.walls;
  const at = (c, r) => w[r * N + c];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const bits = at(c, r);
      const eastWall = !!(bits & 2);
      const westOfEast = c + 1 < N ? !!(at(c + 1, r) & 8) : true;
      const southWall = !!(bits & 4);
      const northOfSouth = r + 1 < N ? !!(at(c, r + 1) & 1) : true;
      const northWall = !!(bits & 1);
      const southOfNorth = r - 1 >= 0 ? !!(at(c, r - 1) & 4) : true;
      const westWall = !!(bits & 8);
      const eastOfWest = c - 1 >= 0 ? !!(at(c - 1, r) & 2) : true;
      if (eastWall !== westOfEast || southWall !== northOfSouth || northWall !== southOfNorth || westWall !== eastOfWest) {
        if (bad++ < 5) {
          console.log(`seed maze-${i}: cell(${c},${r}) bits=${bits.toString(2).padStart(4, '0')} ` +
            `E=${eastWall}/${{ true: 'W', false: 'noW' }[westOfEast]} S=${southWall}/${northOfSouth} N=${northWall}/${southOfNorth} W=${westWall}/${eastOfWest}`);
        }
      }
    }
  }
}
console.log(bad ? `发现 ${bad} 处墙不一致` : '所有迷宫墙数据一致');
