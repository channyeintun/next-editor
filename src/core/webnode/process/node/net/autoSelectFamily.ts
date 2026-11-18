// The process-wide defaults of Node's autoSelectFamily (Happy Eyeballs):
// whether a connect by name tries each address the lookup gives on its own
// attempt, and how long each attempt has. `net.setDefaultAutoSelectFamily`
// sets them; a socket reads them when a connect does not say.
import { validateBoolean, validateInteger } from "../internalErrors";

let autoSelectFamilyDefault = true;
let autoSelectFamilyAttemptTimeoutDefault = 250;

/** `net.getDefaultAutoSelectFamily()`. */
export function getDefaultAutoSelectFamily(): boolean {
  return autoSelectFamilyDefault;
}

/** `net.setDefaultAutoSelectFamily(value)`. */
export function setDefaultAutoSelectFamily(value: boolean): void {
  validateBoolean(value, "value");
  autoSelectFamilyDefault = value;
}

/** `net.getDefaultAutoSelectFamilyAttemptTimeout()`. */
export function getDefaultAutoSelectFamilyAttemptTimeout(): number {
  return autoSelectFamilyAttemptTimeoutDefault;
}

/** `net.setDefaultAutoSelectFamilyAttemptTimeout(value)`: at least 10 ms. */
export function setDefaultAutoSelectFamilyAttemptTimeout(value: number): void {
  validateInteger(value, "value", 1, 2 ** 31 - 1);
  autoSelectFamilyAttemptTimeoutDefault = value < 10 ? 10 : value;
}
