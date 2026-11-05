require("dotenv").config();
const app = require("./app");

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Failing to bind is fatal: without this the catch-all below swallows it and
// the process exits 0, so a supervisor sees a healthy start that serves nothing.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Stop the other process first.`,
    );
  } else {
    console.error("Server failed to start:", err);
  }
  process.exit(1);
});

module.exports = app;

// A rejected promise usually means one request failed, and Express has already
// answered it, so log and stay up.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

// An uncaught exception leaves the process in an unknown state, so serving on is
// worse than dying: exit and let the supervisor restart from a clean slate.
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception, shutting down:", err);
  process.exit(1);
});
