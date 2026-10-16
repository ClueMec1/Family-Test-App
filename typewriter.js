// Time-based typewriter. The typed state is a pure function of elapsed time, so the
// console preview, a second display window and a reloaded page all stay in sync.

export const LINE_PAUSE = 380;      // ms pause between lines
export const START_DELAY = 250;

export function scriptFor(slide) {
  const lines = [Array.from(slide.question || '')];
  (slide.options || []).forEach((o) => lines.push(Array.from(o || '')));
  return lines;
}

export function typingDuration(slide) {
  const sp = slide.typeSpeed ?? 45;
  const lines = scriptFor(slide);
  return START_DELAY + lines.reduce((t, l) => t + Math.max(1, l.length) * sp, 0) + LINE_PAUSE * (lines.length - 1);
}

/**
 * @returns {{counts:number[], line:number, done:boolean}}
 *   counts[i] = visible characters of line i (-1 = line not started yet)
 *   line      = index of the line currently being typed
 */
export function typedAt(slide, elapsed) {
  const sp = Math.max(1, slide.typeSpeed ?? 45);
  const lines = scriptFor(slide);
  let t = elapsed - START_DELAY;
  const counts = lines.map(() => -1);
  for (let i = 0; i < lines.length; i++) {
    if (t < 0) return { counts, line: i, done: false };
    const len = Math.max(1, lines[i].length);
    const dur = len * sp;
    if (t < dur) {
      counts[i] = Math.min(lines[i].length, Math.floor(t / sp) + 1);
      return { counts, line: i, done: false };
    }
    counts[i] = lines[i].length;
    t -= dur + LINE_PAUSE;
  }
  return { counts, line: lines.length - 1, done: true };
}
