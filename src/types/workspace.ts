// The workspace recording model (files, project, snapshot, equality and width
// deltas) is defined once, in core, because the recording stores it. App code
// imports it from here. The lesson catalogue lives in ./lessonTypes, path
// helpers in ./workspacePaths, file kinds in ./workspaceFiles, and the base64
// codec in src/shared/base64.
export * from "../core/src/workspace";
