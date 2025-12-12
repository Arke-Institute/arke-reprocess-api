/**
 * Arke Reprocessor API
 *
 * Cloudflare Worker that enables on-demand reprocessing of existing entities
 */

import { processReprocessingRequest } from './reprocessor';
import { checkReprocessPermission } from './permissions';
import type { Env, ErrorResponse } from './types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS headers for development
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/' && request.method === 'GET') {
      return jsonResponse({
        service: 'arke-reprocessor-api',
        version: '0.1.0',
        status: 'ok',
      }, 200, corsHeaders);
    }

    // Reprocess endpoint
    if (url.pathname === '/api/reprocess' && request.method === 'POST') {
      return handleReprocessRequest(request, env, corsHeaders);
    }

    // 404 for unknown routes
    return jsonResponse({
      error: 'NOT_FOUND',
      message: 'Endpoint not found',
    }, 404, corsHeaders);
  },
};

/**
 * Handle reprocess request
 */
async function handleReprocessRequest(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    // Extract user ID from header (set by gateway after auth)
    const userId = request.headers.get('X-User-Id');

    // Parse request body
    let body: any;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({
        error: 'VALIDATION_ERROR',
        message: 'Invalid JSON in request body',
      }, 400, corsHeaders);
    }

    // Validate required fields
    if (!body.pi) {
      return jsonResponse({
        error: 'VALIDATION_ERROR',
        message: 'Missing required field: pi',
      }, 400, corsHeaders);
    }

    if (!body.phases || !Array.isArray(body.phases) || body.phases.length === 0) {
      return jsonResponse({
        error: 'VALIDATION_ERROR',
        message: 'Missing or invalid field: phases (must be non-empty array)',
      }, 400, corsHeaders);
    }

    // Validate PI format (26-character ULID)
    const piRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/;
    if (!piRegex.test(body.pi)) {
      return jsonResponse({
        error: 'VALIDATION_ERROR',
        message: 'Invalid PI format (must be 26-character ULID)',
      }, 400, corsHeaders);
    }

    // Validate phases
    const validPhases = ['pinax', 'cheimarros', 'description'];
    const invalidPhases = body.phases.filter((p: string) => !validPhases.includes(p));
    if (invalidPhases.length > 0) {
      return jsonResponse({
        error: 'VALIDATION_ERROR',
        message: `Invalid phases: ${invalidPhases.join(', ')}. Valid phases: ${validPhases.join(', ')}`,
      }, 400, corsHeaders);
    }

    // Permission check - verify user can reprocess this entity
    const permCheck = await checkReprocessPermission(env, userId, body.pi);

    if (!permCheck.allowed) {
      return jsonResponse({
        error: 'FORBIDDEN',
        message: permCheck.reason || 'Not authorized to reprocess this entity',
      }, 403, corsHeaders);
    }

    // Extract optional fields
    const cascade = body.cascade ?? false;
    const explicitStopAtPI = body.options?.stop_at_pi;
    const customPrompts = body.options?.custom_prompts;
    const customNote = body.options?.custom_note;

    // Determine effective stop_at_pi:
    // 1. Use explicit stop_at_pi if provided (advanced override)
    // 2. Otherwise use collection rootPi (automatic boundary)
    // 3. If no collection (free entity), use default (cascade to absolute root)
    let effectiveStopAtPI: string;
    if (explicitStopAtPI) {
      effectiveStopAtPI = explicitStopAtPI;
      console.log(`[API] Using explicit stop_at_pi: ${effectiveStopAtPI}`);
    } else if (permCheck.cascadeStopPi) {
      effectiveStopAtPI = permCheck.cascadeStopPi;
      console.log(`[API] Auto-setting cascade boundary to collection root: ${effectiveStopAtPI}`);
    } else {
      effectiveStopAtPI = '00000000000000000000000000';
      console.log(`[API] No collection boundary, cascade to absolute root`);
    }

    // Validate stopAtPI format if explicitly provided
    if (explicitStopAtPI && explicitStopAtPI !== '00000000000000000000000000' && !piRegex.test(explicitStopAtPI)) {
      return jsonResponse({
        error: 'VALIDATION_ERROR',
        message: 'Invalid stop_at_pi format (must be 26-character ULID)',
      }, 400, corsHeaders);
    }

    // Validate custom_prompts structure if provided
    if (customPrompts !== undefined) {
      if (typeof customPrompts !== 'object' || Array.isArray(customPrompts)) {
        return jsonResponse({
          error: 'VALIDATION_ERROR',
          message: 'custom_prompts must be an object',
        }, 400, corsHeaders);
      }

      const validPromptKeys = ['general', 'reorganization', 'pinax', 'description', 'cheimarros'];
      const providedKeys = Object.keys(customPrompts);
      const invalidKeys = providedKeys.filter(k => !validPromptKeys.includes(k));

      if (invalidKeys.length > 0) {
        return jsonResponse({
          error: 'VALIDATION_ERROR',
          message: `Invalid custom_prompts keys: ${invalidKeys.join(', ')}. Valid keys: ${validPromptKeys.join(', ')}`,
        }, 400, corsHeaders);
      }

      // Validate that all values are strings
      for (const [key, value] of Object.entries(customPrompts)) {
        if (typeof value !== 'string') {
          return jsonResponse({
            error: 'VALIDATION_ERROR',
            message: `custom_prompts.${key} must be a string`,
          }, 400, corsHeaders);
        }
      }
    }

    console.log(`[API] Received reprocess request for PI: ${body.pi}`);
    console.log(`[API] User: ${userId || 'anonymous'}`);
    console.log(`[API] Phases: ${body.phases.join(', ')}`);
    console.log(`[API] Cascade: ${cascade}`);
    console.log(`[API] Effective stop_at_pi: ${effectiveStopAtPI}`);
    console.log(`[API] Custom prompts: ${customPrompts ? 'Provided' : 'Not provided'}`);
    console.log(`[API] Custom note: ${customNote ? `"${customNote}"` : 'Not provided'}`);

    // Process reprocessing request
    const result = await processReprocessingRequest({
      pi: body.pi,
      phases: body.phases,
      cascade: cascade,
      stopAtPI: effectiveStopAtPI,
      customPrompts: customPrompts,
      customNote: customNote,
    }, env);

    return jsonResponse(result, 200, corsHeaders);

  } catch (error: any) {
    console.error('[API] Error processing reprocess request:', error);

    // Check for specific error types
    if (error.message.includes('Entity not found')) {
      return jsonResponse({
        error: 'NOT_FOUND',
        message: error.message,
      }, 404, corsHeaders);
    }

    if (error.message.includes('Content not found')) {
      return jsonResponse({
        error: 'NOT_FOUND',
        message: error.message,
      }, 404, corsHeaders);
    }

    // Generic error response
    return jsonResponse({
      error: 'INTERNAL_ERROR',
      message: error.message || 'An internal error occurred',
    }, 500, corsHeaders);
  }
}

/**
 * Helper to create JSON response with headers
 */
function jsonResponse(
  data: any,
  status: number,
  additionalHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status: status,
    headers: {
      'Content-Type': 'application/json',
      ...additionalHeaders,
    },
  });
}
