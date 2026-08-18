# e2e

Multi-peer tests that drive real browsers against the real relay.

```sh
./browsers.sh                        # one headless Firefox per peer
node scenarios/sync-recovers.mjs
```

## Why it exists

The bugs that bite this app are partial failures: a message that never
arrives, a peer that cannot be dialled, a connect event that never fires. None
of them happen on a loopback, where every dial succeeds first try and nothing
is ever lost. Several fixes were shipped this week that passed identically
before and after the change, which proved nothing. So the tests cause the
failures on purpose.

`window.__faults` (dev builds only) drops frames by wire type, blocks dials and
swallows transport events. `window.__awful.stats` counts profiles and digests
in and out, which is the difference between "presence is broken" and "the
profile was sent, arrived, and was rejected".

## What the tests assert

Convergence, not event ordering: inject a fault, generate activity, heal, then
require every peer to end up holding the same thing. It survives refactoring
and it is what a user actually cares about.

## Rules the driver follows

Learned from a day of tests that failed for harness reasons rather than app
reasons, each of which produced a confident and completely invalid result:

- No fixed sleeps. Everything waits on a condition with a deadline, and a
  timeout dumps what the page was actually showing.
- Wipe storage, caches and the service worker before each run. This is a PWA;
  without that the page serves a bundle from an earlier run and the test
  measures code that is no longer in the repo.
- Open rooms through the app's router, never by clicking a sidebar row. These
  profiles accumulate dozens of similarly named rooms.
- Retry clicks until the state changes. A single click can land before the
  handler is wired.
- Never reach into app modules with `import()`. It resolves to a second module
  instance with its own transport, and the readings are meaningless.
- Always close sessions, or the next run dies with "Maximum number of active
  sessions".
