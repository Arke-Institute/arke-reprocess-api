# Arke Reprocessor API

Cloudflare Worker API for on-demand reprocessing of existing Arke entities. Downloads entity data from IPFS, materializes it to R2 staging, builds a batch manifest, and publishes it to the orchestrator queue.

## Overview

The Reprocessor API enables reprocessing existing entities through the same pipeline as new uploads, but without requiring a full re-upload. It's designed for scenarios like:

- Regenerating AI-generated descriptions after prompt improvements
- Reprocessing parent entities after child content changes (cascade mode)
- Updating PINAX aggregations when child entities are modified
- Running Cheimarros analysis on previously processed content

**Key principle:** The reprocessor API's job is to **prepare the batch** - the orchestrator does the actual reprocessing.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Client    │────▶│ Reprocessor API  │────▶│   Queue     │
└─────────────┘     └──────────────────┘     └─────────────┘
                            │                        │
                            ▼                        ▼
                    ┌──────────────┐         ┌─────────────┐
                    │ IPFS Wrapper │         │ Orchestrator│
                    └──────────────┘         └─────────────┘
                            │
                            ▼
                    ┌──────────────┐
                    │  R2 Staging  │
                    └──────────────┘
```

### Data Flow

1. **Entity Resolution** - Resolve target entity and optionally cascade up parent chain
2. **Component Materialization** - Download all components from IPFS to R2 staging
3. **Manifest Building** - Build BatchManifest with reprocessing-specific fields
4. **Queue Publishing** - Publish manifest to orchestrator queue with `reprocessing_mode=true`

## API Endpoint

### `POST /api/reprocess`

Request an entity (and optionally its ancestors) to be reprocessed.

**Request Body:**
```json
{
  "pi": "01JC9X7H6M3K8QRSTVWXYZ",
  "phases": ["pinax", "cheimarros", "description"],
  "cascade": true,
  "options": {
    "stop_at_pi": "00000000000000000000000000"
  }
}
```

**Fields:**
- `pi` (required): Entity PI to reprocess (26-character ULID)
- `phases` (required): Array of phases to run. Valid: `["pinax", "cheimarros", "description"]`
- `cascade` (optional, default `false`): If true, also reprocess all ancestors up to root
- `options.stop_at_pi` (optional, default `"00000000000000000000000000"`): Stop cascading at this PI

**Response:** `200 OK`
```json
{
  "batch_id": "reprocess_01JC9X7H6M3K8QRSTVWXYZ",
  "entities_queued": 5,
  "entity_pis": ["leaf_pi", "parent_pi", "grandparent_pi"],
  "status_url": "https://orchestrator.arke.institute/status/reprocess_01JC9X7H6M3K8Q"
}
```

**Errors:**
- `400` - Invalid request (missing fields, invalid PI format, invalid phases)
- `404` - Entity not found in IPFS
- `500` - Internal error (IPFS failure, R2 failure, etc.)

## Usage Examples

### Single Entity Reprocessing

Reprocess just the description for one entity:

```bash
curl -X POST https://reprocessor.arke.institute/api/reprocess \
  -H "Content-Type: application/json" \
  -d '{
    "pi": "01JC9X7H6M3K8QRSTVWXYZ",
    "phases": ["description"],
    "cascade": false
  }'
```

### Cascade Reprocessing

Reprocess an entity and all its ancestors (useful when child content changed):

```bash
curl -X POST https://reprocessor.arke.institute/api/reprocess \
  -H "Content-Type: application/json" \
  -d '{
    "pi": "01JC9X7H6M3K8Q",
    "phases": ["pinax", "description"],
    "cascade": true
  }'
```

This will:
1. Resolve parent chain: `[Leaf, Parent, Grandparent]` (stop at root)
2. Materialize all 3 entities to staging
3. Build manifest with proper parent-child relationships
4. Orchestrator processes bottom-up (leaf → parent → grandparent)

### Partial Cascade (Stop at PI)

Reprocess up to a specific ancestor:

```bash
curl -X POST https://reprocessor.arke.institute/api/reprocess \
  -H "Content-Type: application/json" \
  -d '{
    "pi": "01JC9X7H6M3K8Q",
    "phases": ["pinax"],
    "cascade": true,
    "options": {
      "stop_at_pi": "01JC9X7H6M3K8P"
    }
  }'
