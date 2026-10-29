import { Logger } from '@nestjs/common';
import { z } from 'zod';

import { PermissionAccess } from '../../../core/permission';
import type { WorkspaceDatabasePort } from '../../../core/organize';
import { toolError } from './error';
import { defineTool } from './tool';
import type { CopilotChatOptions } from './types';

const logger = new Logger('DatabaseRowsTool');

/**
 * Fill an existing `affine:database` block.
 *
 * Scope: rows only. *Creating* a database block is out of reach for the copilot
 * tools — `doc_create`/`doc_update` route through the external `affine_doc_loader`
 * crate, which will not emit one — so the database has to exist first (the user
 * makes it with `/database`). What this adds is the migration step the user
 * otherwise has to do by hand: turning a table's rows into real database rows.
 */
export const buildAddDatabaseRowsHandler = (
  db: WorkspaceDatabasePort,
  ac: PermissionAccess
) => {
  return async (
    options: CopilotChatOptions,
    docId: string,
    databaseBlockId: string,
    rows: Record<string, unknown>[]
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError('Database Rows Failed', 'Missing user or workspace context');
    }
    if (!rows.length) {
      return toolError('Database Rows Failed', 'No rows supplied');
    }

    await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(docId)
      .assert('Doc.Update');

    try {
      const { added, skipped } = await db.addRows(
        options.workspace,
        docId,
        databaseBlockId,
        rows,
        options.user
      );
      return {
        success: true,
        added,
        skippedColumns: skipped,
        message:
          `Added ${added} row(s) to database ${databaseBlockId}.` +
          (skipped.length
            ? ` Unmatched columns: ${skipped.join(', ')} — check they exist on the database.`
            : ''),
      };
    } catch (err: any) {
      // Surface the real cause. A bare "failed" here is what made doc_update
      // undiagnosable before.
      return toolError(
        'Database Rows Failed',
        `${err?.message ?? String(err)} (doc: ${docId}, block: ${databaseBlockId})`
      );
    }
  };
};

export const createAddDatabaseRowsTool = (
  addRows: (
    docId: string,
    databaseBlockId: string,
    rows: Record<string, unknown>[]
  ) => Promise<object>
) => {
  return defineTool({
    description:
      'Append rows to an EXISTING database block in a document. Keys of each row are column names (matched case-insensitively); values are the cell contents — text for text columns, numbers for number columns, and a display label for select/multi-select columns (the option is created if it does not exist yet). The row title goes in the key "title". The database must already exist; use doc_read to find its block id first.',
    inputSchema: z.object({
      doc_id: z.string().min(1).describe('The document holding the database'),
      database_block_id: z
        .string()
        .min(1)
        .describe('The affine:database block id inside that document'),
      rows: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .describe('Rows to append, each keyed by column name'),
    }),
    execute: async ({ doc_id, database_block_id, rows }) =>
      addRows(doc_id, database_block_id, rows),
  });
};
