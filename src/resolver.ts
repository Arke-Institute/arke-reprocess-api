/**
 * Entity Resolution
 *
 * Resolves which entities need to be reprocessed, optionally cascading up the parent chain
 */

import { IPFSWrapperClient } from './ipfs-client';
import type { Env } from './types';

/**
 * Resolve entities for reprocessing
 *
 * Returns array of PIs in bottom-up order (leaf first, then parents)
 * This ensures proper aggregation during reprocessing
 */
export async function resolveEntitiesForReprocessing(
  pi: string,
  cascade: boolean,
  stopAtPI: string,
  env: Env
): Promise<string[]> {
  const ipfsClient = new IPFSWrapperClient(env.IPFS_WRAPPER);
  const entities = [pi];

  if (!cascade) {
    console.log(`[Resolver] Single entity mode: ${pi}`);
    return entities;
  }

  // Walk up parent chain
  let currentPI = pi;
  let depth = 0;
  const maxDepth = 100; // Safety limit to prevent infinite loops

  console.log(`[Resolver] Starting cascade from ${pi} (stop_at_pi: ${stopAtPI})`);

  while (depth < maxDepth) {
    const entity = await ipfsClient.getEntity(currentPI);

    // Stop at root (no parent) or stop_at_pi
    if (!entity.parent_pi || entity.parent_pi === stopAtPI) {
      console.log(`[Resolver] Stopped at ${currentPI} (no parent or reached stop_at_pi)`);
      break;
    }

    console.log(`[Resolver] Found parent: ${entity.parent_pi} (depth ${depth + 1})`);
    entities.push(entity.parent_pi);
    currentPI = entity.parent_pi;
    depth++;
  }

  if (depth >= maxDepth) {
    throw new Error(`Max depth ${maxDepth} reached while resolving parent chain for ${pi}`);
  }

  console.log(`[Resolver] Resolved ${entities.length} entities in chain`);
  return entities;
}
