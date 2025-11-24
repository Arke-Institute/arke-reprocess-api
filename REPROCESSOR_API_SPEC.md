# Reprocessor API Specification

## Overview

The **Reprocessor API** is a new Cloudflare Worker service that enables on-demand reprocessing of existing entities. It downloads entity data from IPFS, materializes it to R2 staging, builds a batch manifest, and publishes it to the orchestrator queue.

**Key principle**: The reprocessor API's job is to **prepare the batch** - the orchestrator does the actual reprocessing.

## API Endpoint

### POST /api/reprocess

Request an entity (and optionally its ancestors) to be reprocessed.

**Request Body**:
```json
{
  "pi": "01234567890123456789012345",
  "phases": ["pinax", "cheimarros", "description"],
  "cascade": true,
  "options": {
    "stop_at_pi": "00000000000000000000000000"  // Optional: don't reprocess this PI or above
  }
}
```

**Response**:
```json
{
  "batch_id": "reprocess_01JC9X7H6M3K8QRSTVWXYZ",
  "entities_queued": 5,
  "entity_pis": ["leaf_pi", "parent_pi", "grandparent_pi", ...],
  "status_url": "https://orchestrator.arke.institute/status/reprocess_01JC9X7H6M3K8QRSTVWXYZ"
}
```

**Fields**:
- `pi` (required): The entity PI to reprocess
- `phases` (required): Array of phases to run. Valid values: `["pinax", "cheimarros", "description"]`
- `cascade` (optional, default: `false`): If true, also reprocess all ancestors up to (but not including) the root
- `options.stop_at_pi` (optional, default: `"00000000000000000000000000"`): Stop cascading at this PI

**Validation**:
- `pi` must be a valid 26-character PI
- `phases` must be non-empty array with valid phase names
- If `cascade=true`, API will walk up parent chain until reaching root or `stop_at_pi`

## Reprocessor API Responsibilities

### 1. Entity Resolution

For the target PI (and ancestors if cascade=true):

```typescript
async function resolveEntitiesForReprocessing(
  pi: string,
  cascade: boolean,
  stopAtPI: string
): Promise<string[]> {
  const entities = [pi];

  if (cascade) {
    let currentPI = pi;

    while (true) {
      const entity = await ipfsClient.getEntity(currentPI);

      // Stop at root or stop_at_pi
      if (!entity.parent_pi || entity.parent_pi === stopAtPI) {
        break;
      }

      entities.push(entity.parent_pi);
      currentPI = entity.parent_pi;
    }
  }

  // Return in bottom-up order (leaf first, then parents)
  return entities;
}
```

**What this provides**:
- List of entity PIs to reprocess
- Ordered bottom-up (critical for aggregation to work)

### 2. Component Materialization

For each entity, download all components from IPFS to R2 staging:

```typescript
async function materializeEntityToStaging(
  pi: string,
  stagingPrefix: string,
  env: Env
): Promise<{
  pi: string,
  tip: string,
  ver: number,
  children_pi: string[],
  parent_pi?: string,
  files: Array<{
    r2_key: string,
    file_name: string,
    file_size: number,
    content_type: string
  }>
}> {
  const entity = await ipfsClient.getEntity(pi);

  const files: any[] = [];

  // Download all components to staging
  for (const [componentKey, cid] of Object.entries(entity.components)) {
    const content = await ipfsClient.downloadContent(cid);

    // Write to staging bucket
    const r2Key = `${stagingPrefix}/${componentKey}`;
    await env.STAGING_BUCKET.put(r2Key, content);

    files.push({
      r2_key: r2Key,
      file_name: componentKey,
      file_size: content.length,
      content_type: inferContentType(componentKey),
    });
  }

  return {
    pi: entity.pi,
    tip: entity.tip,
    ver: entity.ver,
    children_pi: entity.children_pi,
    parent_pi: entity.parent_pi,
    files: files,
  };
}

function inferContentType(filename: string): string {
  if (filename.endsWith('.md')) return 'text/markdown';
  if (filename.endsWith('.txt')) return 'text/plain';
  if (filename.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}
```