```

## Development

### Prerequisites

- Node.js 18+
- Wrangler CLI (`npm install -g wrangler`)
- Access to Arke infrastructure (R2, Queue, IPFS Wrapper)

### Setup

```bash
# Install dependencies
npm install

# Configure wrangler.jsonc with your bindings
# (See wrangler.jsonc for required bindings)

# Run locally
npm run dev

# Deploy to Cloudflare
npm run deploy
```

### Required Bindings

The API requires these Cloudflare Worker bindings (configured in `wrangler.jsonc`):

```jsonc
{
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

### Project Structure

```
arke-reprocessor-api/
├── src/
│   ├── index.ts              # HTTP endpoint handler
│   ├── reprocessor.ts        # Main orchestration
│   ├── resolver.ts           # Entity resolution
│   ├── materializer.ts       # Component download to R2
│   ├── manifest-builder.ts   # BatchManifest construction
│   ├── ipfs-client.ts        # IPFS wrapper client
│   └── types.ts              # TypeScript interfaces
├── wrangler.jsonc            # Cloudflare Worker config
├── package.json
├── tsconfig.json
└── README.md
```

## How It Works

### 1. Entity Resolution

Resolves which entities need reprocessing:
- Single mode: Just the target PI
- Cascade mode: Target + all ancestors up to root (or `stop_at_pi`)
- Returns bottom-up order (leaf first, then parents)

### 2. Component Materialization

For each entity:
- Fetches entity manifest from IPFS
- Downloads ALL components (text files, refs, pinax.json, description.md, etc.)
- Uploads to R2 staging at `reprocessing/{batch_id}/{pi}/`
- Tracks file metadata for manifest

### 3. Manifest Building

Creates a `BatchManifest` that looks like a normal ingestion batch:
- Each entity = one "directory"
- Sets `existing_pi`, `existing_children_paths`, `existing_parent_path`
- Processing config based on requested phases
- OCR and reorganize always disabled

### 4. Queue Publishing

Publishes to orchestrator queue with:
- Manifest uploaded to R2
- `reprocessing_mode: true` flag (tells orchestrator to skip discovery)
- Standard queue message format

The orchestrator then:
- Skips discovery phase (uses existing entity structure)
- Runs only requested phases
- Updates entities (doesn't recreate)
- Increments version numbers

## Monitoring

The API logs detailed metrics for observability:

```json
{
  "batch_id": "reprocess_01JC9X...",
  "target_pi": "01JC9X7H6M3K8Q",
  "entities_queued": 3,
  "phases": ["pinax", "description"],
  "cascade": true,
  "materialized_bytes": 50000,
  "duration_ms": 1234
}
```

## Success Criteria

- ✅ API accepts PI and phases, returns batch ID
- ✅ Entities materialized correctly to R2 staging
- ✅ Manifest includes `existing_pi`, `existing_children_paths`, `reprocessing_mode=true`
- ✅ Orchestrator receives batch and runs only requested phases
- ✅ Entities updated (not recreated) with incremented version numbers
- ✅ Cascade processes bottom-up with correct child content aggregation
- ✅ Parent relationships preserved

## Error Handling

### Entity Not Found
```json
{
  "error": "NOT_FOUND",
  "message": "Entity not found: 01JC9X7H6M3K8Q"
}
```

### Invalid Request
```json
{
  "error": "VALIDATION_ERROR",
  "message": "Invalid phases: foo, bar. Valid phases: pinax, cheimarros, description"
}
```

### Component Download Failure
The API retries component downloads with exponential backoff (3 attempts). If all retries fail, returns 500 error before publishing to queue. Never publishes partial batches.

## License

MIT
