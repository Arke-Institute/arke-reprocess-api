# Arke IPFS API Specification

## Overview

This API manages versioned entities (PIs) as immutable IPLD manifests in IPFS, with mutable `.tip` pointers in MFS for fast lookups.

**Production URL:** `https://api.arke.institute`
**Local Development URL:** `http://localhost:8787`
**Worker Name:** `arke-ipfs-api`

**Related Services:**
- **IPFS Gateway:** `https://ipfs.arke.institute`
- **IPFS Backend:** `https://ipfs-api.arke.institute` (Kubo RPC + Backend API)

### Architecture

The API uses a hybrid snapshot + linked list backend for scalable entity listing:
- **IPFS Storage**: Immutable manifests stored as dag-json with version chains
- **MFS Tips**: Fast `.tip` file lookups for current versions
- **Backend API**: IPFS Server (FastAPI) manages snapshot-based entity indexing
- **Recent Chain**: New entities appended to linked list for fast access
- **Snapshots**: Periodic snapshots for efficient deep pagination

This architecture supports millions of entities while maintaining sub-100ms query performance.

---

## Concurrency and Race Condition Handling

### Compare-And-Swap (CAS) Protection

All write operations (version appending, relation updates) use **atomic Compare-And-Swap (CAS)** to prevent data loss from concurrent updates. The API implements three-layer protection:

1. **Server-side atomic write** - Pre/post verification detects races
2. **Server-side automatic retry** - Up to 3-10 retries with exponential backoff
3. **Client responsibility** - Handle 409 CAS_FAILURE and retry with fresh tip

### CRITICAL: Client-Side Retry Logic Required

**⚠️ Clients MUST implement retry logic for 409 CAS_FAILURE errors.**

When multiple operations update the same entity concurrently:
- Server handles internal races automatically (transparent to client)
- Client gets 409 CAS_FAILURE if `expect_tip` is stale (tip changed since last read)
- **Client MUST fetch fresh tip and retry** - this is NOT optional

**Example: Proper Client Implementation**

```typescript
async function appendVersion(
  pi: string,
  updates: { components?: Record<string, string>, note?: string }
): Promise<{ pi: string; tip: string; ver: number }> {
  const MAX_RETRIES = 10;
  let expectTip = (await getEntity(pi)).manifest_cid; // Initial tip

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fetch(`${API_URL}/entities/${pi}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expect_tip: expectTip, ...updates }),
      }).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
    } catch (error: any) {
      // Check if 409 CAS_FAILURE
      if (error.message.includes('HTTP 409') && attempt < MAX_RETRIES - 1) {
        // Exponential backoff with jitter
        const baseDelay = 100 * (2 ** attempt);
        const jitter = Math.random() * baseDelay;
        await sleep(baseDelay + jitter);

        // CRITICAL: Fetch fresh tip before retry
        expectTip = (await getEntity(pi)).manifest_cid;
        continue;
      }
      throw error; // Not 409 or exhausted retries
    }
  }
  throw new Error('Failed after max retries');
}
```

**Why This Matters:**

Without client-side retry, concurrent operations will fail:
```
Operation 1: Read tip=v2 → Update component A → 201 Created (v3)
Operation 2: Read tip=v2 → Update component B → 409 CAS_FAILURE ❌
```

With proper retry:
```
Operation 1: Read tip=v2 → Update component A → 201 Created (v3)
Operation 2: Read tip=v2 → Update component B → 409 CAS_FAILURE
            → Retry: Read tip=v3 → Update component B → 201 Created (v4) ✅
