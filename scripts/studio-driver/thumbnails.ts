/**
 * The thumbnail folder a workflow is started with. The studio's folder picker
 * hands over every image of an accepted type and matches them to lessons by
 * file name; the driver hands over the same files as bytes.
 */

import { extname } from "node:path";
import { THUMBNAIL_MIME_TYPES } from "../../infra/client/upload/thumbnailConstraints.ts";

const TYPE_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/** The image type of a thumbnail file, or null for a file the site does not take as a thumbnail. */
export function thumbnailTypeOf(fileName: string): string | null {
  const type = TYPE_BY_EXTENSION[extname(fileName).toLowerCase()];
  return type && THUMBNAIL_MIME_TYPES.includes(type) ? type : null;
}
