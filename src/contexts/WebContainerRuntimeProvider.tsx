// Every lesson type is served by its own dev server inside the WebContainer, so
// the runtime provider is used unconditionally. (Previously html-css lessons fell
// back to a no-op static provider and rendered a `srcdoc` preview instead.)
export { WebContainerRuntimeProvider } from "./WebContainerRuntimeProviderImpl";
