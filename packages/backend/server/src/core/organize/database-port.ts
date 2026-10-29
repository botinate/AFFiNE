import { Logger } from '@nestjs/common';
import {
  applyUpdate,
  Array as YArray,
  Doc,
  encodeStateAsUpdate,
  encodeStateVector,
  Map as YMap,
  Text as YText,
} from 'yjs';

/**
 * Append rows to an existing `affine:database` block.
 *
 * Scope note: this fills a database that already exists. *Creating* one is
 * deliberately out of reach — `doc_create`/`doc_update` route through the
 * external `affine_doc_loader` crate, which will not emit a database block.
 * Rows, though, are simple: `DatabaseSource.rowAdd` is literally
 *
 *     doc.addBlock('affine:paragraph', {}, databaseBlockId, index)
 *
 * so a row is an `affine:paragraph` child of the database block, and cell
 * values hang off the block in `prop:cells`:
 *
 *     prop:cells[rowId][columnId] = { columnId, value }
 *     prop:columns = [{ id, type, name, data }]
 *
 * The `title` column is special — its value is the row block's own text, so a
 * title cell is written as the paragraph's `prop:text` rather than into
 * `prop:cells`.
 *
 * Column value shapes (from blocksuite/affine/data-view/src/property-presets):
 *
 *   text          string
 *   number        number | null
 *   select        option id (string | null)
 *   multi-select  option id[] 
 *
 * For select columns the *display name* is not the value: `column.data.options`
 * is `[{ id, color, value }]` where `value` is the label and `id` is what the
 * cell holds. Passing a label therefore has to resolve-or-create an option,
 * which is exactly what the client's `fromString` does (nanoid id + tag
 * colour), so this port mirrors it.
 */
export class WorkspaceDatabasePort {
  private readonly logger = new Logger(WorkspaceDatabasePort.name);

  constructor(private readonly storage: WorkspaceDocStorage) {}

  /**
   * `rows` is a list of `{ columnName: cellValue }`. Column names are matched
   * case-insensitively against `prop:columns`; unknown columns are reported
   * back rather than silently dropped.
   */
  async addRows(
    workspaceId: string,
    docId: string,
    databaseBlockId: string,
    rows: Record<string, unknown>[],
    actorId: string
  ): Promise<{ added: number; skipped: string[] }> {
    const existing = await this.storage.getDoc(workspaceId, docId);
    if (!existing?.bin?.length) {
      throw new Error(`Doc ${docId} not found in workspace ${workspaceId}`);
    }

    const before = new Doc();
    applyUpdate(before, toU8(existing.bin));
    const after = new Doc();
    applyUpdate(after, encodeStateAsUpdate(before));

    const blocks = after.getMap('blocks') as YMap<unknown>;
    const dbBlock = blocks.get(databaseBlockId) as YMap<unknown> | undefined;
    if (!dbBlock) {
      throw new Error(`Database block ${databaseBlockId} not found in ${docId}`);
    }
    if (dbBlock.get('sys:flavour') !== 'affine:database') {
      throw new Error(
        `Block ${databaseBlockId} is ${String(dbBlock.get('sys:flavour'))}, not affine:database`
      );
    }

    const columns = readColumns(dbBlock);
    const byName = new Map(
      columns.map(c => [c.name.trim().toLowerCase(), c] as const)
    );
    const titleColumn = columns.find(c => c.id === 'title');

    const skipped: string[] = [];
    const children = dbBlock.get('sys:children') as YArray<string>;

    let added = 0;
    after.transact(() => {
      for (const row of rows) {
        const rowId = newId();
        // A row is an affine:paragraph child of the database block — exactly
        // what DatabaseSource.rowAdd produces.
        children.push([rowId]);

        const rowBlock = new YMap<unknown>();
        blocks.set(rowId, rowBlock);
        rowBlock.set('sys:id', rowId);
        rowBlock.set('sys:flavour', 'affine:paragraph');
        rowBlock.set('sys:version', 1);
        rowBlock.set('sys:children', new YArray());
        rowBlock.set('prop:type', 'paragraph');
        const text = new YText();
        rowBlock.set('prop:text', text);
        rowBlock.set('prop:collapsed', false);

        const cells = (dbBlock.get('prop:cells') as YMap<unknown>) ?? new YMap();
        if (!dbBlock.get('prop:cells')) dbBlock.set('prop:cells', cells);
        const rowCells = new YMap<unknown>();
        cells.set(rowId, rowCells);

        for (const [key, raw] of Object.entries(row)) {
          const col = byName.get(String(key).trim().toLowerCase());
          if (!col) {
            skipped.push(key);
            continue;
          }
          if (col.id === 'title' || (titleColumn && col === titleColumn)) {
            text.insert(0, String(raw ?? ''));
            continue;
          }
          const value = normaliseValue(col, raw);
          if (value === undefined) {
            skipped.push(`${key} (unsupported type ${col.type})`);
            continue;
          }
          const cell = new YMap<unknown>();
          rowCells.set(col.id, cell);
          cell.set('columnId', col.id);
          cell.set('value', value);
        }
        added++;
      }
    }, ORIGIN);

    await this.storage.pushDocUpdates(
      workspaceId,
      docId,
      [encodeStateAsUpdate(after, encodeStateVector(before))],
      actorId
    );

    this.logger.log(
      `added ${added} rows to ${docId}/${databaseBlockId}` +
        (skipped.length ? ` (skipped: ${skipped.join(', ')})` : '')
    );
    return { added, skipped };
  }
}

type ColumnDataType = {
  id: string;
  type: string;
  name: string;
  data: { options?: { id: string; color: string; value: string }[] };
};

function readColumns(dbBlock: YMap<unknown>): ColumnDataType[] {
  const raw = dbBlock.get('prop:columns');
  return Array.isArray(raw) ? (raw as ColumnDataType[]) : [];
}

/**
 * Coerce a caller-supplied cell into the column's value shape. Mirrors the
 * property presets' `rawValue.fromString`, including select's resolve-or-create
 * so a plain label ("High") becomes a real option rather than a dangling id.
 */
function normaliseValue(col: ColumnDataType, raw: unknown): unknown {
  switch (col.type) {
    case 'text':
      return String(raw ?? '');
    case 'number': {
      if (raw === null || raw === undefined || raw === '') return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'select': {
      if (raw === null || raw === undefined || raw === '') return null;
      const label = String(raw).trim();
      const options = (col.data.options ??= []);
      const existing = options.find(o => o.value === label);
      if (existing) return existing.id;
      const opt = { id: newId(), color: 'tag-color-1', value: label };
      options.push(opt);
      return opt.id;
    }
    case 'multi-select': {
      const list = Array.isArray(raw) ? raw : [raw];
      const options = (col.data.options ??= []);
      return list
        .filter(v => v !== null && v !== undefined && v !== '')
        .map(v => {
          const label = String(v).trim();
          const existing = options.find(o => o.value === label);
          if (existing) return existing.id;
          const opt = { id: newId(), color: 'tag-color-1', value: label };
          options.push(opt);
          return opt.id;
        });
    }
    default:
      return undefined;
  }
}

const ORIGIN = 'WorkspaceDatabasePort';

function toU8(bin: Uint8Array | Buffer): Uint8Array {
  return bin instanceof Uint8Array ? bin : new Uint8Array(bin);
}

function newId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 21);
}

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
