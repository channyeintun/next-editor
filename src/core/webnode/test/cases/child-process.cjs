const { execSync, spawnSync, spawn, exec } = require("child_process");
console.log(execSync("echo from-shell").toString().trim());
console.log(execSync('node -e "console.log(6*7)"', { encoding: "utf8" }).trim());
const result = spawnSync("node", [
  "-e",
  "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)",
]);
console.log(result.status, result.stdout.toString(), result.stderr.toString());
console.log(spawnSync("definitely-not-a-command").error.code);
try {
  execSync("exit 2", { stdio: "pipe" });
} catch (error) {
  console.log("status", error.status);
}
const child = spawn("node", [
  "-e",
  "process.stdin.on('data', d => process.stdout.write(String(d).toUpperCase())); process.stdin.on('end', () => console.log('bye'))",
]);
let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.on("close", (code, signal) => {
  console.log(JSON.stringify(output), code, signal);
  exec("echo a && echo b 1>&2", (error, stdout, stderr) => {
    console.log(error, JSON.stringify(stdout), JSON.stringify(stderr));
    const sleeper = spawn("node", ["-e", "setTimeout(() => {}, 10000)"]);
    sleeper.on("exit", (code, signal) => console.log("killed", code, signal));
    setTimeout(() => sleeper.kill(), 300);
  });
});
child.stdin.write("hello ");
child.stdin.end("world\n");