**What this provides**:
- All entity components materialized to R2 staging
- File metadata for manifest construction
- Entity metadata (PI, tip, children, parent)

**Key insight**: We download ALL components (text files, refs, pinax.json, description.md, etc.). The orchestrator phases will read what they need and overwrite what they regenerate.

### 3. Manifest Construction

Build a `BatchManifest` that looks like a normal ingestion batch:

```typescript
async function buildReprocessingManifest(
  entities: Array<{
    pi: string,
    tip: string,
    children_pi: string[],
    parent_pi?: string,
    files: any[]
  }>,
  phases: string[],
  batchId: string,
  stagingPrefix: string
): Promise<BatchManifest> {
  const directories: DirectoryGroup[] = [];

  for (const entity of entities) {
    // Create logical directory path (doesn't matter for reprocessing)
    const dirPath = `/${entity.pi}`;

    directories.push({
      directory_path: dirPath,
      processing_config: {
        ocr: false,  // Never reprocess OCR
        reorganize: false,  // Never reorganize
        pinax: phases.includes('pinax'),
        cheimarros: phases.includes('cheimarros'),
        describe: phases.includes('description'),
      },
      file_count: entity.files.length,
      total_bytes: entity.files.reduce((sum, f) => sum + f.file_size, 0),
      files: entity.files.map(f => ({
        r2_key: f.r2_key,
        logical_path: f.file_name,
        file_name: f.file_name,
        file_size: f.file_size,
        content_type: f.content_type,
      })),

      // Reprocessing-specific fields
      existing_pi: entity.pi,
      existing_children_paths: entity.children_pi.map(childPI => `/${childPI}`),
      existing_parent_path: entity.parent_pi ? `/${entity.parent_pi}` : undefined,
    });
  }

  return {
    batch_id: batchId,
    directories: directories,
    total_files: directories.reduce((sum, d) => sum + d.file_count, 0),
    total_bytes: directories.reduce((sum, d) => sum + d.total_bytes, 0),
  };
}
```

**What this provides**:
- Valid `BatchManifest` structure
- Each entity represented as a "directory"
- Existing PI, children, and parent preserved
- Processing config set based on requested phases

**Key insight**: We use the PI itself as the directory path (e.g., `"/01JC9X7H6M3K8Q"`). This is just a logical identifier - the orchestrator doesn't use it for anything meaningful during reprocessing.

### 4. Queue Message Publishing

```typescript
async function publishReprocessingBatch(
  manifest: BatchManifest,
  stagingPrefix: string,
  env: Env
): Promise<void> {
  // Upload manifest to staging
  const manifestKey = `${stagingPrefix}/_manifest.json`;
  await env.STAGING_BUCKET.put(manifestKey, JSON.stringify(manifest, null, 2));

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
  };

  // Publish to queue
  await env.BATCH_QUEUE.send(queueMessage);

  console.log(`[Reprocessor] Published batch ${manifest.batch_id} to queue`);
}
```

**What this provides**:
- Manifest uploaded to R2
- Queue message with `reprocessing_mode: true` flag
- Triggers orchestrator processing

## Implementation Structure

### Project Layout

```
arke-reprocessor-api/
├── src/
│   ├── index.ts              # HTTP endpoint handler
│   ├── reprocessor.ts        # Main reprocessing orchestration
│   ├── resolver.ts           # Entity resolution (PI → entity data)
│   ├── materializer.ts       # Download components to R2
│   ├── manifest-builder.ts   # Build BatchManifest
│   └── types.ts              # TypeScript interfaces
├── wrangler.jsonc            # Cloudflare Worker config
├── package.json
└── README.md
```

### Core Modules

