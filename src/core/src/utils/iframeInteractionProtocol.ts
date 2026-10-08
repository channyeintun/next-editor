/**
 * The `postMessage` type a preview frame's interaction-capture script sends to
 * the host page, and the type iframe cursor tracking listens for. The app's
 * script builder (src/utils/iframeInteractionCapture.ts) writes it into the
 * injected script, so both ends of the message share this one constant.
 */
export const IFRAME_INTERACTION_MESSAGE_TYPE = "IFRAME_INTERACTION";
