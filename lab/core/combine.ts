/* 컨트롤러 여러 개를 한 실행에 함께 건다. 순서대로 tick한다. */
import type { Controller } from './run';

export function combine(...cs: (Controller | null | undefined)[]): Controller {
  const list = cs.filter((c): c is Controller => !!c);
  return {
    init: (e, t) => list.forEach((c) => c.init?.(e, t)),
    tick: (e, s, t) => list.flatMap((c) => c.tick(e, s, t)),
  };
}