```

**Best Practices:**
- Always provide `expect_tip` in write operations
- Implement retry with exponential backoff (10 attempts recommended)
- Add jitter to prevent thundering herd
- Fetch fresh tip from server on each retry
- For bulk operations: Consider sequential processing if retry rate is high

---

## Endpoints

### Health Check

**`GET /`**

Returns service status.

**Response:**
```json
{
  "service": "arke-ipfs-api",
  "version": "0.1.0",
  "status": "ok"
}
```

---

### Initialize Arke Origin Block

**`POST /arke/init`**

Initialize the Arke origin block (genesis entity) if it doesn't already exist. This is the root of the archive tree with a well-known PI.

**Request:** No body required

**Response:** `201 Created` (if created) or `200 OK` (if already exists)
```json
{
  "message": "Arke origin block initialized",
  "metadata_cid": "bafkreiabc123...",
  "pi": "00000000000000000000000000",
  "ver": 1,
  "manifest_cid": "bafybeiabc789...",
  "tip": "bafybeiabc789..."
}
```

If already exists:
```json
{
  "message": "Arke origin block already exists",
  "pi": "00000000000000000000000000",
  "ver": 2,
  "ts": "2025-10-12T17:35:39.621Z",
  "manifest_cid": "bafybeiabc789...",
  "prev_cid": "bafybeiabc456...",
  "components": {
    "metadata": "bafkreiabc123..."
  },
  "children_pi": ["01K7..."],
  "note": "..."
}
```

**Side Effects:**
- Creates Arke metadata JSON and stores in IPFS
- Creates v1 manifest with well-known PI
- Sets up `.tip` file in MFS
- Appends to backend chain for indexing

**Arke Metadata:**
```json
{
  "name": "Arke",
  "type": "root",
  "description": "Origin block of the Arke Institute archive tree. Contains all institutional collections.",
  "note": "Arke (ἀρχή) - Ancient Greek for 'origin' or 'beginning'"
}
```

**Note:** The Arke PI is configurable via `ARKE_PI` environment variable (defaults to `00000000000000000000000000`).

---

### Get Arke Origin Block

**`GET /arke`**

Convenience endpoint to fetch the Arke origin block without needing to know the PI.

**Response:** `200 OK` (same format as `GET /entities/{pi}`)

**Errors:**
- `404` - Arke origin block not initialized (call `POST /arke/init` first)

---

### Upload Files

**`POST /upload`**

Upload raw bytes to IPFS. Returns CID(s) for use in manifest components.

**Request:** `multipart/form-data` with one or more file parts

**Response:** `200 OK`
```json
[
  {
    "name": "file",
    "cid": "bafybeiabc123...",
    "size": 12345
  }
]
```

**Upload Size Limit:**

The API has a **maximum upload size of 100 MB per request** due to Cloudflare Workers request body size constraints. This limit has been confirmed through production testing (see [UPLOAD_LIMITS_TEST_RESULTS.md](./UPLOAD_LIMITS_TEST_RESULTS.md)).

**For files larger than 100 MB:**
1. Upload directly to the Kubo instance via its HTTP API:
   ```bash
   curl -X POST -F "file=@large-file.bin" http://your-kubo-node:5001/api/v0/add
   ```
2. Use the returned CID in your manifest components as usual

**Note:** Upload times scale roughly linearly with file size:
- Small files (<10 MB): seconds
- Medium files (50 MB): ~1 minute
- Large files (90-99 MB): ~2-3 minutes

**Errors:**
- `400` - No files provided
- `413` - File exceeds 100 MB limit

---

### Download File

**`GET /cat/{cid}`**

Download file content by CID. Streams bytes directly from IPFS.

**Path Parameters:**
- `cid` - IPFS CID (e.g., `bafybeiabc123...`)

**Response:** `200 OK`
- Content-Type: `application/octet-stream` (or detected type)
- Headers:
  - `Cache-Control: public, max-age=31536000, immutable`
  - `X-IPFS-CID: {cid}`

**Errors:**
- `400` - Invalid CID format
- `404` - Content not found in IPFS

---

### List Entities

**`GET /entities`**

List entities with cursor-based pagination. Uses event-sourced backend with snapshots for scalable performance.

**Query Parameters:**
- `cursor` - Pagination cursor (CID from previous page's `next_cursor`, optional)
- `limit` - Max results per page (1-1000, default: 100)
- `include_metadata` - Include full entity details (default: false)

**Response:** `200 OK`

Without metadata:
```json
{
  "entities": [
    {
      "pi": "01J8ME3H6FZ3KQ5W1P2XY8K7E5",
      "tip": "bafybeiabc789..."
    }
  ],
  "limit": 100,
  "next_cursor": "bafybeiabc789..."
}
```

With `include_metadata=true`:
```json
{
  "entities": [
    {
      "pi": "01J8ME3H6FZ3KQ5W1P2XY8K7E5",
      "tip": "bafybeiabc789...",
      "ver": 3,
      "ts": "2025-10-08T22:10:15Z",
      "note": "Updated metadata",
      "component_count": 2,
      "children_count": 1
    }
  ],
  "limit": 100,
  "next_cursor": "bafybeiabc789..."
}
```

**Pagination:**
- First page: `GET /entities?limit=100`
- Next page: `GET /entities?limit=100&cursor={next_cursor}`
- `next_cursor` is `null` when no more pages available
- Cursor is an opaque CID returned by backend; do not construct manually

**Performance:**
- **Latest entities**: < 100ms (queries from snapshot)
- **Deep pagination**: < 500ms (cursor-based navigation)
- Sub-100ms queries regardless of total entity count
- Scales to millions of entities without performance degradation

**Implementation:**
- Entity list queried from latest snapshot
- Backend tracks all creates/updates via event stream
- Periodic snapshots capture complete entity list with event checkpoint
- Event stream enables incremental sync for mirroring clients

**Errors:**
- `400` - Invalid pagination params (limit not 1-1000 or invalid cursor format)
- `503` - Backend API unavailable (temporary)

---

### Create Entity

**`POST /entities`**

Create new entity with v1 manifest. Automatically appends entity to backend chain for indexing.

**Request:**
```json
{
  "pi": "01J8ME3H6FZ3KQ5W1P2XY8K7E5",  // optional; server generates if omitted
  "components": {
    "metadata": "bafybeiabc123...",
    "image": "bafybeiabc456..."
  },
  "children_pi": ["01GX...", "01GZ..."],  // optional
  "parent_pi": "01J8ME3H6FZ3KQ5W1P2XY8K7E5",  // optional; auto-updates parent
  "note": "Initial version"  // optional
}
```

**Response:** `201 Created`
```json
{
  "pi": "01J8ME3H6FZ3KQ5W1P2XY8K7E5",
  "ver": 1,
  "manifest_cid": "bafybeiabc789...",
  "tip": "bafybeiabc789..."
}
```

**Side Effects:**
- Manifest stored in IPFS as dag-json
- `.tip` file created in MFS for fast lookups
- "create" event appended to backend event stream for tracking
- Entity immediately appears in `/entities` listings
- **If `parent_pi` provided:** Parent entity automatically updated with new child in `children_pi` array (creates new version)

**Automatic Relationship Updates (One-Way Only):**

The API provides **one-way automatic updates** for parent-child relationships:

✅ **Child → Parent (Automatic):**
- When creating an entity with `parent_pi`, the parent is automatically updated
- Parent's `children_pi` array gets the new child appended (new version created)
- Both child and parent are linked bidirectionally in ONE API call

❌ **Parent → Children (Manual):**
- When creating an entity with `children_pi`, children are NOT automatically updated
- Children will NOT get `parent_pi` field set
- You must use `POST /relations` after entity creation to establish bidirectional links

**Best Practice for Nested Structures:**
```javascript
// 1. Create children first (no parent)
const child1 = await POST('/entities', { components: {...} });
const child2 = await POST('/entities', { components: {...} });

