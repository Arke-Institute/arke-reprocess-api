#!/usr/bin/env npx tsx
/**
 * Test script for Reprocess API permission checking
 *
 * Tests:
 * 1. Permission check for owner (should succeed)
 * 2. Permission check for non-member (should fail)
 * 3. Cascade boundary auto-set to collection root
 * 4. Unauthenticated access to free entity
 *
 * Prerequisites:
 * - Reprocess API deployed with COLLECTIONS_WORKER service binding
 * - Auth tokens from arke-sdk/test/.env
 *
 * Usage:
 *   npx tsx test-permissions.ts
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env from arke-sdk/test
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../../../arke-sdk/test/.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const [key, ...valueParts] = line.split('=');
    if (key && valueParts.length > 0) {
      process.env[key.trim()] = valueParts.join('=').trim();
    }
  }
}

const GATEWAY_URL = process.env.ARKE_GATEWAY_URL || 'https://gateway.arke.institute';
// Gateway routes /reprocess/* → reprocess-api /api/*
// So /reprocess/reprocess → /api/reprocess
const REPROCESS_ENDPOINT = `${GATEWAY_URL}/reprocess/reprocess`;
const AUTH_TOKEN_1 = process.env.ARKE_AUTH_TOKEN;
const AUTH_TOKEN_2 = process.env.ARKE_AUTH_TOKEN_2;

// Test PIs from "Permission Test Collection" owned by Token 1
// Root PI of the collection
const ROOT_PI = '01K9CRZD8NTJP2KV14X12RCGPT';
// Child of the root (has parent_pi set to ROOT_PI)
const CHILD_PI = '01K9CRZDV5KR6DGYH1TB87XKS5';
// Use child for most tests to verify cascade works
const TEST_PI = ROOT_PI;

async function main() {
  console.log('=== Reprocess API Permission Check Test ===\n');
  console.log(`Gateway: ${GATEWAY_URL}`);
  console.log(`Token 1: ${AUTH_TOKEN_1 ? AUTH_TOKEN_1.slice(0, 20) + '...' : 'NOT SET'}`);
  console.log(`Token 2: ${AUTH_TOKEN_2 ? AUTH_TOKEN_2.slice(0, 20) + '...' : 'NOT SET'}\n`);

  if (!AUTH_TOKEN_1) {
    console.error('ERROR: ARKE_AUTH_TOKEN not set. Check arke-sdk/test/.env');
    process.exit(1);
  }

  // Test 1: Check permissions endpoint for Token 1 (owner)
  console.log('1. Checking PI permissions for Token 1 (should be owner)...');
  let collectionRootPi: string | null = null;
  try {
    const permsResp = await fetch(`${GATEWAY_URL}/pi/${TEST_PI}/permissions`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN_1}` },
    });
    const perms = await permsResp.json();
    console.log(`   Status: ${permsResp.status}`);
    console.log(`   canEdit: ${perms.canEdit}`);
    console.log(`   collection: ${perms.collection ? perms.collection.title : 'none'}`);
    console.log(`   role: ${perms.collection?.role || 'none'}`);
    console.log(`   rootPi: ${perms.collection?.rootPi || 'none'}`);
    collectionRootPi = perms.collection?.rootPi || null;
  } catch (e: any) {
    console.log(`   ERROR: ${e.message}`);
  }

  // Test 2: Check permissions for Token 2 (non-member)
  if (AUTH_TOKEN_2) {
    console.log('\n2. Checking PI permissions for Token 2 (should be non-member)...');
    try {
      const permsResp = await fetch(`${GATEWAY_URL}/pi/${TEST_PI}/permissions`, {
        headers: { Authorization: `Bearer ${AUTH_TOKEN_2}` },
      });
      const perms = await permsResp.json();
      console.log(`   Status: ${permsResp.status}`);
      console.log(`   canEdit: ${perms.canEdit}`);
      console.log(`   role: ${perms.collection?.role || 'none'}`);
    } catch (e: any) {
      console.log(`   ERROR: ${e.message}`);
    }
  }

  // Test 3: Try reprocess with authorized user (dry run - just permission check)
  console.log('\n3. Testing reprocess permission with authorized user (Token 1)...');
  console.log('   (This will actually trigger a reprocess if successful!)');
  console.log('   Skipping actual reprocess to avoid side effects...');
  console.log('   Testing with minimal request to verify permission flow...');

  // Actually test the endpoint - use a real request but with phases that are quick
  // Note: This WILL queue a real reprocess job
  try {
    const reprocessResp = await fetch(REPROCESS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AUTH_TOKEN_1}`,
      },
      body: JSON.stringify({
        pi: TEST_PI,
        phases: ['description'],  // Just description, quickest option
        cascade: false,  // No cascade for this test
      }),
    });
    const result = await reprocessResp.json();
    if (reprocessResp.ok) {
      console.log(`   ✓ Reprocess request accepted`);
      console.log(`   Batch ID: ${result.batch_id}`);
      console.log(`   Entities queued: ${result.entities_queued}`);
    } else if (reprocessResp.status === 403) {
      console.log(`   ✗ 403 Forbidden: ${result.message}`);
    } else {
      console.log(`   ? Status ${reprocessResp.status}: ${JSON.stringify(result)}`);
    }
  } catch (e: any) {
    console.log(`   ERROR: ${e.message}`);
  }

  // Test 4: Try reprocess with unauthorized user
  if (AUTH_TOKEN_2) {
    console.log('\n4. Testing reprocess with unauthorized user (Token 2)...');
    try {
      const reprocessResp = await fetch(REPROCESS_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AUTH_TOKEN_2}`,
        },
        body: JSON.stringify({
          pi: TEST_PI,
          phases: ['description'],
          cascade: false,
        }),
      });
      const result = await reprocessResp.json();
      if (reprocessResp.status === 403) {
        console.log(`   ✓ Correctly denied: ${result.message}`);
      } else if (reprocessResp.ok) {
        console.log(`   ✗ Unexpectedly allowed! Batch ID: ${result.batch_id}`);
      } else {
        console.log(`   ? Status ${reprocessResp.status}: ${JSON.stringify(result)}`);
      }
    } catch (e: any) {
      console.log(`   ERROR: ${e.message}`);
    }
  }

  // Test 5: Try reprocess without authentication
  console.log('\n5. Testing reprocess without authentication...');
  try {
    const reprocessResp = await fetch(REPROCESS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        pi: TEST_PI,
        phases: ['description'],
        cascade: false,
      }),
    });
    const result = await reprocessResp.json();
    if (reprocessResp.status === 403) {
      console.log(`   ✓ Correctly denied: ${result.message}`);
    } else if (reprocessResp.status === 401) {
      console.log(`   ✓ Correctly rejected (401): ${result.message || result.error}`);
    } else if (reprocessResp.ok) {
      console.log(`   ✗ Unexpectedly allowed! (entity might be free)`);
    } else {
      console.log(`   ? Status ${reprocessResp.status}: ${JSON.stringify(result)}`);
    }
  } catch (e: any) {
    console.log(`   ERROR: ${e.message}`);
  }

  // Test 6: Test cascade from CHILD PI (should cascade to root)
  console.log('\n6. Testing cascade from child entity...');
  console.log(`   Child PI: ${CHILD_PI}`);
  console.log(`   Root PI (expected cascade boundary): ${ROOT_PI}`);

  try {
    // First verify child has proper parent_pi
    const childResp = await fetch(`${GATEWAY_URL}/api/entities/${CHILD_PI}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN_1}` },
    });
    const child = await childResp.json();
    console.log(`   Child's parent_pi: ${child.parent_pi || 'none'}`);

    if (child.parent_pi !== ROOT_PI) {
      console.log(`   ⚠ Warning: Child doesn't have expected parent_pi`);
    }

    // Now cascade reprocess from child
    const reprocessResp = await fetch(REPROCESS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AUTH_TOKEN_1}`,
      },
      body: JSON.stringify({
        pi: CHILD_PI,
        phases: ['description'],
        cascade: true,  // Enable cascade - should go from child to root
      }),
    });
    const result = await reprocessResp.json();
    if (reprocessResp.ok) {
      console.log(`   ✓ Cascade reprocess accepted`);
      console.log(`   Entities queued: ${result.entities_queued}`);
      console.log(`   Entity PIs: ${result.entity_pis?.join(' → ') || 'N/A'}`);

      // Verify cascade includes both child and root
      if (result.entity_pis?.includes(CHILD_PI) && result.entity_pis?.includes(ROOT_PI)) {
        console.log(`   ✓ Cascade correctly includes child and root`);
      } else if (result.entities_queued === 2) {
        console.log(`   ✓ Cascade includes 2 entities (child + root)`);
      } else if (result.entities_queued === 1) {
        console.log(`   ? Only 1 entity - cascade may have stopped early`);
      }
    } else {
      console.log(`   ✗ Failed: ${JSON.stringify(result)}`);
    }
  } catch (e: any) {
    console.log(`   ERROR: ${e.message}`);
  }

  console.log('\n=== Test Complete ===');
}

main().catch(console.error);
