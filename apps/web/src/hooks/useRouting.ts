import { useCallback, useEffect, useState } from 'react';
import type { Route } from '../types';
import { parseRoute, routePath } from '../types';

export function useRouting() {
  const [route, setRoute] = useState<Route>(() => parseRoute(globalThis.location.pathname));

  useEffect(() => {
    const handlePopState = () => setRoute(parseRoute(globalThis.location.pathname));
    globalThis.addEventListener('popstate', handlePopState);
    return () => globalThis.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback((next: Route) => {
    globalThis.history.pushState(null, '', routePath(next));
    setRoute(next);
  }, []);

  const replaceRoute = useCallback((next: Route) => {
    globalThis.history.replaceState(null, '', routePath(next));
    setRoute(next);
  }, []);

  return { route, navigate, replaceRoute };
}
