import { Logger } from '@nestjs/common';
import {
  applyUpdate,
  Doc,
  encodeStateAsUpdate,
  encodeStateVector,
  Map as YMap,
} from 'yjs';

import type { FolderPort } from '../../plugins/copilot/tools/organize';
import { generateFractionalIndexingKeyBetween } from './fractional-indexing';

/**
 * Server-side folder operations, written straight into the `folders` table's
 * CRDT doc.
 *
 * Row encoding mirrors `@toeverything/infra`'s `YjsTableAdapter`
 * (`packages/common/infra/src/orm/core/adapters/yjs/table.ts`):
 *
 *   Doc
 *     RowKey(string): YMap({ FieldA: primitive, ... })
 *
 * Each ORM table is its own YDoc whose guid is the table name, so the
 * `folders` table lives in the workspace doc `db$folders`. A row is a YMap
 * named by the row's `id`; fields are plain primitives. That is why the
 * frontend's `dbService.db.folders.create({ ... })` and this writer agree
 * without sharing code.
 *
 * Row shape comes from `packages/frontend/core/src/modules/db/schema/schema.ts`:
 *
 *   folders: { id, parentId?, data, type, index }
 *
 * `type` is 'folder' (data = display name) or 'doc' | 'tag' | 'collection'
 * (data = the linked node's id). Placing a doc in a folder therefore means
 * creating a `type: 'doc'` row whose `parentId` is the folder — the same thing
 * `FolderStore.createLink` does client-side.
 */
export class WorkspaceFolderPort implements FolderPort {
  private readonly logger = new Logger(WorkspaceFolderPort.name);

  /** The `folders` table's YDoc guid. */
  private readonly docId = 'db$folders';

  constructor(private readonly storage: WorkspaceDocStorage) {}

  async createFolder(workspaceId: string, name: string, actorId: string) {
    const folderId = newId();
    await this.upsertRow(workspaceId, actorId, {
      id: folderId,
      parentId: null,
      data: name,
      type: 'folder',
      index: await this.nextIndex(workspaceId, null),
    });
    this.logger.log(`created folder ${folderId} in ${workspaceId}`);
    return { folderId };
  }

  async listFolders(workspaceId: string) {
    const rows = await this.readRows(workspaceId);
    return rows
      .filter(r => r.type === 'folder')
      .map(r => ({
        folderId: r.id,
        name: r.data,
        docIds: rows
          .filter(c => c.parentId === r.id && c.type !== 'folder')
          .map(c => c.data),
      }));
  }

  async addDocToFolder(
    workspaceId: string,
    folderId: string,
    docId: string,
    actorId: string
  ) {
    const rows = await this.readRows(workspaceId);
    const folder = rows.find(r => r.id === folderId && r.type === 'folder');
    if (!folder) {
      throw new Error(`Folder ${folderId} not found`);
    }

    // Re-parent an existing link if this doc is already filed somewhere,
    // otherwise create one. Mirrors FolderStore.createLink / moveNode.
    const index = await this.nextIndex(workspaceId, folderId);
    const existing = rows.find(r => r.type === 'doc' && r.data === docId);
    await this.upsertRow(
      workspaceId,
      actorId,
      existing
        ? { ...existing, parentId: folderId, index }
        : { id: newId(), parentId: folderId, data: docId, type: 'doc', index }
    );
  }

  async removeDocFromFolder(
    workspaceId: string,
    folderId: string,
    docId: string,
    actorId: string
  ) {
    const rows = await this.readRows(workspaceId);
    const link = rows.find(
      r => r.type === 'doc' && r.data === docId && r.parentId === folderId
    );
    if (!link) {
      throw new Error(`Doc ${docId} is not in folder ${folderId}`);
    }
    await this.deleteRow(workspaceId, actorId, link.id);
  }

  // ── CRDT plumbing ───────────────────────────────────────────────────────

