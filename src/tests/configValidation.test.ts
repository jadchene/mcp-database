import test from "node:test";
import assert from "node:assert/strict";

import { ApplicationError } from "../core/errors.js";
import { validateDatabaseConfig } from "../config/configValidation.js";

test("config validation accepts a valid mysql entry", () => {
  const result = validateDatabaseConfig([
    {
      key: "main-mysql",
      type: "mysql",
      readonly: true,
      connection: {
        host: "127.0.0.1",
        databaseName: "app_db",
        user: "root",
        password: "secret"
      }
    }
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0]?.key, "main-mysql");
});

test("config validation rejects duplicate names", () => {
  assert.throws(
    () => {
      validateDatabaseConfig([
        {
          key: "dup",
          type: "mysql",
          readonly: true,
          connection: {
            host: "127.0.0.1",
            databaseName: "app_db",
            user: "root",
            password: "secret"
          }
        },
        {
          key: "dup",
          type: "redis",
          readonly: true,
          connection: {
            url: "redis://127.0.0.1:6379/0"
          }
        }
      ]);
    },
    (error: unknown) => error instanceof ApplicationError && error.code === "CONFIG_ERROR"
  );
});
