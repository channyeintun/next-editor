export function runtimeMetric(name: string, fields: Record<string, string | number | boolean> = {}): void {
  console.log(JSON.stringify({ type: "remote_runtime", name, timestamp: Date.now(), ...fields }));
}
