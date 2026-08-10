import test from "node:test";
import assert from "node:assert/strict";

import { ApplicationError } from "../core/errors.js";
import { validateDatabaseConfig } from "../config/configValidation.js";
import { summarizeLoadedConfig } from "../config/configSummary.js";

test("config validation accepts a valid mysql entry", () => {
  const result = validateDatabaseConfig({
    logging: {
      enabled: false
    },
    query: {
      timeoutMs: 5000
    },
    databases: [
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
    ]
  });

  assert.equal(result.logging.enabled, false);
  assert.equal(result.query.timeoutMs, 5000);
  assert.equal(result.confirmation.requireUserToken, false);
  assert.equal(result.confirmation.password, undefined);
  assert.equal(result.databases.length, 1);
  assert.equal(result.databases[0]?.key, "main-mysql");
});

test("config validation rejects duplicate names", () => {
  assert.throws(
    () => {
      validateDatabaseConfig({
        logging: {
          enabled: false
        },
        query: {
          timeoutMs: 5000
        },
        databases: [
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
        ]
      });
    },
    (error: unknown) => error instanceof ApplicationError && error.code === "CONFIG_ERROR"
  );
});

test("config validation defaults logging to disabled when omitted", () => {
  const result = validateDatabaseConfig({
    databases: [
      {
        key: "redis-main",
        type: "redis",
        readonly: true,
        connection: {
          url: "redis://127.0.0.1:6379/0"
        }
      }
    ]
  });

  assert.equal(result.logging.enabled, false);
  assert.equal(result.query.timeoutMs, undefined);
  assert.equal(result.confirmation.requireUserToken, false);
});

test("config validation requires a password when user-token confirmation is enabled", () => {
  assert.throws(
    () => validateDatabaseConfig({
      confirmation: {
        requireUserToken: true
      },
      databases: [
        {
          key: "main-mysql",
          type: "mysql",
          readonly: false,
          connection: {
            host: "127.0.0.1",
            databaseName: "app_db",
            user: "root",
            password: "secret"
          }
        }
      ]
    }),
    (error: unknown) => error instanceof ApplicationError && error.code === "CONFIG_ERROR"
  );

  const result = validateDatabaseConfig({
    confirmation: {
      requireUserToken: true,
      password: "private-confirmation-password"
    },
    databases: [
      {
        key: "main-mysql",
        type: "mysql",
        readonly: false,
        connection: {
          host: "127.0.0.1",
          databaseName: "app_db",
          user: "root",
          password: "secret"
        }
      }
    ]
  });

  assert.equal(result.confirmation.requireUserToken, true);
  assert.equal(result.confirmation.password, "private-confirmation-password");

  const summary = summarizeLoadedConfig({
    configPath: "C:\\config\\databases.json",
    loadedAt: new Date(0).toISOString(),
    databases: result.databases,
    databaseMap: new Map(result.databases.map((database) => [database.key, database])),
    logging: {
      enabled: result.logging.enabled,
      directory: "C:\\logs"
    },
    query: {
      timeoutMs: result.query.timeoutMs ?? null
    },
    confirmation: result.confirmation
  });
  assert.equal(JSON.stringify(summary).includes("private-confirmation-password"), false);
  assert.deepEqual(summary.confirmation, { requireUserToken: true });
});
