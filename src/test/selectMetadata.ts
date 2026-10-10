import type { NextEditorMetadata } from "../contexts/NextEditorContext";

export type MetadataSelector = (metadata: NextEditorMetadata) => unknown;

/**
 * What a mocked useNextEditorMetadata returns, like the real hook: the whole `metadata`,
 * or what the caller's selector picks from it.
 */
export const selectMetadata = (metadata: object, select?: MetadataSelector): unknown =>
  select ? select(metadata as NextEditorMetadata) : metadata;
