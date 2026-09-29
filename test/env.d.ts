/**
 * The Workers bindings, as globals, for the test project.
 *
 * The alias lives in each application's own `env.d.ts` because that is where the
 * workers need it. The tests reach into `apps/api` and `apps/background`, so
 * those files are pulled in for the same reason -- without them a test that
 * constructs a fake `Env` would not typecheck.
 */

type Env = CloudflareEnv;
