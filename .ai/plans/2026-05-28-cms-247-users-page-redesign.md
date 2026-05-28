# CMS-247 Users Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the new MDCMS Studio design system to the Users page while preserving the existing user-management contracts and owner safeguards.

**Architecture:** Keep the work inside the Studio runtime UI because the server contract is already implemented. Update the owning specs first, add focused tests around role/scope/payload helpers and server-rendered page states, then restyle `users-page.tsx` using the existing Tailwind design tokens and Lucide icons.

**Tech Stack:** React 19, Bun test, TanStack Query, Tailwind CSS 4, Radix UI primitives, Lucide React.

---

## Spec Delta

- `docs/specs/SPEC-005-auth-authorization-and-request-routing.md` distinguishes invite grant inputs from grant update inputs. Invites exclude `owner`; grant updates include `owner` with owner-only and final-owner safeguards.
- `docs/specs/SPEC-006-studio-runtime-and-ui.md` adds a standalone `/admin/users` route behavior section covering capability gating, pending invitations, members table, role/scope display, dialogs, mutation endpoints, states, and responsive behavior.

## Files

- Modify: `docs/specs/SPEC-005-auth-authorization-and-request-routing.md`
- Modify: `docs/specs/SPEC-006-studio-runtime-and-ui.md`
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/users-page-model.ts`
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/users-page.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/users-page.test.tsx`

## Task 1: Users Page Tests

- [x] **Step 1: Write failing tests**

Add tests in `packages/studio/src/lib/runtime-ui/app/admin/users-page.test.tsx` for:

```typescript
test("UsersPage renders the redesigned members and invitations layout", () => {
  const markup = renderUsersPage({
    capabilities: { canManageUsers: true },
    users: [ownerUser, folderScopedEditor],
    pendingInvites: [pendingViewerInvite],
  });

  assert.match(markup, /Awaiting acceptance/);
  assert.match(markup, /Active members/);
  assert.match(markup, /content\/blog/);
  assert.match(markup, /Full project/);
});
```

Add pure helper tests for highest-role ranking, folder-prefix scope labels, invite grant payloads, update grant payloads with Owner, and owner action blocking.

- [x] **Step 2: Verify red**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/app/admin/users-page.test.tsx
```

Expected: FAIL because the new helper exports and layout labels do not exist yet.

## Task 2: Users Page Implementation

- [x] **Step 1: Implement helper exports**

Add exported helpers in `users-page-model.ts`:

```typescript
export function getHighestRole(grants: UserWithGrants["grants"]): Role
export function getScopeDisplay(grants: UserWithGrants["grants"]): ScopeDisplay
export function createGrantInput(...)
export function createUpdatedGrants(...)
export function canUseOwnerProtectedAction(role: Role): boolean
```

- [x] **Step 2: Restyle page components**

Rework `InviteUserDialog`, `EditRoleDialog`, `PendingInvitesList`, `UsersTable`, and state views to match the design bundle: offwhite canvas, flat cards, mono labels, role badges, scope chips, compact row actions, and responsive table scroll.

- [x] **Step 3: Preserve mutations**

Keep `inviteUser`, `updateGrants`, `revokeSessions`, `removeUser`, and `revokeInvite` wired through `useUserList`. Keep CSRF/cookie behavior untouched.

- [x] **Step 4: Verify green**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/app/admin/users-page.test.tsx
```

Expected: PASS.

## Task 3: Verification

- [x] **Step 1: Run targeted Studio tests**

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/app/admin/users-page.test.tsx ./src/lib/users-api.test.ts
```

- [x] **Step 2: Run touched workspace checks**

```bash
bun run check
```

- [x] **Step 3: Visual review**

Run the Studio example or available runtime target, open `/admin/users`, and compare against `/private/tmp/mdcms-design-artifact-extract/mdcms-design-system/project/ui_kits/studio/UsersPage.jsx` and `users.html`.
