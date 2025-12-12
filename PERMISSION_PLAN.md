# Reprocess API Permission Plan

## Overview

Add permission checking and collection-bounded cascading to the reprocess API. The key insight is that cascading up to the **collection root** is the natural boundary - it doesn't make sense to cascade beyond your collection.

## Current State

### What We Have
- `POST /api/reprocess` endpoint accepts `pi`, `phases`, `cascade`, and `options.stop_at_pi`
- `resolver.ts` walks up `parent_pi` chain until `stop_at_pi` or no parent
- **No authentication or permission checking**
- Default `stop_at_pi` is `00000000000000000000000000` (essentially unlimited)

### What We Need
1. Permission check before reprocessing
2. Automatic cascade boundary = collection root (no manual `stop_at_pi` needed for most cases)
3. Handle entities not in collections (free entities)

## Permission Model

### Decision Flow

```
1. Check if user can edit the target PI
   └─ Call collections-worker /pi/:pi/permissions
      ├─ canEdit: true → proceed
      └─ canEdit: false → 403 Forbidden

2. If cascade=true:
   └─ Determine cascade boundary
      ├─ PI is in a collection → cascade stops at collection rootPi
      └─ PI is NOT in a collection (free entity) → cascade to absolute root
```

### Key Insight: Single Permission Check

**We only need to check permission on the target PI**, not each parent in the cascade chain.

Why? Because:
- If target PI is in a collection and user can edit it, the entire parent chain up to `rootPi` is within the same collection
- The collections-worker already returns `rootPi` in the permissions response
- All entities in that chain inherit the same collection membership

### Edge Case: Free Entities

If the target PI is **not** in any collection (`collection: null`):
- `canEdit: true` (anyone can edit free entities)
- Cascade goes all the way to the root of the parent chain
- This is fine because all parents are also free entities (if they were in a collection, the target would be too)

## API Changes

### Request Format (unchanged)
```json
{
  "pi": "01K9CRZD8NTJP2KV14X12RCGPT",
  "phases": ["pinax", "cheimarros", "description"],
  "cascade": true,
  "options": {
    "stop_at_pi": "...",        // DEPRECATED - use automatic collection boundary
    "custom_prompts": { ... },
    "custom_note": "..."
  }
}
```

### New Behavior
- `stop_at_pi` becomes **optional override** (advanced use case)
- Default cascade stops at **collection root** (not arbitrary limit)
- If no collection, cascades to absolute root (same as before)

### New Headers Required
```
Authorization: Bearer <token>   -- Gateway validates and sets X-User-Id
X-User-Id: <user-id>            -- Set by gateway after auth
```

### Response Changes (errors)
```json
// 401 - Missing authentication
{
  "error": "UNAUTHORIZED",
  "message": "Authentication required"
}

// 403 - No edit permission
{
  "error": "FORBIDDEN",
  "message": "Not authorized to edit entities in collection \"My Collection\""
}
```

## Implementation Steps

### Step 1: Add Collections Worker Service Binding

**File: `wrangler.jsonc`**
```jsonc
"services": [
  {
    "binding": "IPFS_WRAPPER",
    "service": "arke-ipfs-api"
  },
  {
    "binding": "COLLECTIONS_WORKER",
    "service": "arke-collections-worker"
  }
]
```

### Step 2: Update Types

**File: `src/types.ts`**
```typescript
export interface Env {
  IPFS_WRAPPER: Fetcher;
  STAGING_BUCKET: R2Bucket;
  BATCH_QUEUE: Queue<QueueMessage>;
  COLLECTIONS_WORKER: Fetcher;  // NEW
}

// NEW: Permission check result
export interface PiPermissions {
  pi: string;
  canView: boolean;
  canEdit: boolean;
  canAdminister: boolean;
  collection: {
    id: string;
    title: string;
    slug: string;
    visibility: string;
    role: 'owner' | 'editor' | null;
    rootPi: string;
    hops: number;
  } | null;
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  permissions?: PiPermissions;
  cascadeStopPi?: string;  // Collection rootPi or null for free entities
}
```

### Step 3: Create Permissions Module

