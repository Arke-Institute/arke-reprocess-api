/**
 * Component Materialization
 *
 * Downloads all entity components from IPFS and uploads to R2 staging
 */

import { IPFSWrapperClient } from './ipfs-client';
import type { Env, MaterializedEntity, FileInfo } from './types';

/**
 * Materialize entity to R2 staging
 *
 * Downloads all components from IPFS and uploads to staging bucket
 * Returns entity metadata + file information for manifest building
 */
export async function materializeEntityToStaging(
  pi: string,
  stagingPrefix: string,
  env: Env
): Promise<MaterializedEntity> {
  const ipfsClient = new IPFSWrapperClient(env.IPFS_WRAPPER);

  console.log(`[Materializer] Materializing entity ${pi}...`);

  // Fetch entity from IPFS
  const entity = await ipfsClient.getEntity(pi);

  const files: FileInfo[] = [];
  let totalBytes = 0;

  // Download all components in parallel
  const componentEntries = Object.entries(entity.components);

  if (componentEntries.length === 0) {
    console.log(`[Materializer] Warning: Entity ${pi} has no components`);
  }

  const downloadPromises = componentEntries.map(async ([componentKey, cid]) => {
    console.log(`[Materializer]   Downloading ${componentKey} (${cid})...`);

    // Download content from IPFS
    const content = await ipfsClient.downloadContent(cid);

    // Write to staging bucket
    const r2Key = `${stagingPrefix}${pi}/${componentKey}`;
    await env.STAGING_BUCKET.put(r2Key, content);

    // Calculate byte length (Cloudflare Workers compatible)
    const contentLength = new TextEncoder().encode(content).length;

    console.log(`[Materializer]   ✓ ${componentKey} → ${r2Key} (${contentLength} bytes)`);

    return {
      r2_key: r2Key,
      file_name: componentKey,
      file_size: contentLength,
      content_type: inferContentType(componentKey),
    };
  });

  const downloadedFiles = await Promise.all(downloadPromises);
  files.push(...downloadedFiles);
  totalBytes = files.reduce((sum, f) => sum + f.file_size, 0);

  console.log(`[Materializer] ✓ Materialized ${files.length} components for ${pi} (${totalBytes} bytes)`);

  return {
    pi: entity.pi,
    tip: entity.manifest_cid,
    ver: entity.ver,
    children_pi: entity.children_pi || [],
    parent_pi: entity.parent_pi,
    files: files,
    total_bytes: totalBytes,
  };
}

/**
 * Infer content type from file extension
 */
function inferContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();

  const typeMap: Record<string, string> = {
    'md': 'text/markdown',
    'txt': 'text/plain',
    'json': 'application/json',
    'pdf': 'application/pdf',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'html': 'text/html',
    'xml': 'application/xml',
    'csv': 'text/csv',
  };

  return typeMap[ext || ''] || 'application/octet-stream';
}
