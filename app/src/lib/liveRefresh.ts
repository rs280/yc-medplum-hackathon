/**
 * A latch the calendar holds while a drag is in flight, so the workspace's 4s
 * AutoRefresh cannot swap the appointment array out from under a gesture.
 * A module singleton rather than context: the app has no state management and
 * this has exactly one producer and one consumer.
 */

let held = 0;

export function suspendLiveRefresh(): void {
  held += 1;
}

export function resumeLiveRefresh(): void {
  held = Math.max(0, held - 1);
}

export function isLiveRefreshSuspended(): boolean {
  return held > 0;
}