// 2. Create parent (initially without children, or with children_pi but unlinked)
const parent = await POST('/entities', { components: {...} });

// 3. Use /relations to establish bidirectional links (handles multiple children)
await POST('/relations', {
  parent_pi: parent.pi,
  expect_tip: parent.tip,
  add_children: [child1.pi, child2.pi]  // Bulk operation
});
```

**Errors:**
- `400` - Invalid request body
- `409` - PI already exists

**Note:** Parent updates happen asynchronously and are logged if they fail. Entity creation succeeds even if parent update fails.

---

### Get Entity

**`GET /entities/{pi}`**

Fetch latest manifest for entity.

**Query Parameters:**
- `resolve` - `cids` (default) | `bytes` (future: stream component bytes)

**Response:** `200 OK`
```json
{
  "pi": "01J8ME3H6FZ3KQ5W1P2XY8K7E5",
  "ver": 3,
  "ts": "2025-10-08T22:10:15Z",
  "manifest_cid": "bafybeiabc789...",
  "prev_cid": "bafybeiabc456...",
  "components": {
    "metadata": "bafybeiabc123...",
    "image": "bafybeiabc456..."
  },
  "children_pi": ["01GX..."],
  "parent_pi": "01J8PARENT...",  // optional: parent entity PI
  "note": "Updated metadata"
}
```

**Errors:**
- `404` - Entity not found

---

### Append Version

**`POST /entities/{pi}/versions`**

Append new version (CAS-protected).

**Request:**
```json
{
  "expect_tip": "bafybeiabc789...",  // required for CAS
  "components": {
    "metadata": "bafybeinew123..."  // partial updates ok
  },
  "components_remove": ["old-file.txt"],  // optional: remove component keys
  "children_pi_add": ["01NEW..."],
  "children_pi_remove": ["01OLD..."],
  "note": "Updated metadata"
}
```

**Response:** `201 Created`
```json
{
  "pi": "01J8ME3H6FZ3KQ5W1P2XY8K7E5",
  "ver": 4,
  "manifest_cid": "bafybeinew789...",
  "tip": "bafybeinew789..."
}
```

**Component Removal:**
The `components_remove` parameter allows removing component keys from the manifest:
- **Array of strings:** List of component keys to remove from the manifest
- **Validation:** All keys must exist in the current manifest (400 error if not found)
- **Conflict checking:** Cannot remove and add the same key in one request (400 error)
- **Processing order:** Removals are processed BEFORE additions
- **Empty array:** Valid no-op operation
- **Use case:** File reorganization - move files from parent to child entities without leaving duplicate references

**Example - File Reorganization:**
```json
{
  "expect_tip": "bafybeiabc789...",
  "components_remove": ["file1.pdf", "file2.pdf"],  // Remove files moved to children
  "components": {
    "description.txt": "bafybeidesc..."  // Add reorganization note
  },
  "children_pi_add": ["01GROUP1", "01GROUP2"],
  "note": "Reorganized files into groups"
}
```

**Processing Order:**
1. Remove components (from `components_remove`)
2. Add/update components (from `components`)
3. Remove children (from `children_pi_remove`)
4. Add children (from `children_pi_add`)

**Bidirectional Relationships:**
When using `children_pi_add` or `children_pi_remove`, the API automatically maintains bidirectional relationships:
- **Adding children:** Each child entity is automatically updated with `parent_pi` set to this entity's PI (bulk operation supported)
- **Removing children:** Each removed child entity has its `parent_pi` field cleared (bulk operation supported)
- All affected entities get new versions with descriptive notes
- Arrays can contain multiple children for bulk updates
- Children are processed **in parallel batches of 10** for optimal performance and stability
- **Maximum limit: 100 children per array** (enforced)

**Errors:**
- `400` - Invalid request body (including exceeding 100-child limit, non-existent component key in `components_remove`, or same key in both `components` and `components_remove`)
- `404` - Entity not found
- `409` - CAS failure (tip changed)

---

### List Versions

**`GET /entities/{pi}/versions`**

List version history (newest first).

**Query Parameters:**
- `limit` - Max items (1-1000, default 50)
- `cursor` - Pagination cursor (manifest CID)

**Response:** `200 OK`
```json
{
  "items": [
    {
      "ver": 4,
      "cid": "bafybeinew789...",
      "ts": "2025-10-08T23:00:00Z",
      "note": "Updated metadata"
    },
    {
      "ver": 3,
      "cid": "bafybeiabc789...",
      "ts": "2025-10-08T22:10:15Z"
    }
  ],
  "next_cursor": "bafybeiabc456..."  // null if no more
}
```

**Errors:**
- `400` - Invalid pagination params
- `404` - Entity not found

---

### Get Specific Version

**`GET /entities/{pi}/versions/{selector}`**

Fetch specific version by `cid:<CID>` or `ver:<N>`.

**Examples:**
- `/entities/01J8.../versions/cid:bafybeiabc123...`
- `/entities/01J8.../versions/ver:2`

**Response:** `200 OK` (same format as GET /entities/{pi})

**Errors:**
- `400` - Invalid selector
- `404` - Entity or version not found

---

### Update Relations

**`POST /relations`**

Update parent-child relationships with **automatic bidirectional linking**. This is the recommended way to establish parent-child relationships for bulk operations.

**Request:**
```json
{
  "parent_pi": "01J8ME3H6FZ3KQ5W1P2XY8K7E5",
  "expect_tip": "bafybeiabc789...",
  "add_children": ["01NEW1...", "01NEW2...", "01NEW3..."],  // Bulk: array of children
  "remove_children": ["01OLD..."],
  "note": "Linked new items"
}
```

**Response:** `201 Created` (same format as append version)

**Bidirectional Relationships (Automatic):**
This endpoint automatically maintains bidirectional relationships for ALL children in the arrays:
- **Adding children:** Each child entity is automatically updated with `parent_pi` set to parent's PI (creates new child version)
- **Removing children:** Each removed child entity has its `parent_pi` field cleared (creates new child version)
- Parent's `parent_pi` field is preserved across updates
- All affected entities get new versions with descriptive notes
- **Supports bulk operations:** Pass arrays with multiple children

**Processing:**
- Children are processed **in parallel batches** of 10 for optimal performance and stability
- Batching prevents overwhelming Cloudflare Workers with too many concurrent requests
- Each batch of 10 children processes in parallel, then moves to the next batch
- Typical performance: ~500-700ms for 10 children, ~2-3s for 50 children, ~5-6s for 100 children
- **Maximum limit: 100 children per request** (enforced)
- For batches over 100, split into multiple sequential API calls

**Errors:**
- `400` - Invalid request body (including exceeding 100-child limit)
- `404` - Parent not found
- `409` - CAS failure

**Example Error (exceeding limit):**
```json
{
  "error": "VALIDATION_ERROR",
  "message": "Cannot add 150 children in one request. Maximum is 100. Please split into multiple requests."
}
```

**Use Cases:**
- Establishing relationships after creating entities separately
- Adding multiple files to a folder in one operation
- Reorganizing hierarchies (remove from one parent, add to another)

---

### Resolve PI to Tip

**`GET /resolve/{pi}`**

Fast lookup: PI → tip CID (no manifest fetch).

**Response:** `200 OK`
```json
{
  "pi": "01J8ME3H6FZ3KQ5W1P2XY8K7E5",
  "tip": "bafybeiabc789..."
}
```

**Errors:**
- `404` - Entity not found

---

## Error Responses

All errors return JSON:
```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable message",
  "details": {}  // optional
}
```

**Error Codes:**
- `VALIDATION_ERROR` (400)
- `INVALID_PARAMS` (400)
- `INVALID_CURSOR` (400)
- `NOT_FOUND` (404)
- `CONFLICT` (409) - PI exists or CAS failure
- `CAS_FAILURE` (409) - Specific CAS error with actual/expected tips
- `BACKEND_ERROR` (503) - Backend API unavailable
- `IPFS_ERROR` (503)
- `INTERNAL_ERROR` (500)

---

## Data Model

### Manifest (dag-json)

```json
{
  "schema": "arke/manifest@v1",
  "pi": "01J8ME3H6FZ3KQ5W1P2XY8K7E5",
  "ver": 3,
  "ts": "2025-10-08T22:10:15Z",
  "prev": { "/": "bafybeiprev..." },  // IPLD link to previous version
  "components": {
    "metadata": { "/": "bafybeimeta..." },
    "image": { "/": "bafybeiimg..." }
  },
  "children_pi": ["01GX...", "01GZ..."],  // optional: child entities
  "parent_pi": "01J8PARENT...",  // optional: parent entity (for bidirectional traversal)
  "note": "Optional change note"
}
```

**Bidirectional Relationships:**
- `children_pi`: Array of child entity PIs (parent → children navigation)
- `parent_pi`: Single parent entity PI (child → parent navigation)
- Automatically maintained by the API when using `parent_pi` in entity creation or relationship endpoints
- Enables efficient graph traversal in both directions

### Tip (MFS)

Path: `/arke/index/<shard2[0]>/<shard2[1]>/<PI>.tip`

Content: `<manifest_cid>\n`

---

## ULID Format

PIs are ULIDs: 26-character base32 (Crockford alphabet), e.g., `01J8ME3H6FZ3KQ5W1P2XY8K7E5`

Regex: `^[0-9A-HJKMNP-TV-Z]{26}$`

---

## CID Format

All CIDs are CIDv1 (base32), e.g., `bafybeiabc123...`

---

## Backend Architecture

### Event Stream + Snapshot System

The API delegates entity indexing to an IPFS Server backend (FastAPI) that manages an event-sourced data structure:

**Components:**
1. **Event Stream** - Time-ordered log of all creates and updates
   - Stored as dag-json event entries in IPFS
   - Each event links to previous via `prev` field
   - Tracks both entity **creation** and **version updates**
   - Events include: `type` (create/update), `pi`, `ver`, `tip_cid`, `ts`
   - Enables complete change history and mirroring

2. **Snapshots** - Point-in-time entity index with event checkpoints
   - Periodic snapshots of all entities
   - Each snapshot includes `event_cid` checkpoint for incremental sync
   - Stored as dag-json with entity list
   - Enables efficient bulk mirroring and recovery

3. **Index Pointer** - Single source of truth
   - Stored in MFS at `/arke/index-pointer`
   - Tracks current snapshot CID and event stream head
   - Maintains total entity and event counts

**Query Strategy:**
- **GET /entities**: Returns paginated entity list from latest snapshot
- **GET /events**: Returns time-ordered event stream for change tracking
- **GET /snapshot/latest**: Returns complete snapshot with event checkpoint

**Lifecycle:**
1. Entity created → Append "create" event to stream
2. Version added → Append "update" event to stream
3. Periodic snapshots capture current state + event checkpoint
4. Clients can sync incrementally from checkpoint to head

**Event Types:**
- **create**: New entity added to system (ver typically 1)
- **update**: Existing entity received new version (ver > 1)

**Performance Benefits:**
- No MFS directory traversal (was O(n) with n=40K+ entities)
- Sub-100ms queries regardless of total entity count
- Event stream enables efficient mirroring and change tracking
- Scales to millions of entities and events

**Environment Variables:**
- `IPFS_SERVER_API_URL` - Backend API endpoint (e.g., `http://localhost:3000`)

**Backend Endpoints Used:**
- `POST /events/append` - Append create/update event to stream
- `GET /entities?limit=N&cursor=C` - Query entities with pagination
- `GET /events?limit=N&cursor=C` - Query event stream
- `GET /snapshot/latest` - Get latest snapshot with checkpoint

See `BACKEND_API_WALKTHROUGH.md` for complete backend architecture and event stream details.
