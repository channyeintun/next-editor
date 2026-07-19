import * as vscode from "vscode";
import type {
  DocumentDescriptor,
  EolMode,
  UriSchemeClass,
  WorkspaceRootDescriptor,
} from "../model/events";
import {
  newCheckpointId,
  newDocumentId,
  newRootId,
  type CheckpointId,
  type DocumentId,
  type RootId,
} from "../model/ids";
import { sha256Hex, utf8ByteLength } from "./hash";
import { DocumentShadow } from "./DocumentShadow";

export type EnrolledDocument = {
  documentId: DocumentId;
  resourceKey: string;
  schemeClass: UriSchemeClass;
  shadow: DocumentShadow;
  languageId: string;
  open: boolean;
  // Set when capture stopped for this document (e.g. size limit hit).
  droppedReason: "limit" | null;
};

export function toEolMode(eol: vscode.EndOfLine): EolMode {
  return eol === vscode.EndOfLine.CRLF ? "CRLF" : "LF";
}

// Canonical in-memory resource identity (never persisted): the full URI.
export function resourceKeyOf(uri: vscode.Uri): string {
  return uri.toString();
}

export class DocumentRegistry {
  private readonly byResourceKey = new Map<string, EnrolledDocument>();
  private readonly rootsByKey = new Map<string, WorkspaceRootDescriptor>();
  private rootOrdinal = 0;

  /** Session-local root descriptors, assigning IDs on first sight. */
  snapshotRoots(): WorkspaceRootDescriptor[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const out: WorkspaceRootDescriptor[] = [];
    for (const folder of folders) {
      const key = resourceKeyOf(folder.uri);
      let descriptor = this.rootsByKey.get(key);
      if (!descriptor) {
        descriptor = {
          rootId: newRootId(),
          name: folder.name,
          ordinal: this.rootOrdinal++,
        };
        this.rootsByKey.set(key, descriptor);
      }
      out.push(descriptor);
    }
    return out;
  }

  private rootFor(uri: vscode.Uri): RootId | null {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return null;
    }
    const key = resourceKeyOf(folder.uri);
    const descriptor = this.rootsByKey.get(key);
    return descriptor ? descriptor.rootId : null;
  }

  get(document: vscode.TextDocument): EnrolledDocument | undefined {
    return this.byResourceKey.get(resourceKeyOf(document.uri));
  }

  getByUri(uri: vscode.Uri): EnrolledDocument | undefined {
    return this.byResourceKey.get(resourceKeyOf(uri));
  }

  isEnrolled(document: vscode.TextDocument): boolean {
    const entry = this.get(document);
    return entry !== undefined && entry.droppedReason === null;
  }

  all(): IterableIterator<EnrolledDocument> {
    return this.byResourceKey.values();
  }

  /**
   * Enroll a document, returning its descriptor plus the initial checkpoint
   * content. Caller emits document.enrolled + document.checkpoint.
   */
  enroll(
    document: vscode.TextDocument,
    schemeClass: UriSchemeClass,
    nowTUs: number,
  ): {
    entry: EnrolledDocument;
    descriptor: DocumentDescriptor;
    checkpointId: CheckpointId;
  } {
    const resourceKey = resourceKeyOf(document.uri);
    const existing = this.byResourceKey.get(resourceKey);
    if (existing) {
      throw new Error("document already enrolled");
    }

    const text = document.getText();
    const eol = toEolMode(document.eol);
    const checkpointId = newCheckpointId();
    const entry: EnrolledDocument = {
      documentId: newDocumentId(),
      resourceKey,
      schemeClass,
      shadow: new DocumentShadow(text, document.version, eol, nowTUs),
      languageId: document.languageId,
      open: true,
      droppedReason: null,
    };
    this.byResourceKey.set(resourceKey, entry);

    const descriptor: DocumentDescriptor = {
      documentId: entry.documentId,
      rootId: document.uri.scheme === "untitled" ? null : this.rootFor(document.uri),
      logicalPath: logicalPathOf(document),
      displayName: displayNameOf(document),
      schemeClass,
      languageId: document.languageId,
      eol,
      initialVersion: document.version,
      initialCheckpointId: checkpointId,
      byteLength: utf8ByteLength(text),
      sha256: sha256Hex(text),
    };
    return { entry, descriptor, checkpointId };
  }

  markClosed(document: vscode.TextDocument): EnrolledDocument | undefined {
    const entry = this.get(document);
    if (entry && entry.open) {
      entry.open = false;
      return entry;
    }
    return undefined;
  }

  /**
   * Reopen of a known resource: reuse the logical documentId
   * (plan §8.3). Returns what changed so the caller can emit
   * document.resumed / languageChanged / a fresh checkpoint.
   */
  markReopened(document: vscode.TextDocument):
    | {
        entry: EnrolledDocument;
        contentChanged: boolean;
        languageChanged: boolean;
      }
    | undefined {
    const entry = this.get(document);
    if (!entry || entry.open) {
      return undefined;
    }
    entry.open = true;
    const observed = document.getText();
    const contentChanged = sha256Hex(observed) !== entry.shadow.sha256;
    const languageChanged = document.languageId !== entry.languageId;
    entry.languageId = document.languageId;
    return { entry, contentChanged, languageChanged };
  }
}

// Privacy-preserving logical path (plan §7.5): root-relative for documents
// inside a workspace root, otherwise just the display name. Never an
// absolute path, query string, or authority.
function logicalPathOf(document: vscode.TextDocument): string {
  if (document.uri.scheme === "untitled") {
    return displayNameOf(document);
  }
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (folder) {
    const relative = vscode.workspace.asRelativePath(document.uri, false);
    // asRelativePath returns the full fsPath when outside the root; guard.
    if (!relative.startsWith("/") && !/^[A-Za-z]:/.test(relative)) {
      return relative.replace(/\\/g, "/");
    }
  }
  return displayNameOf(document);
}

function displayNameOf(document: vscode.TextDocument): string {
  if (document.uri.scheme === "untitled") {
    // untitled URIs look like untitled:Untitled-1.
    return document.uri.path || "Untitled";
  }
  const segments = document.uri.path.split("/");
  return segments[segments.length - 1] || document.uri.path;
}
