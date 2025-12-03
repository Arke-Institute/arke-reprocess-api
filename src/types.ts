/**
 * TypeScript types for Arke Reprocessor API
 */

// ============================================================================
// Cloudflare Worker Environment
// ============================================================================

export interface Env {
  IPFS_WRAPPER: Fetcher;  // Service binding to arke-ipfs-api
  STAGING_BUCKET: R2Bucket;  // R2 staging bucket
  BATCH_QUEUE: Queue<QueueMessage>;  // Queue for batch jobs
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface ReprocessRequest {
  pi: string;
  phases: string[];
  cascade: boolean;
  stopAtPI: string;
  customPrompts?: CustomPrompts;
  customNote?: string;  // Optional custom version note (overrides default phase notes)
}

export interface ReprocessResponse {
  batch_id: string;
  entities_queued: number;
  entity_pis: string[];
  status_url: string;
}

// ============================================================================
// IPFS Wrapper API Types
// ============================================================================

export interface IPFSEntity {
  pi: string;
  ver: number;
  ts: string;
  manifest_cid: string;
  prev_cid?: string;
  components: Record<string, string>;  // component_key -> CID
  children_pi: string[];
  parent_pi?: string;
  note?: string;
}

// ============================================================================
// Materialized Entity (with R2 file info)
// ============================================================================

export interface MaterializedEntity {
  pi: string;
  tip: string;
  ver: number;
  children_pi: string[];
  parent_pi?: string;
  files: FileInfo[];
  total_bytes: number;
}

export interface FileInfo {
  r2_key: string;
  file_name: string;
  file_size: number;
  content_type: string;
}

// ============================================================================
// Queue Message Types (matches orchestrator expectations)
// ============================================================================

export interface QueueMessage {
  batch_id: string;
  manifest_r2_key: string;  // R2 key where full manifest is stored
  r2_prefix: string;
  uploader: string;
  root_path: string;
  total_files: number;
  total_bytes: number;
  uploaded_at: string;
  finalized_at: string;
  metadata: Record<string, any>;
  parent_pi?: string;  // Optional parent PI for attaching collection
  custom_prompts?: CustomPrompts;  // Optional custom prompts for AI services
  custom_note?: string;  // Optional custom version note (overrides default phase notes)

  // NEW: Reprocessing mode flag
  reprocessing_mode?: boolean;  // If true, orchestrator skips discovery phase
}

export interface CustomPrompts {
  general?: string;
  reorganization?: string;
  pinax?: string;
  description?: string;
  cheimarros?: string;
}

// ============================================================================
// Batch Manifest Types
// ============================================================================

export interface BatchManifest {
  batch_id: string;
  directories: DirectoryGroup[];
  total_files: number;
  total_bytes: number;
}

export interface DirectoryGroup {
  directory_path: string;
  processing_config: ProcessingConfig;
  file_count: number;
  total_bytes: number;
  files: QueueFileInfo[];

  // NEW: Reprocessing-specific fields
  existing_pi?: string;  // PI to update (required if reprocessing_mode=true)
  existing_children_paths?: string[];  // Preserve children relationships
  existing_parent_path?: string;  // Preserve parent relationship
}

export interface ProcessingConfig {
  ocr: boolean;
  reorganize?: boolean;  // undefined = use threshold, true = always, false = never
  pinax: boolean;
  cheimarros: boolean;
  describe: boolean;
}

export interface QueueFileInfo {
  r2_key: string;
  logical_path: string;
  file_name: string;
  file_size: number;
  content_type: string;
  cid?: string;  // Optional IPFS CID from original upload
}

// ============================================================================
// Error Types
// ============================================================================

export interface ErrorResponse {
  error: string;
  message: string;
  details?: any;
}
