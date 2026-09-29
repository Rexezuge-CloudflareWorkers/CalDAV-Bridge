/**
 * Notice state, shared between the hook that owns it and the bar that renders it.
 *
 * This was a React context with a `useShowNotice` accessor, provided around the
 * whole app but never read: every component received `showNotice` as a prop
 * instead. The context was a second, unused path to the same value. What remains
 * is the state itself, which `useNotice` owns and `NoticeBar` receives.
 */

export type NoticeType = 'success' | 'error';

export interface Notice {
  type: NoticeType;
  text: string;
}
