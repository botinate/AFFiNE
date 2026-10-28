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

## The one remaining step: bind `FolderPort`

`FolderPort` is left as an explicit 4-method seam because **the backend has no
folder service to bind to**. Verified against this tree:

- `grep -rn folder packages/backend/server/src/` → nothing but this PR
- `Workspace.Organize` is referenced nowhere except `permission/types.ts`
- Folders are a **client-side typed CRDT table**:
  `packages/frontend/core/src/modules/organize/stores/folder.ts` writes
  `dbService.db.folders.create({ parentId, type, data, index })`
- `DocWriter` (`core/doc/writer.ts`) only does `createDoc` / `updateDoc` /
  `updateDocMeta` — it targets document markdown, not the `db$folders` schema
  in `packages/frontend/core/src/modules/db/schema/schema.ts`

So binding `FolderPort` is one of two things, and it is a design decision more
than a patch:

1. **Backend mutate of `db$folders`.** The write path exists —
   `DocWriter.updateDoc` ends in
   `storage.pushDocUpdates(workspaceId, docId, [delta], editorId)` on
   `PgWorkspaceDocStorageAdapter`. What's missing is a server-side encoder for
   the `modules/db` row format so a folder row can be expressed as that delta.
   Porting that codec is the bulk of the work.

2. **Delegated write to a live client.** `DelegatedEditorService` already drives
   the focused editor, but its tools are read-only
   (`frontend_get_editor_state`, `frontend_read_selection`,
   `frontend_read_nodes`, `frontend_snapshot_document`). Extending it with a
   write verb would let the server ask the open client to call
   `organizeService.folderTree…createFolder(...)`. Smaller, but requires an
   attached client and fails headlessly.

(1) is the more useful end state; (2) is the smaller diff. I did not pick
silently — that choice belongs to whoever owns `modules/db`.

## Integration once `FolderPort` binds

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
