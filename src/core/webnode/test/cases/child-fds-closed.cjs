// A descriptor above 2 that a child is not given stays closed in the child,
// as libuv leaves it: one the stdio list gives as 'ignore', one the list
// leaves out, and one a shell closed (`exec 3<&-`, `3>&-`) before it started
// the child. The child's use of it is EBADF (the shell's message and status
// 1). Only 0, 1 and 2 read and write /dev/null when ignored.
const { execSync, spawnSync } = require("child_process");
const fs = require("fs");

fs.writeFileSync("closed-fds.txt", "hi\n");
const fd = fs.openSync("closed-fds.txt", "r");
const show = (label, stdio) => {
  const result = spawnSync("sh", ["-c", "cat <&3; echo rc=$?"], {
    stdio: ["ignore", "pipe", "pipe", ...stdio],
    encoding: "utf8",
  });
  console.log(label, JSON.stringify(result.stdout), JSON.stringify(result.stderr), result.status);
};
show("fd 3 given", [fd]);
show("fd 3 ignored", ["ignore"]);
show("fd 3 left out", []);
// fd 0 ignored is /dev/null: cat reads nothing and succeeds.
const stdin = spawnSync("sh", ["-c", "cat; echo rc=$?"], {
  stdio: ["ignore", "pipe", "inherit"],
  encoding: "utf8",
});
console.log("fd 0 ignored", JSON.stringify(stdin.stdout));
fs.closeSync(fd);

/** `line` run by a shell, its errors in the output where they come. */
const shell = (line) => execSync(`{ ${line}; } 2>&1`, { encoding: "utf8" }).trim();
console.log(
  "closed by exec:",
  shell(`exec 3<closed-fds.txt; exec 3<&-; sh -c 'cat <&3; echo rc=$?'`),
);
console.log("closed by 3<&-:", shell(`sh -c 'cat <&3; echo rc=$?' 3<&-`));
console.log("closed by 3>&-:", shell(`sh -c 'echo x >&3; echo rc=$?' 3>&-`));
console.log(
  "a gap between open ones:",
  shell(`sh -c 'cat <&7; echo rc=$?' 3<closed-fds.txt 11<closed-fds.txt`),
);
console.log(
  "an open one still passes:",
  shell(`sh -c 'cat <&3; echo rc=$?' 3<closed-fds.txt 11<closed-fds.txt`),
);

fs.rmSync("closed-fds.txt", { force: true });
