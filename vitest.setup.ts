import "@testing-library/jest-dom";

// jsdom does not implement Blob.prototype.arrayBuffer, which real browsers (our
// Chromium target) provide. Polyfill it via FileReader so code under test can
// read uploaded File/Blob bytes the same way it does in production.
if (typeof Blob !== "undefined" && typeof Blob.prototype.arrayBuffer !== "function") {
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}