  private async readRows(workspaceId: string): Promise<FolderRow[]> {
    const existing = await this.storage.getDoc(workspaceId, this.docId);
    if (!existing?.bin?.length) return [];
    const doc = new Doc();
    applyUpdate(doc, toU8(existing.bin));
    const rows: FolderRow[] = [];
    for (const key of [...doc.share.keys()]) {
      const map = doc.getMap(key) as YMap<unknown>;
      const id = map.get('id');
      if (typeof id !== 'string') continue;
      rows.push({
        id,
        parentId: (map.get('parentId') as string | null) ?? null,
        data: (map.get('data') as string) ?? '',
        type: (map.get('type') as string) ?? 'folder',
        index: (map.get('index') as string) ?? '',
      });
    }
    return rows;
  }

  /**
   * Merge one row into `db$folders` and push only the delta, the same shape
   * `DocWriter.updateDoc` uses for markdown documents.
   */
  private async upsertRow(
    workspaceId: string,
    actorId: string,
    row: FolderRow
  ) {
    const { before, after } = await this.copyDoc(workspaceId);

    const record = after.getMap(row.id) as YMap<unknown>;
    after.transact(() => {
      record.set('id', row.id);
      record.set('parentId', row.parentId ?? null);
      record.set('data', row.data);
      record.set('type', row.type);
      record.set('index', row.index);
    }, ORIGIN);

    await this.push(workspaceId, actorId, before, after);
  }

  private async deleteRow(
    workspaceId: string,
    actorId: string,
    rowId: string
  ) {
    const { before, after } = await this.copyDoc(workspaceId);
    after.transact(() => {
      after.share.delete(rowId);
    }, ORIGIN);
    await this.push(workspaceId, actorId, before, after);
  }

  private async copyDoc(workspaceId: string) {
    const existing = await this.storage.getDoc(workspaceId, this.docId);
    const before = new Doc();
    if (existing?.bin?.length) {
      applyUpdate(before, toU8(existing.bin));
    }
    // Second doc seeded from `before`'s full state, so the diff below is
    // exactly the bytes this call changed.
    const after = new Doc();
    applyUpdate(after, encodeStateAsUpdate(before));
    return { before, after };
  }

  /**
   * `actorId` must be the real calling user — `PgWorkspaceDocStorageAdapter`
   * attributes the write to it and rejects a synthetic one with
   * `domain_permission_denied` (which surfaced as "Failed to store doc
   * updates" in the tool response).
   */
  private async push(
    workspaceId: string,
    actorId: string,
    before: Doc,
    after: Doc
  ) {
    const delta = encodeStateAsUpdate(after, encodeStateVector(before));
    await this.storage.pushDocUpdates(workspaceId, this.docId, [delta], actorId);
    this.logger.debug(`pushed folder delta to ${workspaceId}/${this.docId}`);
  }

  /** Append after the last sibling, matching `FolderNode.indexAt('after')`. */
  private async nextIndex(workspaceId: string, parentId: string | null) {
    const rows = await this.readRows(workspaceId);
    const siblings = rows
      .filter(r => (r.parentId ?? null) === parentId)
      .sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
    return generateFractionalIndexingKeyBetween(
      siblings.at(-1)?.index ?? null,
      null
    );
  }
}

const ORIGIN = 'WorkspaceFolderPort';

type FolderRow = {
  id: string;
  parentId: string | null;
  data: string;
  type: string;
  index: string;
};

/** The slice of `PgWorkspaceDocStorageAdapter` this port needs. */
export interface WorkspaceDocStorage {
  getDoc(
    workspaceId: string,
    docId: string
  ): Promise<{ bin?: Uint8Array | Buffer | null } | null>;
  pushDocUpdates(
    workspaceId: string,
    docId: string,
    updates: Uint8Array[],
    editorId: string
  ): Promise<unknown>;
}

function toU8(bin: Uint8Array | Buffer): Uint8Array {
  return bin instanceof Uint8Array ? bin : new Uint8Array(bin);
}

/**
 * Row ids are `f.string().primaryKey().default(nanoid)` client-side. Any
 * collision-free string satisfies the schema; a UUID keeps this dependency-free
 * on the server while staying readable in the CRDT doc.
 */
function newId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 21);
}
