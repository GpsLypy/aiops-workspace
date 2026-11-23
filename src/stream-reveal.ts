// Pace only text already received. The completed response remains authoritative.
export function createStreamReveal(paint: (text: string) => void, options: {
  reducedMotion?: boolean;
  schedule?: (callback: FrameRequestCallback) => number;
  cancel?: (id: number) => void;
} = {}) {
  const schedule = options.schedule || requestAnimationFrame;
  const cancel = options.cancel || cancelAnimationFrame;
  let target = '', shown = '', frame = 0, last = 0, ending = false, restarting = false;
  let resolveEnd: (() => void) | undefined;
  const tick = (time: number) => {
    frame = 0;
    // A retry regenerates the answer from the beginning. Keep the last visible
    // draft until the new attempt catches up; never concatenate both attempts.
    if (restarting && target.length <= shown.length) return;
    restarting = false;
    const elapsed = last ? Math.min(48, time - last) : 32;
    if (elapsed >= 32 || !last) {
      last = time;
      const remaining = target.length - shown.length;
      let end = options.reducedMotion ? target.length : Math.min(target.length, shown.length + Math.max(1, Math.ceil(elapsed * .09), Math.ceil(remaining * elapsed / 160)));
      // Never expose half of an emoji/supplementary Unicode character.
      if (end < target.length && /[\uD800-\uDBFF]/.test(target[end - 1])) end++;
      const next = target.slice(0, end);
      if (next !== shown) { shown = next; paint(shown); }
    }
    if (shown !== target) frame = schedule(tick);
    else if (ending) { resolveEnd?.(); resolveEnd = undefined; }
  };
  const start = () => { if (!frame) frame = schedule(tick); };
  const reset = () => {
    if (frame) cancel(frame);
    frame = 0; target = ''; shown = ''; last = 0; ending = false; restarting = false;
    resolveEnd?.(); resolveEnd = undefined;
  };
  return {
    append(text: string) { target += text; start(); },
    restart() {
      if (frame) cancel(frame);
      frame = 0; target = ''; last = 0; ending = false; restarting = true;
      resolveEnd?.(); resolveEnd = undefined;
    },
    finish(text: string) {
      target = text; ending = true; restarting = false;
      if (!text.startsWith(shown)) { shown = text; paint(text); }
      return new Promise<void>(resolve => { resolveEnd = resolve; start(); });
    },
    reset,
    dispose: reset,
  };
}
