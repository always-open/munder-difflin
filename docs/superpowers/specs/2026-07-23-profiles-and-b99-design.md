# Agent Profiles (#105) + Finish Brooklyn Nine-Nine (#103) — design

Status: approved 2026-07-23. Two independent features; disjoint files.

## Feature 1 — Agent Profiles (#105)

**Problem.** Issue #105: a user runs separate work/personal Claude accounts via
`CLAUDE_CONFIG_DIR=~/.claude-personal claude`. MD can't set that env var (doesn't
read the shell alias, no manual-env path), so the separation is impossible in-app.

**Approach: Named Profiles** (chosen over minimal env-only). A reusable named
bundle of environment + spawn defaults, managed in Settings, selectable at hire.
Solves #105 exactly and generalizes to one-click "hire a work-account reviewer."

**Data.** New optional `HarnessConfig.profiles?: Profile[]` where
`Profile = { id: string; label: string; env?: Record<string,string>; model?: string; command?: string; provider?: AgentProvider }`.
Mirrored in the preload `HarnessConfig` type.

**UI.**
- Settings → new self-contained `ProfilesEditor` section (pattern: `OfficeThemePicker`):
  list / add / edit / delete; each profile edits a label, env key/value rows, and
  optional model/command overrides.
- `AddAgentModal` → a **Profile** dropdown; selecting one prefills model/command
  and attaches the profile's env to the spawn.

**Data flow.** `profile.env` → `AgentSpawnOptions.env` (this field already exists
and is already merged over the resolved shell env in `pty.ts`; today it only
carries the integration-broker token). In `spawnAgentCore` the merge becomes
`env: { ...profileEnv, ...brokerEnv }` — broker keys win, so a profile can never
clobber the capability token. `CLAUDE_CONFIG_DIR` and broker keys are disjoint.

**Persistence.** The *resolved* env snapshot (plus model/command) is stored on the
agent's persisted recipe — extending round 2's `updateAgent` durable-field
persistence — so Restore / auto-revive re-applies it even if the profile is later
edited or deleted. (Storing the snapshot, not a profileId, is robust to profile
deletion.)

**Security.** Env values live in `config.json` alongside existing secrets
(`slackSigningSecret` etc.) — consistent with current storage; the motivating
value (`CLAUDE_CONFIG_DIR`) is a path, not a secret.

**Tests** (`test/profiles.test.cjs`, framework-free like the others): config
profile CRUD; spawn-env merge precedence (profile env present; broker token not
clobbered); persisted-recipe env round-trips through restore.

**Files (owner: profiles workstream).** `src/main/config.ts`, `src/preload/index.ts`,
`src/main/index.ts` (spawnAgentCore env merge only), `src/renderer/src/store/store.ts`,
`src/renderer/src/store/config.ts`, `src/renderer/src/components/SettingsModal.tsx`,
`src/renderer/src/components/AddAgentModal.tsx`, new
`src/renderer/src/components/ProfilesEditor.tsx`, `test/profiles.test.cjs`.

## Feature 2 — Finish Brooklyn Nine-Nine (#103)

**Reality.** The B99 theme's map (`brooklyn99.tmj`, 14KB) and full wiring (seats,
cafe, coffee economy, errand spots, anchors) are complete; only the *visuals* —
`tilesets`, `palette`, `cast` — reuse the office verbatim, yet `OfficeThemePicker`
already marks it `built: true`. That mismatch is the audit's "oversell."

**Constraint.** No licensed B99 sprite/tileset art can be sourced. Scope is limited
to what differentiates the theme *without* new art.

**Approach — honest, art-free polish:**
1. **Distinct palette.** Give B99 its own `palette` (precinct blue-gray `background`
   + `noteColors`) instead of inheriting `OFFICE_THEME.palette`. Drives the canvas
   clear color (`OfficeFloor:186`) and speech-act note tints (`OfficeFloor:954`).
2. **Tileset tint (conditional).** If `TiledMapRenderer` can tint the tilemap
   sprites, apply a precinct tone for a real visual shift. First implementation
   step verifies the capability; NOT load-bearing — palette + layout stand alone.
3. **Map/prop polish.** Restamp the bullpen with existing office+interiors tileset
   gids (evidence board, lockers, Holt's glass office) so it reads as a precinct.
   Bounded and optional — the map is already B99-shaped; skip if not verifiable.
4. **Status-viz verification.** Confirm avatars, thought bubbles, message
   envelopes, and breaker/hook status render correctly on the B99 map (the issue's
   real requirement: "a way to visualise the status of agents").
5. **Honesty.** Fix the `PLACEHOLDER` comments; keep `built: true` only if the
   palette + layout differentiation genuinely stands on its own, else mark it
   accurately in the picker.

**Explicitly not doing.** New licensed TV sprites; the declared-empty
FRIENDS/Stranger Things/etc. themes (art-gated — would ship more placeholders).

**Verification.** No renderer test harness exists; verify via `npm run typecheck`
plus a visual check in the relaunched app after a feature-merge restart.

**Files (owner: B99 workstream).** `src/renderer/src/scene/office/themeRegistry.ts`,
`src/renderer/src/assets/maps/brooklyn99.tmj`, `src/renderer/src/components/OfficeThemePicker.tsx`,
`src/renderer/src/scene/office/OfficeFloor.tsx` + tile renderer (tint, if supported).
