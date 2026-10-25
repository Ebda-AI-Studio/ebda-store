-- Cursor for the hourly sweep of integrator clients whose store no longer exists (so more than one page of stores gets checked).
CREATE TABLE sweep_state (
  name  TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
