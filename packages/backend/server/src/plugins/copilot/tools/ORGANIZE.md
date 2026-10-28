# Copilot organisation tools (folders)

Adds `folder_create`, `folder_list`, `doc_to_folder` to the AI tool set.

## Motivation

The copilot tool set is **doc-scoped**. It can create, read, rename and edit
documents, but it cannot organise them — so every AI-created doc has to be filed
by hand, and databases are out of reach entirely. The model is aware of the gap
and tells users to work around it:

> *"To make this a true Kanban: create a database block (type / → database),
> pick the Kanban view, and copy the rows over"*

`Workspace.Organize` already exists in the permission model but is exposed
`Read`-only, which is precisely the shape of the hole.

## What this PR contains

| File | Change |
|---|---|
| `plugins/copilot/tools/organize.ts` | **new** — 3 tools + handlers + `FolderPort` seam |
| `plugins/copilot/tools/index.ts` | re-export `./organize` |
| `core/permission/types.ts` | `Workspace.Organize.{Create,Update,Delete}` |

Everything here compiles and is unit-shaped like its neighbours
(`doc-write.ts`): `build*Handler(deps)` returns an options-bound closure,
`create*Tool(handler)` wraps it in `defineTool`, failures return `toolError(...)`
so the turn recovers instead of aborting.

## `FolderPort` is bound (option 1)

Implemented in `packages/backend/server/src/core/organize/workspace-folder-port.ts`
as `WorkspaceFolderPort`, writing straight into the `folders` table's CRDT doc.

It reproduces `@toeverything/infra`'s `YjsTableAdapter` encoding rather than
depending on it (the backend does not depend on `@toeverything/infra`):

    Doc
      RowKey(string): YMap({ FieldA: primitive, ... })

Each ORM table is its own YDoc whose guid is the table name, so the `folders`
table lives in workspace doc **`db$folders`**. A row is a YMap named by its
`id`, fields are plain primitives — which is why the frontend's
`dbService.db.folders.create({...})` and this writer agree without sharing
code.

Row shape is `modules/db/schema/schema.ts`'s:

    folders: { id, parentId?, data, type, index }

`type` is `'folder'` (data = display name) or `'doc' | 'tag' | 'collection'`
(data = the linked node id). Placing a doc in a folder is creating a
`type: 'doc'` row with `parentId` = the folder — the same as
`FolderStore.createLink` client-side.

Writes go through `PgWorkspaceDocStorageAdapter.pushDocUpdates`, pushing only
the delta (`encodeStateAsUpdate(after, encodeStateVector(before))`), exactly
like `DocWriter.updateDoc` does for markdown. Row ids are UUID-derived; ordering
uses `generateFractionalIndexingKeyBetween`, copied from
`packages/common/infra/src/utils/fractional-indexing.ts` and backed by the
`fractional-indexing` dep added to `packages/backend/server/package.json`, so
keys stay byte-compatible with the frontend's sort order.

`OrganizeModule` (`core/organize/index.ts`) provides it and is added to
`COPILOT_SHARED_IMPORTS`, so `ToolRuntime` injects `WorkspaceFolderPort`
alongside `DocWriter`.

## Registration

In `plugins/copilot/runtime/tool-runtime.ts`, alongside the `docCreate` case:

```ts
case 'folderCreate': {
  const createFolder = buildFolderCreateHandler(this.folders, this.ac);
  tools.folder_create = createFolderCreateTool(createFolder.bind(null, options));
  break;
}
case 'folderList': {
  const listFolders = buildFolderListHandler(this.folders, this.ac);
  tools.folder_list = createFolderListTool(listFolders.bind(null, options));
  break;
}
case 'docToFolder': {
  const placeDoc = buildDocToFolderHandler(this.folders, this.ac);
  tools.doc_to_folder = createDocToFolderTool(placeDoc.bind(null, options));
  break;
}
```

Two things to decide there:

- **The dev/canary gate.** The same function skips write tools on stable:

  ```ts
  if (!(env.dev || env.namespaces.canary) &&
      ['docCreate','docUpdate','docUpdateMeta'].includes(tool)) continue;
  ```

  Decide whether the folder tools join that list. They probably should not —
  organising is not a write to user prose.

- **Per-preset opt-in.** Tools are enabled per prompt preset via a `tools: [...]`
  array in `packages/backend/native/src/llm/assets/prompts/built-in.json`.
  Registering a case is not enough; the presets that should organise need
  `folderCreate`, `folderList`, `docToFolder` appended.

## Databases

Out of scope. A database is an `affine:database` *block inside a document*, so
the right fix is teaching `doc_compose` / `section_edit` to emit one rather than
adding a separate `create_database` tool. Separate change.

## Permission note

`core/permission/types.ts` says *"Action names for Node callers; Rust owns
permission decisions."* The three new actions need matching exposure on the
Rust side or `assert()` will refuse them. Flagged here so it is not discovered
at runtime.