#### **src/index.ts** - HTTP Endpoint
```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/reprocess') {
      return handleReprocessRequest(request, env);
    }

    return new Response('Not found', { status: 404 });
  }
};

async function handleReprocessRequest(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json();

    // Validate request
    if (!body.pi || !body.phases || body.phases.length === 0) {
      return new Response(JSON.stringify({
        error: 'Invalid request',
        message: 'pi and phases are required'
      }), { status: 400 });
    }

    // Validate phases
    const validPhases = ['pinax', 'cheimarros', 'description'];
    for (const phase of body.phases) {
      if (!validPhases.includes(phase)) {
        return new Response(JSON.stringify({
          error: 'Invalid phase',
          message: `Valid phases: ${validPhases.join(', ')}`
        }), { status: 400 });
      }
    }

    // Process reprocessing request
    const result = await processReprocessingRequest({
      pi: body.pi,
      phases: body.phases,
      cascade: body.cascade ?? false,
      stopAtPI: body.options?.stop_at_pi ?? '00000000000000000000000000'
    }, env);

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('[Reprocessor API] Error:', error);
    return new Response(JSON.stringify({
      error: 'Internal server error',
      message: error.message
    }), { status: 500 });
  }
}
```

#### **src/reprocessor.ts** - Main Orchestration
```typescript
export async function processReprocessingRequest(
  request: ReprocessRequest,
  env: Env
): Promise<ReprocessResponse> {
  const batchId = `reprocess_${generateULID()}`;
  const stagingPrefix = `reprocessing/${batchId}/`;

  console.log(`[Reprocessor] Starting reprocessing for PI ${request.pi}`);
  console.log(`[Reprocessor] Phases: ${request.phases.join(', ')}`);
  console.log(`[Reprocessor] Cascade: ${request.cascade}`);

  // 1. Resolve entities (target + ancestors if cascade)
  const entityPIs = await resolveEntitiesForReprocessing(
    request.pi,
    request.cascade,
    request.stopAtPI,
    env
  );

  console.log(`[Reprocessor] Resolved ${entityPIs.length} entities to reprocess`);

  // 2. Materialize each entity to staging
  const materializedEntities = await Promise.all(
    entityPIs.map(pi => materializeEntityToStaging(pi, stagingPrefix, env))
  );

  console.log(`[Reprocessor] Materialized ${materializedEntities.length} entities to staging`);

  // 3. Build manifest
  const manifest = buildReprocessingManifest(
    materializedEntities,
    request.phases,
    batchId,
    stagingPrefix
  );

  console.log(`[Reprocessor] Built manifest with ${manifest.directories.length} directories`);

  // 4. Publish to queue
  await publishReprocessingBatch(manifest, stagingPrefix, env);

  console.log(`[Reprocessor] Published batch ${batchId} to queue`);

  return {
    batch_id: batchId,
    entities_queued: entityPIs.length,
    entity_pis: entityPIs,
    status_url: `https://orchestrator.arke.institute/status/${batchId}`
  };
}
```

#### **src/resolver.ts** - Entity Resolution
```typescript
export async function resolveEntitiesForReprocessing(
  pi: string,
  cascade: boolean,
  stopAtPI: string,
  env: Env
): Promise<string[]> {
  const ipfsClient = new IPFSWrapperClient(env.IPFS_WRAPPER);
  const entities = [pi];

  if (!cascade) {
    return entities;
  }

  // Walk up parent chain
  let currentPI = pi;
  let depth = 0;
  const maxDepth = 100; // Safety limit

  while (depth < maxDepth) {
    const entity = await ipfsClient.getEntity(currentPI);

    // Stop at root or stop_at_pi
    if (!entity.parent_pi || entity.parent_pi === stopAtPI) {
      console.log(`[Resolver] Stopped at ${currentPI} (no parent or reached stop_at_pi)`);
      break;
    }

    entities.push(entity.parent_pi);
    currentPI = entity.parent_pi;
    depth++;
  }

  if (depth >= maxDepth) {
    throw new Error(`Max depth reached while resolving parent chain for ${pi}`);
  }

  console.log(`[Resolver] Resolved ${entities.length} entities in chain`);
  return entities;
}
```

#### **src/materializer.ts** - Component Download
```typescript
export async function materializeEntityToStaging(
  pi: string,
  stagingPrefix: string,
  env: Env
): Promise<MaterializedEntity> {
  const ipfsClient = new IPFSWrapperClient(env.IPFS_WRAPPER);

  console.log(`[Materializer] Materializing entity ${pi}...`);

  // Fetch entity from IPFS
  const entity = await ipfsClient.getEntity(pi);

  const files: any[] = [];
  let totalBytes = 0;

  // Download all components in parallel
  const componentEntries = Object.entries(entity.components);
  const downloadPromises = componentEntries.map(async ([componentKey, cid]) => {
    const content = await ipfsClient.downloadContent(cid);
    const r2Key = `${stagingPrefix}${pi}/${componentKey}`;

    await env.STAGING_BUCKET.put(r2Key, content);

    const contentLength = Buffer.byteLength(content, 'utf-8');
    totalBytes += contentLength;

    return {
      r2_key: r2Key,
      file_name: componentKey,
      file_size: contentLength,
      content_type: inferContentType(componentKey),
    };
  });

  const downloadedFiles = await Promise.all(downloadPromises);
  files.push(...downloadedFiles);

  console.log(`[Materializer] Materialized ${files.length} components for ${pi} (${totalBytes} bytes)`);

  return {
    pi: entity.pi,
    tip: entity.tip,
    ver: entity.ver,
    children_pi: entity.children_pi,
    parent_pi: entity.parent_pi,
    files: files,
    total_bytes: totalBytes,
  };
}

function inferContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const typeMap: Record<string, string> = {
    'md': 'text/markdown',
    'txt': 'text/plain',
    'json': 'application/json',
  };
  return typeMap[ext || ''] || 'application/octet-stream';
}
```

### Environment Bindings

The reprocessor API needs these bindings in `wrangler.jsonc`:

```jsonc
{
  "name": "arke-reprocessor-api",
  "main": "src/index.ts",
  "compatibility_date": "2024-01-01",

  "services": [
    { "binding": "IPFS_WRAPPER", "service": "arke-ipfs-api" }
  ],

  "r2_buckets": [
    { "binding": "STAGING_BUCKET", "bucket_name": "arke-staging" }
  ],

  "queues": {
    "producers": [
      { "binding": "BATCH_QUEUE", "queue": "arke-batch-jobs" }
    ]
  }
}
```

## Data Flow Example

### Single Entity Reprocessing

**Request**:
```json
{
  "pi": "01JC9X7H6M3K8QRSTVWXYZ",
  "phases": ["description"],
  "cascade": false
}
```

**Steps**:
1. Fetch entity `01JC9X7H6M3K8Q` from IPFS
2. Download all components to `reprocessing/{batch_id}/01JC9X7H6M3K8Q/`
3. Build manifest with 1 directory, `describe=true`
4. Publish to queue with `reprocessing_mode=true`
5. Orchestrator skips discovery, runs description phase only
6. Entity updated with new `description.md`

### Cascade Reprocessing

**Request**:
```json
{
  "pi": "01JC9X7H6M3K8Q",  // Leaf
  "phases": ["pinax", "description"],
  "cascade": true
}
```

**Entity hierarchy**:
```
00000000000000000000000000 (Root - not processed)
  └─ 01JC9X7H6M3K8P (Grandparent)
      └─ 01JC9X7H6M3K8R (Parent)
          └─ 01JC9X7H6M3K8Q (Leaf - target)
