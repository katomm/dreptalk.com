// The git blob hash of a file, computed the way git does it: sha1 over the
// header "blob <size>\0" followed by the bytes. An edition stores this hash of
// its frozen pack file, so the exact data it was written from stays pinned
// even though the file sits on a moving branch.
import { createHash } from 'node:crypto';

export function gitBlobHash(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
