import { collectWorkspaceFolders, type WorkspaceProject } from "../types/workspace";
import { createWorkspaceFile } from "./shared";

/**
 * Pure Go lesson starter: multiple editable `.go` files that run together
 * through the Go Playground proxy on an explicit Run action. No package.json,
 * dev server, or WebContainer boot — the workspace stays local until Run.
 */
export function createStarterGoWorkspace(): WorkspaceProject {
  const files = {
    "main.go": createWorkspaceFile(
      "main.go",
      `package main

import "fmt"

func main() {
	fmt.Println("Hello, Go lessons!")

	for i := 1; i <= 5; i++ {
		fmt.Printf("%d squared is %d\\n", i, square(i))
	}
}
`,
    ),
    "square.go": createWorkspaceFile(
      "square.go",
      `package main

func square(value int) int {
	return value * value
}
`,
    ),
  };

  return {
    id: "go-workspace",
    name: "Go Lesson",
    lessonType: "go",
    entryFilePath: "main.go",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}
