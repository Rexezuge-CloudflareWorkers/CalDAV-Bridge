import type { CurrentUser } from '../types';
import { apiFetch, readJson } from '../lib/api';

export async function loadCurrentUser(): Promise<CurrentUser> {
  return readJson<CurrentUser>(await apiFetch('/user/me'));
}
