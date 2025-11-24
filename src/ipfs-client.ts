/**
 * IPFS Wrapper Client
 *
 * Provides typed interface to the arke-ipfs-api service binding
 */

import type { IPFSEntity } from './types';

export class IPFSWrapperClient {
  constructor(private service: Fetcher) {}

  /**
   * Fetch entity by PI
   */
  async getEntity(pi: string): Promise<IPFSEntity> {
    const response = await this.service.fetch(`https://api.arke.institute/entities/${pi}`);

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Entity not found: ${pi}`);
      }
      const errorText = await response.text();
      throw new Error(`Failed to fetch entity ${pi}: ${response.status} ${errorText}`);
    }

    return await response.json() as IPFSEntity;
  }

  /**
   * Download content by CID
   */
  async downloadContent(cid: string): Promise<string> {
    const response = await this.service.fetch(`https://api.arke.institute/cat/${cid}`);

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Content not found: ${cid}`);
      }
      const errorText = await response.text();
      throw new Error(`Failed to download content ${cid}: ${response.status} ${errorText}`);
    }

    return await response.text();
  }

  /**
   * Download content as bytes (for binary files)
   */
  async downloadContentBytes(cid: string): Promise<ArrayBuffer> {
    const response = await this.service.fetch(`https://api.arke.institute/cat/${cid}`);

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Content not found: ${cid}`);
      }
      const errorText = await response.text();
      throw new Error(`Failed to download content ${cid}: ${response.status} ${errorText}`);
    }

    return await response.arrayBuffer();
  }
}
