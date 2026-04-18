import { defineConfig } from 'vitest/config'

// Three test surfaces (run with `npm test` — excludes tests/live by default):
//
//   - tests/unit/**        → pure-function tests (fast, no I/O, CI always)
//   - tests/integration/** → multi-module pipeline tests that compose pure
//                            helpers the way server.ts does. Still no
//                            network I/O, so they're safe to run in CI.
//   - tests/live/**        → two-call regressions against a real deployed
//                            preview. Require PROXY_URL + PROBE_API_KEY;
//                            opt-in via LIVE_TESTS=1 env var. Excluded
//                            from `npm test` so a missing API key doesn't
//                            fail CI.
//
// `npm run test:live` (see package.json) runs the live subset explicitly.
const LIVE = process.env.LIVE_TESTS === '1'

export default defineConfig({
  test: {
    environment: 'node',
    include: LIVE
      ? ['tests/live/**/*.test.ts']
      : ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    testTimeout: LIVE ? 60_000 : 5000,
  },
})
