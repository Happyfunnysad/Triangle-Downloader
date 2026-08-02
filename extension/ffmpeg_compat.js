// Compatibility fallback for the compact ffmpeg.wasm build bundled with the
// extension. Some VP9 WebM packets make its automatically inserted bitstream
// filter return ENOSYS ("Function not implemented") during stream copy.
//
// The source packets already come from WebM, so only after that exact failure we
// retry the same remux with AVFMT_FLAG_AUTO_BSF disabled. Normal commands keep
// the default FFmpeg behaviour, and a failed retry is still reported upstream.
(() => {
  if (typeof FFmpegWASM === 'undefined' || !FFmpegWASM.FFmpeg) return;
  const proto = FFmpegWASM.FFmpeg.prototype;
  if (!proto || typeof proto.exec !== 'function' || proto.exec.__triangleWebmCompat) return;

  const originalExec = proto.exec;
  const wrappedExec = async function triangleWebmCompat(args, ...rest) {
    const ret = await originalExec.call(this, args, ...rest);
    if (ret === 0 || !Array.isArray(args) || !args.length) return ret;

    const output = String(args[args.length - 1] || '');
    const streamCopy = args.some((arg, i) =>
      /^(?:-c|-codec|-vcodec|-acodec)(?::[^ ]+)?$/.test(String(arg)) && args[i + 1] === 'copy');
    const autobsfDisabled = args.some((arg, i) =>
      arg === '-fflags' && String(args[i + 1] || '').split(',').includes('-autobsf'));
    const log = typeof ffLog !== 'undefined' ? ffLog.join('\n') : '';

    if (!/\.webm$/i.test(output) || !streamCopy || autobsfDisabled ||
        !/(?:Error applying bitstream filters|Function not implemented)/i.test(log)) {
      return ret;
    }

    try { await this.deleteFile(output); } catch (e) {}
    const retryArgs = [
      ...args.slice(0, -1),
      '-fflags', '-autobsf',
      output,
    ];

    if (typeof ffLog !== 'undefined') ffLog.length = 0;
    try {
      if (typeof relayLog === 'function') {
        relayLog('WebM: bitstream filter ffmpeg.wasm недоступен — повторяю stream copy без autobsf');
      }
    } catch (e) {}

    return originalExec.call(this, retryArgs, ...rest);
  };

  wrappedExec.__triangleWebmCompat = true;
  proto.exec = wrappedExec;
})();
