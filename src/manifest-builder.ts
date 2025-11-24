/**
 * Manifest Builder
 *
 * Builds BatchManifest structure for reprocessing
 */

import type {
  BatchManifest,
  DirectoryGroup,
  MaterializedEntity,
  QueueFileInfo,
  ProcessingConfig,
} from './types';

/**
 * Build reprocessing manifest
 *
 * Creates a BatchManifest that looks like a normal ingestion batch,
 * but with reprocessing-specific fields set
 */
export function buildReprocessingManifest(
  entities: MaterializedEntity[],
  phases: string[],
  batchId: string,
  stagingPrefix: string
): BatchManifest {
  const directories: DirectoryGroup[] = [];

  for (const entity of entities) {
    // Create logical directory path (just use PI as identifier)
    const dirPath = `/${entity.pi}`;

    // Map files to QueueFileInfo format
    const files: QueueFileInfo[] = entity.files.map(f => ({
      r2_key: f.r2_key,
      logical_path: f.file_name,
      file_name: f.file_name,
      file_size: f.file_size,
      content_type: f.content_type,
    }));

    // Build processing config based on requested phases
    const processingConfig: ProcessingConfig = {
      ocr: false,  // Never reprocess OCR
      reorganize: false,  // Never reorganize during reprocessing
      pinax: phases.includes('pinax'),
      cheimarros: phases.includes('cheimarros'),
      describe: phases.includes('description'),
    };

    // Build directory group with reprocessing-specific fields
    const directory: DirectoryGroup = {
      directory_path: dirPath,
      processing_config: processingConfig,
      file_count: files.length,
      total_bytes: entity.total_bytes,
      files: files,

      // Reprocessing-specific fields
      existing_pi: entity.pi,
      existing_children_paths: entity.children_pi.map(childPI => `/${childPI}`),
      existing_parent_path: entity.parent_pi ? `/${entity.parent_pi}` : undefined,
    };

    directories.push(directory);

    console.log(`[ManifestBuilder] Added directory for ${entity.pi}:`);
    console.log(`[ManifestBuilder]   - Files: ${files.length}`);
    console.log(`[ManifestBuilder]   - Bytes: ${entity.total_bytes}`);
    console.log(`[ManifestBuilder]   - Children: ${entity.children_pi.length}`);
    console.log(`[ManifestBuilder]   - Parent: ${entity.parent_pi || 'none'}`);
    console.log(`[ManifestBuilder]   - Phases: ${Object.entries(processingConfig).filter(([k, v]) => v).map(([k]) => k).join(', ')}`);
  }

  const manifest: BatchManifest = {
    batch_id: batchId,
    directories: directories,
    total_files: directories.reduce((sum, d) => sum + d.file_count, 0),
    total_bytes: directories.reduce((sum, d) => sum + d.total_bytes, 0),
  };

  console.log(`[ManifestBuilder] Built manifest:`);
  console.log(`[ManifestBuilder]   - Batch ID: ${batchId}`);
  console.log(`[ManifestBuilder]   - Directories: ${directories.length}`);
  console.log(`[ManifestBuilder]   - Total Files: ${manifest.total_files}`);
  console.log(`[ManifestBuilder]   - Total Bytes: ${manifest.total_bytes}`);

  return manifest;
}
