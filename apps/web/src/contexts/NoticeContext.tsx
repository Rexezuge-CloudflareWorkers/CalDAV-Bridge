import { createContext, useContext } from 'react';

export type NoticeType = 'success' | 'error';

export interface Notice {
  type: NoticeType;
  text: string;
}

interface NoticeContextValue {
  showNotice: (type: NoticeType, text: string) => void;
}

export const NoticeContext = createContext<NoticeContextValue | null>(null);

export function useShowNotice(): (type: NoticeType, text: string) => void {
  const ctx = useContext(NoticeContext);
  if (!ctx) throw new Error('useShowNotice must be used inside NoticeContext.Provider');
  return ctx.showNotice;
}
