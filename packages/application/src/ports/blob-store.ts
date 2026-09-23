/**
 * Object storage infrastructure contract.
 *
 * 0.5.0 implements and tests this port but does not expose a media upload or
 * media publishing product API.
 */

import type { BinaryBody, BlobKey, BlobMetadata, BlobRead, StoredBlob } from "../contracts/storage.js";

export interface BlobStore {
  put(key: BlobKey, body: BinaryBody, metadata: BlobMetadata): Promise<StoredBlob>;
  get(key: BlobKey): Promise<BlobRead | null>;
  delete(key: BlobKey): Promise<void>;
  exists(key: BlobKey): Promise<boolean>;
}