**File: `src/permissions.ts`**
```typescript
import type { Env, PiPermissions, PermissionCheckResult } from './types';

/**
 * Check if user can edit a PI and determine cascade boundary.
 *
 * Returns:
 * - allowed: whether user can edit
 * - cascadeStopPi: where cascade should stop (collection rootPi or undefined)
 */
export async function checkReprocessPermission(
  env: Env,
  userId: string | null,
  pi: string
): Promise<PermissionCheckResult> {
  try {
    const headers: Record<string, string> = {};
    if (userId) {
      headers['X-User-Id'] = userId;
    }

    const response = await env.COLLECTIONS_WORKER.fetch(
      `https://internal/pi/${pi}/permissions`,
      { headers }
    );

    if (!response.ok) {
      console.error(`[PERMISSIONS] Failed to check permissions for ${pi}: ${response.status}`);
      return { allowed: false, reason: 'Permission check failed' };
    }

    const permissions: PiPermissions = await response.json();

    if (!permissions.canEdit) {
      const reason = permissions.collection
        ? `Not authorized to edit entities in collection "${permissions.collection.title}"`
        : 'Not authorized to edit this entity';
      return { allowed: false, reason, permissions };
    }

    // User can edit - determine cascade boundary
    const cascadeStopPi = permissions.collection?.rootPi ?? undefined;

    console.log(`[PERMISSIONS] User can edit ${pi}, cascade stop: ${cascadeStopPi || 'none (free entity)'}`);

    return {
      allowed: true,
      permissions,
      cascadeStopPi
    };
  } catch (error) {
    console.error(`[PERMISSIONS] Error checking permissions for ${pi}:`, error);
    return { allowed: false, reason: 'Permission check error' };
  }
}
```

### Step 4: Update Main Handler

**File: `src/index.ts`**

Add auth validation and permission check:

```typescript
import { checkReprocessPermission } from './permissions';

async function handleReprocessRequest(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    // NEW: Extract user ID from header (set by gateway)
    const userId = request.headers.get('X-User-Id');

    // Parse and validate body (existing code)
    // ...

    // NEW: Permission check
    const permCheck = await checkReprocessPermission(env, userId, body.pi);

    if (!permCheck.allowed) {
      return jsonResponse({
        error: 'FORBIDDEN',
        message: permCheck.reason || 'Not authorized to reprocess this entity',
      }, 403, corsHeaders);
    }

    // Determine stop_at_pi:
    // 1. Use explicit stop_at_pi if provided (advanced override)
    // 2. Otherwise use collection rootPi (automatic boundary)
    // 3. If no collection, use default (cascade to absolute root)
    let effectiveStopPi = body.options?.stop_at_pi;
    if (!effectiveStopPi && permCheck.cascadeStopPi) {
      effectiveStopPi = permCheck.cascadeStopPi;
      console.log(`[API] Auto-setting cascade boundary to collection root: ${effectiveStopPi}`);
    }
    effectiveStopPi = effectiveStopPi ?? '00000000000000000000000000';

    // Process reprocessing request (existing code, use effectiveStopPi)
    const result = await processReprocessingRequest({
      pi: body.pi,
      phases: body.phases,
      cascade: cascade,
      stopAtPI: effectiveStopPi,  // Use effective stop PI
      customPrompts: customPrompts,
      customNote: customNote,
    }, env);

    return jsonResponse(result, 200, corsHeaders);
  } catch (error: any) {
    // ... existing error handling
  }
}
```

### Step 5: Update Resolver (Minor)

**File: `src/resolver.ts`**

The resolver already handles `stopAtPI` correctly. The only change is better logging:

```typescript
export async function resolveEntitiesForReprocessing(
  pi: string,
  cascade: boolean,
  stopAtPI: string,
  env: Env
): Promise<string[]> {
  // ... existing code

  // Enhanced logging
  if (stopAtPI !== '00000000000000000000000000') {
    console.log(`[Resolver] Cascade bounded by collection root: ${stopAtPI}`);
  } else {
    console.log(`[Resolver] Cascade to absolute root (free entity or no boundary)`);
  }

  // ... rest of existing code
}
```

## Testing Plan

### Test Cases

1. **Authenticated owner reprocesses entity in their collection**
   - Expect: 200 OK, cascade stops at collection root

2. **Authenticated editor reprocesses entity in shared collection**
   - Expect: 200 OK, cascade stops at collection root

3. **Authenticated user reprocesses entity in someone else's collection**
   - Expect: 403 Forbidden

4. **Authenticated user reprocesses free entity**
   - Expect: 200 OK, cascade goes to absolute root

5. **Unauthenticated request**
   - Expect: 200 OK for free entity (canEdit: true)
   - Expect: 403 for entity in private collection

6. **Explicit stop_at_pi override (within collection)**
   - Expect: 200 OK, respects explicit boundary

7. **Explicit stop_at_pi outside collection boundary**
   - Expect: This is allowed (you can cascade less than full collection)

### Test Script Location
Create `test-permissions.ts` in the reprocess-api directory.

## Rollout Plan

1. **Phase 1: Add service binding** (no behavior change)
   - Add COLLECTIONS_WORKER to wrangler.jsonc
   - Update types
   - Deploy

2. **Phase 2: Add permission check** (breaking change for protected entities)
   - Implement permissions.ts
   - Update index.ts handler
   - Test thoroughly
   - Deploy

3. **Phase 3: Communicate API change**
   - Update SDK/client documentation
   - Ensure gateway passes X-User-Id header

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Gateway                                      │
│  1. Validates JWT                                                    │
│  2. Sets X-User-Id header                                           │
│  3. Proxies to reprocess-api.arke.institute                         │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       Reprocess API                                   │
│                                                                       │
│  handleReprocessRequest():                                           │
│    1. Extract X-User-Id from headers                                 │
│    2. Call COLLECTIONS_WORKER /pi/:pi/permissions                    │
│    3. If !canEdit → 403                                              │
│    4. Set effectiveStopPi = collection.rootPi (if in collection)    │
│    5. Resolve entities (cascade stops at effectiveStopPi)           │
│    6. Materialize & queue batch                                      │
└─────────────────────────────────────────────────────────────────────┘
         │                          │
         │ Service Binding          │ Service Binding
         ▼                          ▼
┌─────────────────┐      ┌─────────────────────────────────────────────┐
│ Collections     │      │ IPFS Wrapper (arke-ipfs-api)                │
│ Worker          │      │ - Already has permission checks on write    │
│                 │      │ - Reprocess API only reads here             │
│ /pi/:pi/perms   │      └─────────────────────────────────────────────┘
│ Returns:        │
│ - canEdit       │
│ - rootPi        │
└─────────────────┘
```

