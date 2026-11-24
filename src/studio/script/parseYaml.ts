import YAML from "yaml";
import { parseLessonScript, type LessonScript } from "./schema";

/**
 * Parse and validate LessonScript YAML text. Every reader of a script goes
 * through here: the studio's registry and its Import, the publisher that
 * builds the lesson index, and the dev server that stands in for it. One
 * parser means a script the publisher accepts is one the studio can read.
 */
export function parseLessonScriptYaml(yamlText: string): LessonScript {
  return parseLessonScript(YAML.parse(yamlText));
}
