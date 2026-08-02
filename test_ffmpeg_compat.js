// Regression test for extension/ffmpeg_compat.js.
// Run: node test_ffmpeg_compat.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const calls = [];
const removed = [];
const relayed = [];

class MockFFmpeg {
  constructor(responses) {
    this.responses = responses || [];
  }

  async exec(args) {
    calls.push(args.slice());
    return this.responses.length ? this.responses.shift() : 0;
  }

  async deleteFile(name) {
    removed.push(name);
  }
}

const ctx = vm.createContext({
  FFmpegWASM: { FFmpeg: MockFFmpeg },
  compatRelayed: relayed,
  console,
});
vm.runInContext(`
  const ffLog = [];
  function relayLog(message) { compatRelayed.push(message); }
`, ctx);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, 'extension', 'ffmpeg_compat.js'), 'utf8'),
  ctx,
  { filename: 'ffmpeg_compat.js' },
);

async function main() {
  const failing = new MockFFmpeg([1, 0]);
  vm.runInContext(`
    ffLog.push('[webm @ 0x1] Error applying bitstream filters to an output packet for stream #0: Function not implemented');
  `, ctx);

  const ret = await failing.exec([
    '-i', 'video.webm', '-i', 'audio.webm',
    '-map', '0:v:0', '-map', '1:a:0',
    '-c', 'copy', 'piece.webm',
  ]);

  assert.strictEqual(ret, 0, 'совместимый повтор не вернул успешный код');
  assert.strictEqual(calls.length, 2, 'команда WebM не была повторена ровно один раз');
  assert.deepStrictEqual(calls[1].slice(-3), ['-fflags', '-autobsf', 'piece.webm']);
  assert.deepStrictEqual(removed, ['piece.webm'], 'частичный WebM не удалён перед повтором');
  assert.ok(relayed.some((s) => /без autobsf/.test(s)), 'fallback не попал в журнал запуска');

  calls.length = 0;
  removed.length = 0;
  vm.runInContext(`ffLog.length = 0; ffLog.push('Invalid data found when processing input');`, ctx);
  const unrelated = new MockFFmpeg([1]);
  const unrelatedRet = await unrelated.exec(['-i', 'bad.webm', '-c', 'copy', 'bad.webm']);
  assert.strictEqual(unrelatedRet, 1);
  assert.strictEqual(calls.length, 1, 'посторонняя ошибка ошибочно запустила fallback');
  assert.strictEqual(removed.length, 0);

  calls.length = 0;
  vm.runInContext(`
    ffLog.length = 0;
    ffLog.push('Error applying bitstream filters: Function not implemented');
  `, ctx);
  const alreadyFallback = new MockFFmpeg([1]);
  await alreadyFallback.exec([
    '-i', 'video.webm', '-c', 'copy',
    '-fflags', '-autobsf', 'piece.webm',
  ]);
  assert.strictEqual(calls.length, 1, 'fallback зациклился на уже исправленной команде');

  console.log('ffmpeg_compat: ok');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
