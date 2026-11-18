// A SIGINT sent to npm alone (child.kill, not a terminal's Ctrl+C) reaches
// the script's program: npm passes it on to the `sh -c <script>` it started,
// which is the program itself once the shell has exec'd it. A program that
// does not listen dies of it, and npm with it; one that listens decides. The
// script shares its parent's standard input, as under `stdio: "inherit"`.
const { spawn } = require("child_process");
const fs = require("fs");

const node = (code) => `node -e "${code}"`;
fs.writeFileSync(
  "package.json",
  JSON.stringify({
    name: "case",
    version: "1.0.0",
    scripts: {
      sleep: node("console.log('ready'); setInterval(() => {}, 1000)"),
      trap: node(
        "process.on('SIGINT', () => { console.log('caught'); process.exit(7); }); console.log('ready'); setInterval(() => {}, 1000)",
      ),
    },
  }),
);

function interrupt(script) {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", script], { stdio: ["inherit", "pipe", "inherit"] });
    let output = "";
    let sent = false;
    // A program the signal never reached would run for ever.
    const limit = setTimeout(() => {
      console.log("the signal did not end it");
      child.kill("SIGKILL");
    }, 6000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (!sent && output.includes("ready")) {
        sent = true;
        setTimeout(() => child.kill("SIGINT"), 300);
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(limit);
      console.log(
        `npm run ${script}:`,
        output.includes("caught") ? "caught," : "",
        "exit",
        code,
        signal,
      );
      resolve();
    });
  });
}

interrupt("sleep").then(() => interrupt("trap"));
