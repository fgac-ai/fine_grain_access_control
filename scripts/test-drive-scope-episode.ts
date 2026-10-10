/**
 * Unit tests for the server-side Drive scope episode recorder
 * (src/lib/driveScopeEpisode.ts): a completed full-`drive` enable records
 * `drive_scope_enabled` exactly once, from whichever surface sees it first.
 * Run: npx tsx scripts/test-drive-scope-episode.ts  (part of `npm run mcp:lint`)
 */
import { observeDriveFullScope, _resetDriveScopeCache, type DriveScopeObservation, type DriveScopeStore } from '../src/lib/driveScopeEpisode';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

/** In-memory stand-in for users.drive_full_scope_since with the same atomic
 *  conditional-update semantics as the Drizzle store. */
function fakeStore(initial: { held?: boolean; configured?: boolean } = {}) {
  const state = { held: initial.held ?? false, configured: initial.configured ?? false, writes: 0 };
  const store: DriveScopeStore = {
    async markHeld() {
      state.writes++;
      if (state.held) return null;
      state.held = true;
      const reenable = state.configured;
      state.configured = true;
      return { reenable };
    },
    async markLost() {
      state.writes++;
      if (!state.held) return false;
      state.held = false;
      return true;
    },
  };
  return { store, state };
}

function recorder() {
  const events: Array<{ id: string; event: string; props: Record<string, unknown> }> = [];
  return { events, capture: (id: string, event: string, props: Record<string, unknown>) => { events.push({ id, event, props }); } };
}

const base: DriveScopeObservation = {
  userId: 'u1', clerkUserId: 'user_1', flagOn: true, hasDriveFullScope: true, lossCertain: true, surface: 'dashboard',
};

(async () => {
  console.log('enable is recorded once:');
  {
    _resetDriveScopeCache();
    const { store } = fakeStore();
    const { events, capture } = recorder();
    // The return leg's server render sees the scope (the card that used to
    // capture the event is never mounted on this path).
    await observeDriveFullScope({ ...base, returnLeg: true }, store, capture);
    // A router.refresh, a second tab, and the agent's next tool calls.
    await observeDriveFullScope(base, store, capture);
    await Promise.all([1, 2, 3].map(() => observeDriveFullScope({ ...base, surface: 'mcp', lossCertain: false }, store, capture)));
    const enabled = events.filter(e => e.event === 'drive_scope_enabled');
    check('exactly one drive_scope_enabled across repeated + concurrent observations', enabled.length === 1);
    check('distinct id is the Clerk id', enabled[0]?.id === 'user_1');
    check('first enable is not a re-enable', enabled[0]?.props.reenable === false);
    check('return leg + surface recorded', enabled[0]?.props.return_leg === true && enabled[0]?.props.surface === 'dashboard');
  }

  console.log('grant made outside the dashboard (nav UserButton) is recorded by the MCP path:');
  {
    _resetDriveScopeCache();
    const { store, state } = fakeStore();
    const { events, capture } = recorder();
    const r = await observeDriveFullScope({ ...base, surface: 'mcp', lossCertain: false }, store, capture);
    check('MCP observation records the enable', r === 'enabled' && events[0]?.props.surface === 'mcp' && events[0]?.props.return_leg === false);
    const writes = state.writes;
    for (let i = 0; i < 50; i++) await observeDriveFullScope({ ...base, surface: 'mcp', lossCertain: false }, store, capture);
    check('MCP hot path: no further DB writes once known held', state.writes === writes);
    check('still one event', events.length === 1);
  }

  console.log('flag and certainty gates:');
  {
    _resetDriveScopeCache();
    const { store, state } = fakeStore({ held: true });
    const { events, capture } = recorder();
    await observeDriveFullScope({ ...base, flagOn: false }, store, capture);
    await observeDriveFullScope({ ...base, flagOn: false, hasDriveFullScope: false }, store, capture);
    check('flag off: nothing written, nothing captured', state.writes === 0 && events.length === 0);
    await observeDriveFullScope({ ...base, hasDriveFullScope: false, lossCertain: false }, store, capture);
    check('uncertain absence (tokeninfo failed) never ends an episode', state.held && events.length === 0);
  }

  console.log('loss then regain is a re-enable, recorded again once:');
  {
    _resetDriveScopeCache();
    const { store } = fakeStore();
    const { events, capture } = recorder();
    await observeDriveFullScope(base, store, capture);
    await observeDriveFullScope({ ...base, hasDriveFullScope: false }, store, capture);
    await observeDriveFullScope({ ...base, hasDriveFullScope: false }, store, capture);
    await observeDriveFullScope(base, store, capture);
    await observeDriveFullScope(base, store, capture);
    const names = events.map(e => e.event);
    check('enabled → lost → enabled, no duplicates', JSON.stringify(names) === JSON.stringify(['drive_scope_enabled', 'drive_scope_lost', 'drive_scope_enabled']));
    check('second enable carries reenable: true', events[2]?.props.reenable === true);
  }

  console.log('a stale MCP cache never masks a dashboard observation:');
  {
    _resetDriveScopeCache();
    const { store, state } = fakeStore();
    const { events, capture } = recorder();
    await observeDriveFullScope({ ...base, surface: 'mcp', lossCertain: false }, store, capture);
    state.held = false; // another instance's dashboard render ended the episode
    await observeDriveFullScope(base, store, capture);
    check('dashboard asks the store, re-enable recorded', events.filter(e => e.event === 'drive_scope_enabled').length === 2);
  }

  if (failures > 0) { console.error(`\n${failures} failure(s)`); process.exit(1); }
  console.log('\nAll drive scope episode tests passed.');
})();
