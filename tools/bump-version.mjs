// 统一把版本号写进 tauri.conf.json 与 Cargo.toml。
//   node tools/bump-version.mjs 1.1.8
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('用法: node tools/bump-version.mjs 1.1.8');
  process.exit(1);
}

const confPath = path.join(ROOT, 'src-tauri', 'tauri.conf.json');
const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
conf.version = version;
fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n', 'utf8');

const cargoPath = path.join(ROOT, 'src-tauri', 'Cargo.toml');
const cargo = fs.readFileSync(cargoPath, 'utf8');
const next = cargo.replace(/^version = "[^"]+"/m, `version = "${version}"`);
fs.writeFileSync(cargoPath, next, 'utf8');

// package.json 也一起（发布页/文档里会引用）
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

console.log(`[version] tauri.conf.json / Cargo.toml / package.json -> ${version}`);
