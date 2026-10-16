// The address registry is the kit's (`@rexezuge/identity`) now: an address maps
// to one account, `is_verified` gates login, and a revoked row is re-pointed --
// never deleted -- when a later account legitimately claims the address.
// Re-exported here so this repo's DAO barrel keeps one import source.
export { UserEmailDAO } from '@rexezuge/identity';
export type { EmailClaim, UserEmailRow } from '@rexezuge/identity';
