/**
 * Main Reprocessing Orchestration
 *
 * Coordinates entity resolution, materialization, manifest building, and queue publishing
 */

import { generateULID } from './ulid';
import { resolveEntitiesForReprocessing } from './resolver';
import { materializeEntityToStaging } from './materializer';
import { buildReprocessingManifest } from './manifest-builder';
import type {
  Env,
  ReprocessRequest,
  ReprocessResponse,
  QueueMessage,
  BatchManifest,
  CustomPrompts,
} from './types';

/**
 * Process reprocessing request
 *
 * Main orchestration function that:
 * 1. Resolves entities (target + ancestors if cascade)
 * 2. Materializes each entity to staging
 * 3. Builds manifest
 * 4. Publishes to queue
 */
export async function processReprocessingRequest(
  request: ReprocessRequest,
  env: Env
): Promise<ReprocessResponse> {
  const startTime = Date.now();
  const batchId = `reprocess_${generateULID()}`;
  const stagingPrefix = `reprocessing/${batchId}/`;

  console.log(`[Reprocessor] ========================================`);
  console.log(`[Reprocessor] Starting reprocessing request`);
  console.log(`[Reprocessor] Batch ID: ${batchId}`);
  console.log(`[Reprocessor] Target PI: ${request.pi}`);
  console.log(`[Reprocessor] Phases: ${request.phases.join(', ')}`);
  console.log(`[Reprocessor] Cascade: ${request.cascade}`);
  console.log(`[Reprocessor] Stop at PI: ${request.stopAtPI}`);
  console.log(`[Reprocessor] Custom prompts: ${request.customPrompts ? 'Yes' : 'No'}`);
  console.log(`[Reprocessor] ========================================`);

  // 1. Resolve entities (target + ancestors if cascade)
  console.log(`[Reprocessor] Step 1: Resolving entities...`);
  const entityPIs = await resolveEntitiesForReprocessing(
    request.pi,
    request.cascade,
    request.stopAtPI,
    env
  );
  console.log(`[Reprocessor] ✓ Resolved ${entityPIs.length} entities`);

  // 2. Materialize each entity to staging (in parallel)
  console.log(`[Reprocessor] Step 2: Materializing entities to staging...`);
  const materializedEntities = await Promise.all(
    entityPIs.map(pi => materializeEntityToStaging(pi, stagingPrefix, env))
  );
  const totalBytes = materializedEntities.reduce((sum, e) => sum + e.total_bytes, 0);
  console.log(`[Reprocessor] ✓ Materialized ${materializedEntities.length} entities (${totalBytes} bytes)`);

  // 3. Build manifest
  console.log(`[Reprocessor] Step 3: Building manifest...`);
  const manifest = buildReprocessingManifest(
    materializedEntities,
    request.phases,
    batchId,
    stagingPrefix
  );
  console.log(`[Reprocessor] ✓ Built manifest with ${manifest.directories.length} directories`);

  // 4. Publish to queue
  console.log(`[Reprocessor] Step 4: Publishing to queue...`);
  await publishReprocessingBatch(manifest, stagingPrefix, request.customPrompts, env);
  console.log(`[Reprocessor] ✓ Published batch ${batchId} to queue`);

  const duration = Date.now() - startTime;

  console.log(`[Reprocessor] ========================================`);
  console.log(`[Reprocessor] Reprocessing request completed successfully`);
  console.log(`[Reprocessor] Duration: ${duration}ms`);
  console.log(`[Reprocessor] Entities queued: ${entityPIs.length}`);
  console.log(`[Reprocessor] Total bytes: ${totalBytes}`);
  console.log(`[Reprocessor] ========================================`);

  // Log metrics for observability
  console.log(`[Metrics] ${JSON.stringify({
    batch_id: batchId,
    target_pi: request.pi,
    entities_queued: entityPIs.length,
    phases: request.phases,
    cascade: request.cascade,
    materialized_bytes: totalBytes,
    duration_ms: duration,
  })}`);

  return {
    batch_id: batchId,
    entities_queued: entityPIs.length,
    entity_pis: entityPIs,
    status_url: `https://orchestrator.arke.institute/status/${batchId}`,
  };
}

/**
 * Publish reprocessing batch to queue
 */
async function publishReprocessingBatch(
  manifest: BatchManifest,
  stagingPrefix: string,
  customPrompts: CustomPrompts | undefined,
  env: Env
): Promise<void> {
  // Upload manifest to staging
  const manifestKey = `${stagingPrefix}_manifest.json`;
  await env.STAGING_BUCKET.put(manifestKey, JSON.stringify(manifest, null, 2));

  console.log(`[Publisher] Uploaded manifest to ${manifestKey}`);

  // Create queue message
  const queueMessage: QueueMessage = {
    batch_id: manifest.batch_id,
    manifest_r2_key: manifestKey,
    r2_prefix: stagingPrefix,
    uploader: 'reprocessor-api',
    root_path: '/',
    total_files: manifest.total_files,
    total_bytes: manifest.total_bytes,
    uploaded_at: new Date().toISOString(),
    finalized_at: new Date().toISOString(),
    metadata: {},
    reprocessing_mode: true,  // KEY: This tells orchestrator to skip discovery
    custom_prompts: customPrompts,  // Pass through custom prompts for AI services
  };

  // Publish to queue
  await env.BATCH_QUEUE.send(queueMessage);

  console.log(`[Publisher] Published message to queue:`);
  console.log(`[Publisher]   - Batch ID: ${queueMessage.batch_id}`);
  console.log(`[Publisher]   - Manifest: ${manifestKey}`);
  console.log(`[Publisher]   - Reprocessing mode: true`);
}
