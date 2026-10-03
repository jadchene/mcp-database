import test from "node:test";
import assert from "node:assert/strict";

import { ApplicationError } from "../core/errors.js";
import { validateDatabaseConfig } from "../config/configValidation.js";

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
  assert.equal(result.databases.length, 1);
  assert.equal(result.databases[0]?.key, "main-mysql");
  assert.equal(result.databases[0]?.codexAutoReview, false);
});

test("Codex auto review requires per-database boolean opt-in for every database type", () => {
  const targets = [
    { type: "mysql", connection: { host: "localhost", databaseName: "db", user: "test", password: "" } },
    { type: "postgresql", connection: { host: "localhost", databaseName: "db", user: "test", password: "" } },
    { type: "opengauss", connection: { host: "localhost", databaseName: "db", user: "test", password: "" } },
    { type: "oracle", connection: { host: "localhost", serviceName: "db", user: "test", password: "" } },
    { type: "redis", connection: { host: "localhost" } }
  ];
  for (const target of targets) {
    const config = validateDatabaseConfig({ databases: [
      { ...target, key: "enabled", readonly: false, codexAutoReview: true },
      { ...target, key: "disabled", readonly: false, codexAutoReview: false },
      { ...target, key: "default", readonly: false }
    ] });
    assert.deepEqual(config.databases.map(item => item.codexAutoReview), [true, false, false]);
    for (const codexAutoReview of ["true", 1, null]) {
      assert.throws(() => validateDatabaseConfig({ databases: [{ ...target, key: "invalid", readonly: false, codexAutoReview }] }),
        (error: unknown) => error instanceof ApplicationError && error.code === "CONFIG_ERROR");
    }
  }
});

test("danger mode defaults to false and requires per-target boolean opt-in for every database type", () => {
  const targets = [
    { type: "mysql", connection: { host: "localhost", databaseName: "db", user: "test", password: "" } },
    { type: "postgresql", connection: { host: "localhost", databaseName: "db", user: "test", password: "" } },
    { type: "opengauss", connection: { host: "localhost", databaseName: "db", user: "test", password: "" } },
    { type: "oracle", connection: { host: "localhost", serviceName: "db", user: "test", password: "" } },
    { type: "redis", connection: { host: "localhost" } }
  ];
  for (const target of targets) {
    const config = validateDatabaseConfig({ databases: [
      { ...target, key: "enabled", readonly: true, dangerMode: true },
      { ...target, key: "disabled", readonly: true, dangerMode: false },
      { ...target, key: "default", readonly: true }
    ] });
    assert.deepEqual(config.databases.map(item => item.dangerMode), [true, false, false]);
    for (const dangerMode of ["true", 1, null]) {
      assert.throws(() => validateDatabaseConfig({ databases: [{ ...target, key: "invalid", readonly: true, dangerMode }] }),
        (error: unknown) => error instanceof ApplicationError && error.code === "CONFIG_ERROR");
    }
  }
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
});

test("config validation rejects ports and timers outside runtime limits", () => {
  assert.throws(() => validateDatabaseConfig({
    query: { timeoutMs: 2_147_483_648 },
    databases: [{
      key: "invalid",
      type: "mysql",
      readonly: true,
      connection: {
        host: "127.0.0.1",
        port: 65_536,
        databaseName: "app_db",
        user: "root",
        password: "secret"
      }
    }]
  }), (error: unknown) => error instanceof ApplicationError && error.code === "CONFIG_ERROR");
});

test("config validation rejects unknown nested fields", () => {
  assert.throws(() => validateDatabaseConfig({
    databases: [{
      key: "invalid",
      type: "mysql",
      readonly: true,
      connection: {
        host: "127.0.0.1",
        databaseName: "app_db",
        user: "root",
        password: "secret",
        typoedOption: true
      }
    }]
  }), (error: unknown) => error instanceof ApplicationError && error.code === "CONFIG_ERROR");
});
