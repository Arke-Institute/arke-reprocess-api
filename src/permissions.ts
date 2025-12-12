/**
 * Permission checking via collections worker
 *
 * Calls the collections worker to check if a user can edit a PI.
 * Also determines the cascade boundary (collection rootPi).
 */

import type { Env, PiPermissions, PermissionCheckResult } from './types';

/**
 * Check if user can reprocess a PI and determine cascade boundary.
 *
 * Permission logic (handled by collections worker):
 * - If PI is NOT in any collection → canEdit: true (anyone can edit)
 * - If PI IS in a collection → canEdit: true only if user is owner or editor
 *
 * Cascade boundary:
 * - If PI is in a collection → cascadeStopPi = collection.rootPi
 * - If PI is NOT in a collection → cascadeStopPi = undefined (cascade to absolute root)
 *
 * @param env - Worker environment with service bindings
 * @param userId - User ID from X-User-Id header (null if unauthenticated)
 * @param pi - The PI to check permissions for
 * @returns Permission check result with cascade boundary
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
        ? `Not authorized to reprocess entities in collection "${permissions.collection.title}"`
        : 'Not authorized to reprocess this entity';
      return { allowed: false, reason, permissions };
    }

    // User can edit - determine cascade boundary
    // If in a collection, cascade stops at collection root
    // If not in a collection (free entity), cascade goes to absolute root
    const cascadeStopPi = permissions.collection?.rootPi;

    console.log(
      `[PERMISSIONS] User ${userId || 'anonymous'} can reprocess ${pi}` +
      (cascadeStopPi ? `, cascade bounded by collection root: ${cascadeStopPi}` : ', no collection (free entity)')
    );

    return {
      allowed: true,
      permissions,
      cascadeStopPi,
    };
  } catch (error) {
    console.error(`[PERMISSIONS] Error checking permissions for ${pi}:`, error);
    return { allowed: false, reason: 'Permission check error' };
  }
}