## Limitations

### No Cross-Collection Cascading

**Cascade stops at the collection root.** If you have nested collections:

```
Collection-B (rootPi: PI-B)
└── PI-B
    └── PI-X
        └── Collection-A (rootPi: PI-A)
            └── PI-A
                └── PI-Y  <-- Editing here
```

Cascading from PI-Y will stop at PI-A (Collection-A's root). It will NOT cascade into Collection-B.

**Workaround**: If you need to cascade through multiple collections, make separate reprocess calls:
1. Reprocess PI-Y with cascade (stops at PI-A)
2. Reprocess PI-X with cascade (if you own Collection-B)

**Rationale**:
- Cross-collection cascading adds complexity (checking permissions at each boundary)
- Most edits are within a single collection
- This can be added later if needed without breaking changes

## Notes

### Why Not Check Each Parent?

We considered checking permissions for each entity in the cascade chain, but this is unnecessary:

1. **Collection membership is transitive**: If PI-A is in Collection-X, and PI-A's parent is PI-B, then PI-B is also in Collection-X (by definition, it's closer to the root).

2. **rootPi defines the boundary**: The collection's rootPi is explicitly set. Everything between target PI and rootPi is within the collection.

3. **Performance**: One permission check vs N checks (where N = cascade depth).

### Cross-Collection Cascading

If someone explicitly sets `stop_at_pi` to a PI outside their collection, what happens?

- The cascade will stop at their collection's rootPi anyway (since that's where parent_pi ends for their collection's root)
- This is safe because:
  - They can't edit beyond their collection boundary
  - The rootPi entity has no `parent_pi` pointing outside the collection

### Future: Multi-Collection Cascading

If we ever want to cascade across multiple collections (e.g., owner of nested collections wants to cascade through both):

1. Check permission at target PI → get Collection-A rootPi
2. Check if Collection-A rootPi has parent_pi in another collection
3. Check permission for that parent collection
4. Continue...

This is **not implemented** in this plan but is architecturally possible.
