import { Logger } from '@nestjs/common';
import { z } from 'zod';

import { PermissionAccess } from '../../../core/permission';
import { toolError } from './error';
import { defineTool } from './tool';
import type { CopilotChatOptions } from './types';

const logger = new Logger('OrganizeTool');

const sanitizeName = (name: string) => name.replace(/[\r\n]+/g, ' ').trim();

/**
 * Workspace organisation: folders and doc placement.
 *
 * The copilot tool set is doc-scoped today — it creates, reads and edits
 * documents but cannot organise them, so every AI-created doc has to be filed
 * by hand. `Workspace.Organize` already exists in the permission model but is
 * exposed `Read`-only, which is exactly the shape of the gap.
 *
 * Follows `doc-write.ts`: `build*Handler` returns an options-bound closure,
 * `create*Tool` wraps it in `defineTool`. Failures return `toolError(...)` so
 * the model can recover rather than the turn aborting.
 */
export interface FolderPort {
  createFolder(
    workspaceId: string,
    name: string
  ): Promise<{ folderId: string }>;
  listFolders(workspaceId: string): Promise<
    { folderId: string; name: string; docIds: string[] }[]
  >;
  addDocToFolder(
    workspaceId: string,
    folderId: string,
    docId: string
  ): Promise<void>;
  removeDocFromFolder(
    workspaceId: string,
    folderId: string,
    docId: string
  ): Promise<void>;
}

export const buildFolderCreateHandler = (
  folders: FolderPort,
  ac: PermissionAccess
) => {
  return async (options: CopilotChatOptions, name: string) => {
    if (!options?.user || !options.workspace) {
      return toolError('Folder Create Failed', 'Missing user or workspace context');
    }

    const sanitized = sanitizeName(name);
    if (!sanitized) {
      return toolError('Folder Create Failed', 'Folder name cannot be empty');
    }

    await ac
      .user(options.user)
      .workspace(options.workspace)
      .assert('Workspace.Organize.Create');

    const { folderId } = await folders.createFolder(
      options.workspace,
      sanitized
    );
    logger.log(`folder created: ${folderId} (${sanitized})`);

    return {
      success: true,
      folderId,
      message: `Folder "${sanitized}" created successfully`,
    };
  };
};

export const buildFolderListHandler = (
  folders: FolderPort,
  ac: PermissionAccess
) => {
  return async (options: CopilotChatOptions) => {
    if (!options?.user || !options.workspace) {
      return toolError('Folder List Failed', 'Missing user or workspace context');
    }

    await ac
      .user(options.user)
      .workspace(options.workspace)
      .assert('Workspace.Organize.Read');

    const items = await folders.listFolders(options.workspace);
    return {
      success: true,
      folders: items.map(f => ({
        folderId: f.folderId,
        name: f.name,
        docCount: f.docIds.length,
      })),
    };
  };
};

export const buildDocToFolderHandler = (
  folders: FolderPort,
  ac: PermissionAccess
) => {
  return async (
    options: CopilotChatOptions,
    docId: string,
    folderId: string,
    remove = false
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError('Organize Failed', 'Missing user or workspace context');
    }

    await ac
      .user(options.user)
      .workspace(options.workspace)
      .assert('Workspace.Organize.Update');

    if (remove) {
      await folders.removeDocFromFolder(options.workspace, folderId, docId);
    } else {
      await folders.addDocToFolder(options.workspace, folderId, docId);
    }

    return {
      success: true,
      message: `Doc ${docId} ${remove ? 'removed from' : 'added to'} folder ${folderId}`,
    };
  };
};

// ── tool definitions ────────────────────────────────────────────────────────

export const createFolderCreateTool = (
  createFolder: (name: string) => Promise<object>
) => {
  return defineTool({
    description:
      'Create a folder in the workspace sidebar. Use it when the user asks you to file, group or categorise documents.',
    inputSchema: z.object({
      name: z.string().min(1).describe('The folder display name'),
    }),
    execute: async ({ name }) => createFolder(name),
  });
};

export const createFolderListTool = (
  listFolders: () => Promise<object>
) => {
  return defineTool({
    description:
      'List this workspace\'s folders with their doc counts. Call it before moving docs so you can reference a real folderId.',
    inputSchema: z.object({}),
    execute: async () => listFolders(),
  });
};

export const createDocToFolderTool = (
  placeDoc: (docId: string, folderId: string, remove: boolean) => Promise<object>
) => {
  return defineTool({
    description:
      'Add a document to a folder, or remove it from one. Use folder_list first to discover valid folderIds. This only changes organisation; it never edits document content.',
    inputSchema: z.object({
      doc_id: z.string().min(1).describe('The ID of the document to place'),
      folder_id: z.string().min(1).describe('The ID of the target folder'),
      remove: z
        .boolean()
        .optional()
        .describe('Set true to remove the doc from the folder instead'),
    }),
    execute: async ({ doc_id, folder_id, remove }) =>
      placeDoc(doc_id, folder_id, remove ?? false),
  });
};