```

**Steps**:
1. Resolve parent chain: `[Leaf, Parent, Grandparent]` (stop at root)
2. Materialize all 3 entities to staging
3. Build manifest with 3 directories:
   ```
   - /01JC9X7H6M3K8Q (depth 3, children=[], parent=01JC9X7H6M3K8R)
   - /01JC9X7H6M3K8R (depth 2, children=[01JC9X7H6M3K8Q], parent=01JC9X7H6M3K8P)
   - /01JC9X7H6M3K8P (depth 1, children=[01JC9X7H6M3K8R], parent=00000000...)
   ```
4. Publish to queue
5. Orchestrator processes:
   - PINAX: Leaf → Parent → Grandparent (aggregates child PINAX)
   - Description: Leaf → Parent → Grandparent (aggregates child descriptions)

## Error Handling

### Entity Not Found
```json
{
  "error": "Entity not found",
  "message": "Failed to fetch entity 01JC9X7H6M3K8Q from IPFS",
  "pi": "01JC9X7H6M3K8Q"
}
```

### Component Download Failure
- Retry with exponential backoff (3 attempts)
- If all retries fail, return error before publishing to queue
- Don't publish partial batches

### Queue Publishing Failure
```json
{
  "error": "Queue publish failed",
  "message": "Failed to publish batch to arke-batch-jobs queue",
  "batch_id": "reprocess_01JC9X..."
}
```

## Rate Limiting

To prevent abuse, add rate limiting:

```typescript
// Track requests per PI
const reprocessingLocks = new Map<string, number>();

async function checkRateLimits(pi: string): Promise<void> {
  const lastRequest = reprocessingLocks.get(pi);
  if (lastRequest && Date.now() - lastRequest < 60000) {
    throw new Error(`Rate limit: Can only reprocess ${pi} once per minute`);
  }
  reprocessingLocks.set(pi, Date.now());
}
```

## Monitoring & Observability

Log key metrics:
- Number of entities resolved
- Total bytes materialized
- Time taken for each phase
- Queue publish success/failure

```typescript
console.log(`[Metrics] {
  batch_id: "${batchId}",
  target_pi: "${request.pi}",
  entities_queued: ${entityPIs.length},
  phases: [${request.phases.join(', ')}],
  cascade: ${request.cascade},
  materialized_bytes: ${totalBytes},
  duration_ms: ${Date.now() - startTime}
}`);
```

## Testing Strategy

### Unit Tests
- Entity resolution (single vs cascade)
- Manifest building
- Component materialization

### Integration Tests
1. **Single entity reprocessing**
   - Request reprocessing for one PI
   - Verify manifest structure
   - Verify queue message format

2. **Cascade reprocessing**
   - Request cascade for leaf with 2 parents
   - Verify all 3 entities materialized
   - Verify bottom-up ordering

3. **Stop at PI**
   - Request cascade with `stop_at_pi`
   - Verify cascade stops correctly

### End-to-End Test
1. Create test entities in IPFS
2. Call reprocessor API
3. Poll orchestrator status
4. Verify entities updated (not recreated)
5. Verify version numbers incremented

## Development Timeline

**Phase 1: Core Implementation** (3-4 days)
- Basic HTTP endpoint
- Entity resolution
- Component materialization
- Manifest building

**Phase 2: Queue Integration** (1-2 days)
- Queue message publishing
- Error handling
- Rate limiting

**Phase 3: Testing** (2-3 days)
- Unit tests
- Integration tests
- End-to-end validation

**Total: 6-9 days**

## Success Criteria

1. ✅ API accepts PI and phases, returns batch ID
2. ✅ Entities materialized correctly to R2 staging
3. ✅ Manifest includes `existing_pi`, `existing_children_paths`, `reprocessing_mode=true`
4. ✅ Orchestrator receives batch and runs only requested phases
5. ✅ Entities updated (not recreated) with incremented version numbers
6. ✅ Cascade processes bottom-up with correct child content aggregation
7. ✅ Parent relationships preserved (no modifications to `children_pi`)
