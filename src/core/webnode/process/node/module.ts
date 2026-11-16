// The `module` builtin: the `Module` class from the loader, which is also the
// object `require("module")` returns.
import { Module } from "../loader/modules";

export const createRequire = Module.createRequire;
export const builtinModules = Module.builtinModules;
export const isBuiltin = Module.isBuiltin;

export default Module;
