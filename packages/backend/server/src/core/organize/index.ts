import { Module } from '@nestjs/common';

import { DocStorageModule, PgWorkspaceDocStorageAdapter } from '../doc';
import { WorkspaceFolderPort } from './workspace-folder-port';

/**
 * Workspace organisation (folders).
 *
 * Deliberately separate from `DocStorageModule`: it adds an opinionated write
 * surface over the `folders` table's CRDT doc rather than general document
 * storage. Consumed by the copilot tools so the AI can file the docs it
 * creates instead of handing that back to the user.
 */
@Module({
  imports: [DocStorageModule],
  providers: [
    {
      provide: WorkspaceFolderPort,
      useFactory: (storage: PgWorkspaceDocStorageAdapter) =>
        new WorkspaceFolderPort(storage),
      inject: [PgWorkspaceDocStorageAdapter],
    },
  ],
  exports: [WorkspaceFolderPort],
})
export class OrganizeModule {}

export { WorkspaceFolderPort } from './workspace-folder-port';
export type { WorkspaceDocStorage } from './workspace-folder-port';
