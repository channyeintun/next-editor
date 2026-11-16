const order = [];
setTimeout(() => order.push("timeout0"), 0);
setImmediate(() => order.push("immediate"));
process.nextTick(() => order.push("tick1"));
Promise.resolve().then(() => order.push("promise1"));
process.nextTick(() => order.push("tick2"));
queueMicrotask(() => order.push("microtask"));
order.push("sync");
setTimeout(() => {
  console.log(order.filter((name) => name !== "timeout0" && name !== "immediate").join(","));
  console.log(order.includes("timeout0"), order.includes("immediate"));
  const timer = setTimeout(() => {}, 1000);
  console.log(
    typeof timer.ref,
    typeof timer.unref,
    typeof timer.hasRef,
    typeof timer[Symbol.toPrimitive](),
  );
  clearTimeout(timer);
  let count = 0;
  const interval = setInterval(() => {
    count += 1;
    if (count === 3) {
      clearInterval(interval);
      console.log("interval done", count);
    }
  }, 5);
}, 20);
process.on("exit", (code) => console.log("exit", code));
