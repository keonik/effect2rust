CREATE TABLE IF NOT EXISTS todos (
  id serial PRIMARY KEY,           -- serial/int4 on purpose: bigint comes back as a string from JS drivers
  title text NOT NULL,
  done boolean NOT NULL DEFAULT false
);
